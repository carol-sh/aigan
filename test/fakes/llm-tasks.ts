import { DateTime, type DurationLike } from "luxon";
import { inTransaction } from "../../src/db/transaction.ts";
import type { Deciders } from "../../src/worker/boot.ts";
import type { CleanupRequest } from "../../src/worker/cleanup.ts";
import type { HarnessContext } from "../../src/worker/context.ts";
import { formatLocalTime } from "../../src/worker/reservation-times.ts";
import type { LlmTask, PlanTask, TurnTask } from "../../src/worker/tasks.ts";
import type { ToolResult } from "../../src/worker/tools/tool-box.ts";
import type { WorkingGoal } from "../../src/worker/tools/turn-changes.ts";
import type { TurnOutput, TurnRequest } from "../../src/worker/turn.ts";
import { turnBackoffDelaySec } from "../../src/time.ts";

export type TurnScript = (turn: ScriptedTurn) => TurnOutput | Promise<TurnOutput>;
export type CleanupScript = (cleanup: ScriptedCleanup) => unknown;
export type PlanScript = (plan: FakePlan) => unknown;

export interface LoggedTask {
  task: LlmTask;
  startedAt: DateTime;
  isReconsider?: boolean;
}

const RUNAWAY_LIMIT = 300;

/**
 * LLM 자리에 들어가는 각본. 턴·정리 각본은 실제 도구를 부르고 출력을 낸다. 흐름 열기·닫기,
 * 도구 효과 반영, 기억 커밋은 실제 코드가 한다. 계획만 아직 커밋 결과를 가짜가 직접 쓴다.
 * 각본이 없으면 아무 말 없이 끝난 것처럼 처리한다.
 */
export class ScriptedLlm {
  readonly log: LoggedTask[] = [];
  readonly #turnScripts: TurnScript[] = [];
  readonly #reconsiderScripts: TurnScript[] = [];
  readonly #cleanupScripts: CleanupScript[] = [];
  readonly #planScripts: PlanScript[] = [];

  onTurn(...scripts: TurnScript[]): this {
    this.#turnScripts.push(...scripts);
    return this;
  }

  /** 되묻기에 쓰는 각본. 없으면 첫 출력을 그대로 다시 낸다(또 빠뜨림). */
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

  decidersFor(ctx: HarnessContext): Deciders {
    return {
      turn: { begin: (request) => this.#beginTurn(ctx, request) },
      cleanup: { decide: (request) => this.#runCleanup(ctx, request) },
      plan: (task) => this.#runPlan(ctx, task),
    };
  }

  #beginTurn(ctx: HarnessContext, request: TurnRequest) {
    this.#record(ctx, request.task);
    let firstOutput: TurnOutput | undefined;
    return {
      decide: async () => {
        const turn = new ScriptedTurn(ctx, request);
        firstOutput = await (this.#turnScripts.shift() ?? silentTurn)(turn);
        return firstOutput;
      },
      reconsider: async (goalsWithoutNextCheck: WorkingGoal[]) => {
        const turn = new ScriptedTurn(ctx, request, goalsWithoutNextCheck);
        this.#record(ctx, request.task, { isReconsider: true });
        const script = this.#reconsiderScripts.shift() ?? (() => firstOutput!);
        return script(turn);
      },
    };
  }

  async #runCleanup(ctx: HarnessContext, request: CleanupRequest): Promise<void> {
    this.#record(ctx, { kind: "cleanup", flowId: request.flowId });
    await this.#cleanupScripts.shift()?.(new ScriptedCleanup(request));
  }

  async #runPlan(ctx: HarnessContext, task: PlanTask): Promise<void> {
    this.#record(ctx, task);
    await (this.#planScripts.shift() ?? ((plan) => plan.finishPlan()))(new FakePlan(ctx));
  }

  /** 끝없는 반복은 결정 실패가 아니라 작업 예외로 던져, 루프가 다음 깨어남까지 멈추게 한다. */
  #record(ctx: HarnessContext, task: LlmTask, options: { isReconsider?: boolean } = {}): void {
    this.log.push({ task, startedAt: ctx.clock.now(), ...options });
    if (this.log.length > RUNAWAY_LIMIT) throw new RunawayError("LLM 작업이 끝없이 반복된다");
  }
}

