import { DateTime, type DurationLike } from "luxon";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { inTransaction } from "../../src/db/transaction.ts";
import type { ChatClient } from "../../src/ports.ts";
import { turnBackoffDelaySec } from "../../src/time.ts";
import type { HarnessContext } from "../../src/worker/context.ts";
import { formatLocalTime } from "../../src/worker/reservation-times.ts";
import type { PlanTask, TurnTask } from "../../src/worker/tasks.ts";
import type { ToolResult } from "../../src/worker/tools/tool-box.ts";

export type TurnScript = (turn: ScriptedTurn) => FinalAnswer | Promise<FinalAnswer>;
export type CleanupScript = (cleanup: ScriptedCleanup) => unknown;
export type PlanScript = (plan: FakePlan) => unknown;

/** 각본 모델이 대화를 시작할 때마다 남기는 기록. 모델이 입력에서 읽은 것만 담는다. */
export type ScriptedTask =
  | { kind: "turn"; trigger: TurnTask["trigger"]; reservationId?: number }
  | { kind: "cleanup" }
  | { kind: "plan" };

export interface LoggedTask {
  task: ScriptedTask;
  startedAt: DateTime;
  isReconsider?: boolean;
}

/** 각본이 낸 최종 답. 형식이 틀린 답이면 파싱 재시도에 낼 답(`retry`)도 함께 든다. */
export interface FinalAnswer {
  content: string;
  retry?: FinalAnswer;
}

export interface ToolCall {
  name: string;
  /** 객체면 JSON으로 바꿔 보낸다. 문자열이면 그대로 보낸다(JSON이 아닌 인자를 흉내 낼 때). */
  args: unknown;
}

const RUNAWAY_LIMIT = 300;

/**
 * LLM 자리에 들어가는 각본 모델. 하네스의 실제 실행기가 보내는 요청을 받아 각본대로 completion을 낸다.
 * 각본이 도구를 부르면 tool_calls 답을 내고, 하네스가 실행한 결과가 다음 요청으로 오면 각본을 잇는다.
 * 무슨 작업인지는 실제 모델처럼 요청에서 읽는다(도구 목록과 이벤트 절의 `계기:` 줄).
 * 계획만 아직 실행기를 거치지 않아 결과를 가짜가 직접 쓴다.
 */
export class ScriptedLlm implements ChatClient {
  readonly log: LoggedTask[] = [];
  readonly requests: ChatCompletionCreateParamsNonStreaming[] = [];
  /** 각본 안에서 난 뜻밖의 오류와 끝없는 반복. 테스트를 마칠 때 실패로 보고한다. */
  readonly problems: string[] = [];
  readonly #turnScripts: TurnScript[] = [];
  readonly #reconsiderScripts: TurnScript[] = [];
  readonly #cleanupScripts: CleanupScript[] = [];
  readonly #planScripts: PlanScript[] = [];
  #ctx: HarnessContext | undefined;
  #conversation: ScriptedConversation | undefined;

  onTurn(...scripts: TurnScript[]): this {
    this.#turnScripts.push(...scripts);
    return this;
  }

  /** 되묻기에 쓰는 각본. 없으면 첫 답을 그대로 다시 낸다(또 빠뜨림). */
  onReconsider(...scripts: TurnScript[]): this {
    this.#reconsiderScripts.push(...scripts);
    return this;
  }

  onCleanup(...scripts: CleanupScript[]): this {
    this.#cleanupScripts.push(...scripts);
    return this;
  }

  onPlan(...scripts: PlanScript[]): this {
    this.#planScripts.push(...scripts);
    return this;
  }

