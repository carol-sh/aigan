import { DateTime, type DurationLike } from "luxon";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { ChatClient } from "../../src/ports.ts";
import type { HarnessContext } from "../../src/worker/context.ts";
import { formatLocalTime } from "../../src/worker/reservation-times.ts";
import type { TurnTask } from "../../src/worker/tasks.ts";
import type { ToolResult } from "../../src/worker/tools/tool-box.ts";

export type TurnScript = (turn: ScriptedTurn) => FinalAnswer | Promise<FinalAnswer>;
export type CleanupScript = (cleanup: ScriptedCleanup) => unknown;
export type PlanScript = (plan: ScriptedPlan) => FinalAnswer | Promise<FinalAnswer>;

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

/** 각본이 낸 최종 답. 파싱 재시도를 받으면 `retry`를 내고, 없으면 같은 답을 되풀이한다. */
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
    if (isConversationStart(params)) {
      this.#conversation = this.#startConversation(params);
    }
    if (this.#isRunaway()) return new Promise(() => {});
    return this.#conversation!.reply(params);
  }

  requestsOf(kind: LlmKind): ChatCompletionCreateParamsNonStreaming[] {
    return this.requests.filter((params) => kindOf(params) === kind);
  }

  /** `kind` 대화마다 처음 받은 입력 문서(user 메시지). 시작한 순서다. */
  inputs(kind: LlmKind): string[] {
    return this.requestsOf(kind).filter(isConversationStart).map(documentOf);
  }

  lastInput(kind: LlmKind): string {
    const input = this.inputs(kind).at(-1);
    if (input === undefined) throw new Error(`${kind} 요청이 없다`);
    return input;
  }

  #startConversation(params: ChatCompletionCreateParamsNonStreaming): ScriptedConversation {
    const ctx = this.#ctx!;
    const reportProblem = (problem: string) => this.problems.push(problem);
    if (kindOf(params) === "plan") {
      this.#record(ctx, { kind: "plan" });
      const script = this.#planScripts.shift() ?? ((plan: ScriptedPlan) => plan.finishPlan());
      return new ScriptedConversation(reportProblem, {
        start: (conversation) => Promise.resolve(script(new ScriptedPlan(ctx, conversation))),
      });
    }
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
    } else if (isRetryRequest(lastMessage)) {
      const lastAnswer = this.#lastAnswer!;
      this.#answerWith(async () => lastAnswer.retry ?? lastAnswer);
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
    return { content: "응 알았어", retry: options.onRetry };
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

export interface ScriptedOpening {
  /** `HH:mm`이면 지금의 로컬 날짜로 채운다. */
  at: string;
  intent?: string;
  goalIds?: number[];
}

export class ScriptedPlan {
  readonly #ctx: HarnessContext;
  readonly #conversation: ScriptedConversation;

  constructor(ctx: HarnessContext, conversation: ScriptedConversation) {
    this.#ctx = ctx;
    this.#conversation = conversation;
  }

  async use(name: string, args: unknown): Promise<ToolResult> {
    const [result] = await this.#conversation.useTools([{ name, args }]);
    return result!;
  }

  finishPlan(plan: { body?: string; openings?: ScriptedOpening[] } = {}): FinalAnswer {
    const { timezone } = this.#ctx.config;
    const now = this.#ctx.clock.now();
    return answer({
      body: plan.body ?? "각본 계획",
      openings: (plan.openings ?? []).map((opening) => ({
        at: formatLocalTime(parseLocalTime(opening.at, timezone, now), timezone),
        intent: opening.intent ?? "개입",
        goal_ids: opening.goalIds ?? [],
      })),
    });
  }

  failPlan(): never {
    throw new ScriptedApiError("각본이 계획을 실패시켰다");
  }

  /** 형식이 틀린 답. 파싱 재시도에는 `onRetry`를 내고, 없으면 또 틀린다. */
  malformed(options: { onRetry?: FinalAnswer } = {}): FinalAnswer {
    return { content: "오늘은 산책", retry: options.onRetry };
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

type LlmKind = "turn" | "cleanup" | "plan";

/** 턴만 `goal_create`를, 정리만 `state_write`를 받는다. 계획은 `memory_read` 하나뿐이다. */
function kindOf(params: ChatCompletionCreateParamsNonStreaming): LlmKind {
  const toolNames = (params.tools ?? []).map((tool) =>
    tool.type === "function" ? tool.function.name : "",
  );
  if (toolNames.includes("goal_create")) return "turn";
  if (toolNames.includes("state_write")) return "cleanup";
  if (toolNames.length === 1 && toolNames[0] === "memory_read") return "plan";
  throw new Error(`도구 목록으로 작업을 알 수 없다: ${toolNames.join(", ")}`);
}

function isConversationStart(params: ChatCompletionCreateParamsNonStreaming): boolean {
  return !params.messages.some((message) => message.role === "assistant");
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

/** 하네스가 읽지 못한 답을 고쳐 달라는 요청. 피드백 문구는 `LlmConversation`이 쓴다. */
function isRetryRequest(message: ChatCompletionMessageParam): boolean {
  return message.role === "user" && String(message.content).startsWith("출력이 형식에 맞지 않는다");
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