class RunawayError extends Error {}

function silentTurn(turn: ScriptedTurn): TurnOutput {
  return turn.task.trigger === "continue" ? turn.silentEnd() : turn.silent();
}

export interface SpeechOptions {
  continueAfter?: DurationLike;
}

export class ScriptedTurn {
  readonly task: TurnTask;
  readonly goalsWithoutNextCheck: WorkingGoal[];
  readonly #ctx: HarnessContext;
  readonly #request: TurnRequest;

  constructor(
    ctx: HarnessContext,
    request: TurnRequest,
    goalsWithoutNextCheck: WorkingGoal[] = [],
  ) {
    this.#ctx = ctx;
    this.#request = request;
    this.task = request.task;
    this.goalsWithoutNextCheck = goalsWithoutNextCheck;
  }

  use(name: string, args: unknown): ToolResult {
    return this.#request.tools.use(name, args);
  }

  /** 도구 인자 형식의 시각. `HH:mm`이면 지금의 로컬 날짜로 채운다. */
  time(localTime: string): string {
    return formatLocalTime(
      parseLocalTime(localTime, this.#ctx.config.timezone, this.#ctx.clock.now()),
      this.#ctx.config.timezone,
    );
  }

  createGoal(goal: { title: string; dueAt?: string; jobId?: string }): number {
    const result = this.#useOrThrow("goal_create", {
      job_id: goal.jobId ?? "sample",
      title: goal.title,
      done_criteria: `${goal.title} 끝`,
      due_at: goal.dueAt && this.time(goal.dueAt),
    });
    return result.goal_id as number;
  }

  reserveOpening(opening: { at: string; intent?: string; goalIds?: number[] }): number {
    const result = this.#useOrThrow("open_reserve", {
      at: this.time(opening.at),
      intent: opening.intent ?? "개입",
      goal_ids: opening.goalIds ?? [],
    });
    return result.reservation_id as number;
  }

  say(say: string | string[], options: SpeechOptions = {}): TurnOutput {
    const continueAt =
      options.continueAfter === undefined
        ? undefined
        : this.#ctx.clock.now().plus(options.continueAfter);
    return { messages: toMessages(say), next: { kind: "continue", at: continueAt } };
  }

  end(say: string | string[] = []): TurnOutput {
    return { messages: toMessages(say), next: { kind: "end" } };
  }

  /** 말 없이 이어가기. 개시 턴이면 무시·개입 취소, 답장 턴이면 조용히 기다림이다. */
  silent(): TurnOutput {
    return { messages: [], next: { kind: "continue" } };
  }

  silentEnd(): TurnOutput {
    return this.end();
  }

  #useOrThrow(name: string, args: unknown): Extract<ToolResult, { ok: true }> {
    const result = this.use(name, args);
    if (!result.ok) throw new Error(`각본의 ${name}가 거부됐다: ${result.reason}`);
    return result;
  }
}

function toMessages(say: string | string[]): string[] {
  return typeof say === "string" ? [say] : say;
}

export class ScriptedCleanup {
  readonly flowId: number;
  readonly #request: CleanupRequest;

  constructor(request: CleanupRequest) {
    this.#request = request;
    this.flowId = request.flowId;
  }

  use(name: string, args: unknown): ToolResult {
    return this.#request.tools.use(name, args);
  }

  fail(): never {
    throw new Error("각본이 정리를 실패시켰다");
  }
}

/** 계획 결과를 DB에 직접 쓰는 가짜. 계획 단계에서 실제 계획 커밋으로 바꾼다. */
export class FakePlan {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  finishPlan(plan: { openings?: { at: string; intent?: string }[] } = {}): void {
    const now = this.#ctx.clock.now();
    const planDate = this.#ctx.calendar.currentPlanDate(now);
    inTransaction(this.#ctx.db, () => {
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