  /** 각본의 시각 도우미가 쓸 앱. 재시작하면 새 앱을 붙인다. */
  attach(ctx: HarnessContext): void {
    this.#ctx = ctx;
  }

  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> {
    this.requests.push(structuredClone(params));
    if (this.problems.length > 0) return new Promise(() => {});
    if (!params.messages.some((message) => message.role === "assistant")) {
      this.#conversation = this.#startConversation(params);
    }
    if (this.#isRunaway()) return new Promise(() => {});
    return this.#conversation!.reply(params);
  }

  async runPlan(ctx: HarnessContext, _task: PlanTask): Promise<void> {
    this.#record(ctx, { kind: "plan" });
    if (this.#isRunaway()) throw new Error("LLM 작업이 끝없이 반복된다");
    await (this.#planScripts.shift() ?? ((plan) => plan.finishPlan()))(new FakePlan(ctx));
  }

  /** 마지막으로 시작한 `kind` 대화의 입력 문서(user 메시지). */
  lastInput(kind: "turn" | "cleanup"): string {
    const request = this.requests.findLast(
      (params) => kindOf(params) === kind && !params.messages.some((m) => m.role === "assistant"),
    );
    if (request === undefined) throw new Error(`${kind} 요청이 없다`);
    return documentOf(request);
  }

  #startConversation(params: ChatCompletionCreateParamsNonStreaming): ScriptedConversation {
    const ctx = this.#ctx!;
    const reportProblem = (problem: string) => this.problems.push(problem);
    if (kindOf(params) === "cleanup") {
      this.#record(ctx, { kind: "cleanup" });
      const script = this.#cleanupScripts.shift() ?? (() => {});
      return new ScriptedConversation(reportProblem, {
        start: async (conversation) => {
          await script(new ScriptedCleanup(conversation));
          return { content: "{}" };
        },
      });
    }

    const task = readTurnTask(documentOf(params));
    this.#record(ctx, task);
    const firstScript = this.#turnScripts.shift() ?? answerSilently;
    let firstAnswer: FinalAnswer | undefined;
    return new ScriptedConversation(reportProblem, {
      start: async (conversation) => {
        firstAnswer = await firstScript(new ScriptedTurn(ctx, task, conversation));
        return firstAnswer;
      },
      reconsider: async (conversation, feedback) => {
        this.#record(ctx, task, { isReconsider: true });
        const script = this.#reconsiderScripts.shift() ?? (() => firstAnswer!);
        return script(
          new ScriptedTurn(ctx, task, conversation, readGoalsWithoutNextCheck(feedback)),
        );
      },
    });
  }

  #record(ctx: HarnessContext, task: ScriptedTask, options: { isReconsider?: boolean } = {}): void {
    this.log.push({ task, startedAt: ctx.clock.now(), ...options });
  }

  #isRunaway(): boolean {
    if (this.log.length <= RUNAWAY_LIMIT) return false;
    if (this.problems.length === 0) this.problems.push("LLM 작업이 끝없이 반복된다");
    return true;
  }
}

function answerSilently(turn: ScriptedTurn): FinalAnswer {
  return turn.trigger === "continue" ? turn.silentEnd() : turn.silent();
}

interface ConversationScripts {
  start(conversation: ScriptedConversation): Promise<FinalAnswer>;
  reconsider?(conversation: ScriptedConversation, feedback: string): Promise<FinalAnswer>;
}

/**
 * 각본 하나를 요청 여러 개에 걸쳐 돌린다. 각본이 도구를 부르면 그 요청의 답으로 tool_calls를 내고 멈췄다가,
 * 실행 결과를 담은 다음 요청이 오면 결과를 돌려주며 잇는다.
 */
class ScriptedConversation {
  readonly #reportProblem: (problem: string) => void;
  readonly #scripts: ConversationScripts;
  #hasStarted = false;
  #isForced = false;
  #reply = Promise.withResolvers<ChatCompletion>();
  #toolResults: PromiseWithResolvers<ToolResult[]> | undefined;
  #lastAnswer: FinalAnswer | undefined;

  constructor(reportProblem: (problem: string) => void, scripts: ConversationScripts) {
    this.#reportProblem = reportProblem;
    this.#scripts = scripts;
  }

  reply(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> {
    this.#isForced = params.tool_choice === "none";
    this.#reply = Promise.withResolvers<ChatCompletion>();
    const lastMessage = params.messages.at(-1)!;

    if (lastMessage.role === "tool") {
      this.#toolResults?.resolve(readTrailingToolResults(params.messages));
    } else if (!this.#hasStarted) {
      this.#hasStarted = true;
      this.#answerWith(() => this.#scripts.start(this));
    } else if (this.#lastAnswer?.retry !== undefined) {
      this.#answerWith(async () => this.#lastAnswer!.retry!);
    } else if (this.#scripts.reconsider !== undefined) {
      const feedback = lastMessage.content as string;
      this.#answerWith(() => this.#scripts.reconsider!(this, feedback));
    } else {
      throw new Error(`각본 모델이 예상하지 못한 요청이다: ${JSON.stringify(lastMessage)}`);
    }
    return this.#reply.promise;
  }

  /** 강제 호출(`tool_choice: "none"`) 중이면 도구를 부르지 못하고 거부 결과를 바로 받는다. */
  async useTools(calls: ToolCall[]): Promise<ToolResult[]> {
    if (this.#isForced) return calls.map(() => ({ ok: false, reason: "도구를 쓸 수 없는 호출" }));
    this.#toolResults = Promise.withResolvers<ToolResult[]>();
    this.#reply.resolve(toolCallsCompletion(calls));
    return this.#toolResults.promise;
  }

  #answerWith(script: () => Promise<FinalAnswer>): void {
    script().then(
      (answer) => {
        this.#lastAnswer = answer;
        this.#reply.resolve(textCompletion(answer.content));
      },
      (error: unknown) => {
        if (!(error instanceof ScriptedApiError))
          this.#reportProblem(`각본 오류: ${String(error)}`);
        this.#reply.reject(error);
      },
    );
  }
}

/** 각본이 API 오류를 흉내 낼 때 던진다. 그 밖의 예외는 각본의 실수로 보고한다. */
class ScriptedApiError extends Error {}

export interface SpeechOptions {
  continueAfter?: DurationLike;
}

export class ScriptedTurn {
  readonly trigger: TurnTask["trigger"];
  readonly goalsWithoutNextCheck: { id: number; title: string }[];
  readonly #ctx: HarnessContext;
  readonly #conversation: ScriptedConversation;

  constructor(
    ctx: HarnessContext,
    task: Extract<ScriptedTask, { kind: "turn" }>,
    conversation: ScriptedConversation,
    goalsWithoutNextCheck: { id: number; title: string }[] = [],
  ) {
    this.#ctx = ctx;
    this.#conversation = conversation;
    this.trigger = task.trigger;
    this.goalsWithoutNextCheck = goalsWithoutNextCheck;
  }

  async use(name: string, args: unknown): Promise<ToolResult> {
    const [result] = await this.useAll([{ name, args }]);
    return result!;
  }

  /** 한 답에서 도구 여러 개를 함께 부른다. */
  useAll(calls: ToolCall[]): Promise<ToolResult[]> {
    return this.#conversation.useTools(calls);
  }

  /** 도구 인자 형식의 시각. `HH:mm`이면 지금의 로컬 날짜로 채운다. */
  time(localTime: string): string {
    const { timezone } = this.#ctx.config;
    return formatLocalTime(parseLocalTime(localTime, timezone, this.#ctx.clock.now()), timezone);
  }

  async createGoal(goal: { title: string; dueAt?: string; jobId?: string }): Promise<number> {
    const result = await this.#useOrThrow("goal_create", {
      job_id: goal.jobId ?? "sample",
      title: goal.title,
      done_criteria: `${goal.title} 끝`,
      due_at: goal.dueAt && this.time(goal.dueAt),
    });
    return result.goal_id as number;
  }

  async reserveOpening(opening: {
    at: string;
    intent?: string;
    goalIds?: number[];
  }): Promise<number> {
    const result = await this.#useOrThrow("open_reserve", {
      at: this.time(opening.at),
      intent: opening.intent ?? "개입",
      goal_ids: opening.goalIds ?? [],
    });
    return result.reservation_id as number;
  }

  say(say: string | string[], options: SpeechOptions = {}): FinalAnswer {
    const continueAt =
      options.continueAfter === undefined
        ? undefined
        : this.#ctx.clock.now().plus(options.continueAfter);
    return answer({
      messages: toMessages(say),
      next: "continue",
      continue_at: continueAt && this.#formatWithSeconds(continueAt),
    });
  }

  end(say: string | string[] = []): FinalAnswer {
    return answer({ messages: toMessages(say), next: "end" });
  }

  /** 말 없이 이어가기. 개시 턴이면 무시·개입 취소, 답장 턴이면 조용히 기다림이다. */
  silent(): FinalAnswer {
    return answer({ messages: [], next: "continue" });
  }

  silentEnd(): FinalAnswer {
    return this.end();
  }

  /** 형식이 틀린 답. 파싱 재시도에는 `onRetry`를 내고, 없으면 또 틀린다. */
  malformed(options: { onRetry?: FinalAnswer } = {}): FinalAnswer {
    return { content: "응 알았어", retry: options.onRetry ?? { content: "응 알았어" } };
  }

  apiError(): never {
    throw new ScriptedApiError("각본이 API 오류를 냈다");
  }

  /** 초가 0이 아니면 초까지 쓴다. 테스트가 디바운스 20초 뒤의 시각을 그대로 잴 수 있게. */
  #formatWithSeconds(time: DateTime): string {
    const local = time.setZone(this.#ctx.config.timezone);
    return local.toFormat(local.second === 0 ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd HH:mm:ss");
  }

  async #useOrThrow(name: string, args: unknown): Promise<Extract<ToolResult, { ok: true }>> {
    const result = await this.use(name, args);
    if (!result.ok) throw new Error(`각본의 ${name}가 거부됐다: ${result.reason}`);
    return result;
  }
}

function answer(output: Record<string, unknown>): FinalAnswer {
  return { content: JSON.stringify(output) };
}

function toMessages(say: string | string[]): string[] {
  return typeof say === "string" ? [say] : say;
}

export class ScriptedCleanup {
  readonly #conversation: ScriptedConversation;

  constructor(conversation: ScriptedConversation) {
    this.#conversation = conversation;
  }

  async use(name: string, args: unknown): Promise<ToolResult> {
    const [result] = await this.#conversation.useTools([{ name, args }]);
    return result!;
  }

  fail(): never {
    throw new ScriptedApiError("각본이 정리를 실패시켰다");
  }
}

/** 계획 결과를 DB에 직접 쓰는 가짜. 계획 단계에서 실제 계획 커밋으로 바꾼다. */
export class FakePlan {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  finishPlan(plan: { body?: string; openings?: { at: string; intent?: string }[] } = {}): void {
    const now = this.#ctx.clock.now();
    const planDate = this.#ctx.calendar.currentPlanDate(now);
    inTransaction(this.#ctx.db, () => {
      this.#ctx.plans.save(planDate, plan.body ?? "각본 계획", now);
      for (const opening of plan.openings ?? []) {
        this.#ctx.reservations.scheduleOpening({
          at: parseLocalTime(opening.at, this.#ctx.config.timezone, now),
          intent: opening.intent ?? "개입",
          planDate,
          source: "plan",
          goalIds: [],
          createdAt: now,
        });
      }
      this.#ctx.harnessState.markPlanned(planDate);
    });
  }

  failPlan(): void {
    const attempts = this.#ctx.harnessState.get().plan_attempts + 1;
    this.#ctx.harnessState.recordPlanAttempt(
      this.#ctx.clock.now().plus({ seconds: turnBackoffDelaySec(attempts, this.#ctx.config) }),
    );
  }
}

/** `HH:mm`이면 지금의 로컬 날짜, `yyyy-MM-dd HH:mm`이면 그 시각. */
export function parseLocalTime(text: string, timezone: string, now?: DateTime): DateTime {
  if (/^\d{2}:\d{2}$/.test(text)) {
    if (now === undefined) throw new Error(`${text}에는 날짜가 필요하다`);
    const [hour, minute] = text.split(":").map(Number);
    return now.setZone(timezone).set({ hour, minute, second: 0, millisecond: 0 }).toUTC();
  }
  return DateTime.fromFormat(text, "yyyy-MM-dd HH:mm", { zone: timezone }).toUTC();
}

/** 입력 문서에서 `## 제목` 절의 줄. 다음 절 앞의 빈 줄은 뺀다. */
export function inputSection(document: string, title: string): string[] {
  const lines = document.split("\n");
  const start = lines.indexOf(`## ${title}`);
  if (start === -1) throw new Error(`"${title}" 절이 없다`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line !== "");
}

function kindOf(params: ChatCompletionCreateParamsNonStreaming): "turn" | "cleanup" {
  const toolNames = (params.tools ?? []).map((tool) =>
    tool.type === "function" ? tool.function.name : "",
  );
  if (toolNames.includes("goal_create")) return "turn";
  if (toolNames.includes("state_write")) return "cleanup";
  throw new Error(`도구 목록으로 작업을 알 수 없다: ${toolNames.join(", ")}`);
}

function documentOf(params: ChatCompletionCreateParamsNonStreaming): string {
  const document = params.messages.find((message) => message.role === "user");
  return document?.content as string;
}

function readTurnTask(document: string): Extract<ScriptedTask, { kind: "turn" }> {
  const trigger = /^계기: (.*)$/m.exec(document)?.[1];
  const opening = trigger && /^AI 개시\(개시 예약 #(\d+)\)$/.exec(trigger);
  if (opening) return { kind: "turn", trigger: "open", reservationId: Number(opening[1]) };
  switch (trigger) {
    case "사용자 메시지(흐름 없음)":
      return { kind: "turn", trigger: "user" };
    case "사용자 답장":
      return { kind: "turn", trigger: "reply" };
    case "이어가기":
      return { kind: "turn", trigger: "continue" };
    default:
      throw new Error(`입력에서 계기를 읽을 수 없다: ${trigger}`);
  }
}

function readGoalsWithoutNextCheck(feedback: string): { id: number; title: string }[] {
  return [...feedback.matchAll(/^- #(\d+) (.+)$/gm)].map(([, id, title]) => ({
    id: Number(id),
    title: title!,
  }));
}

function readTrailingToolResults(messages: ChatCompletionMessageParam[]): ToolResult[] {
  const results: ToolResult[] = [];
  for (let index = messages.length - 1; messages[index]?.role === "tool"; index--) {
    results.unshift(JSON.parse(messages[index]!.content as string) as ToolResult);
  }
  return results;
}

function textCompletion(content: string): ChatCompletion {
  return completion({ role: "assistant", content, refusal: null }, "stop");
}

function toolCallsCompletion(calls: ToolCall[]): ChatCompletion {
  return completion(
    {
      role: "assistant",
      content: null,
      refusal: null,
      tool_calls: calls.map(({ name, args }, index) => ({
        id: `call_${index}`,
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      })),
    },
    "tool_calls",
  );
}

function completion(
  message: ChatCompletionMessage,
  finishReason: "stop" | "tool_calls",
): ChatCompletion {
  return {
    id: "scripted",
    object: "chat.completion",
    created: 0,
    model: "scripted",
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  };
}
