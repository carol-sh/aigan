import { DateTime, type DurationLike } from "luxon";
import { inTransaction } from "../../src/db/transaction.ts";
import type { HarnessContext } from "../../src/worker/context.ts";
import { closeFlow, scheduleFollowUpsForUncoveredGoals } from "../../src/worker/flow.ts";
import type { LlmTask, LlmTaskHandlers, TurnTask } from "../../src/worker/tasks.ts";
import { cleanupBackoffDelaySec, turnBackoffDelaySec } from "../../src/time.ts";

export type Script = (commit: FakeCommit) => unknown;

export interface LoggedTask {
  task: LlmTask;
  startedAt: DateTime;
}

const RUNAWAY_LIMIT = 300;

/**
 * LLM 작업 자리에 들어가는 가짜. 테스트가 작업 종류별 각본을 주고, 각본은 `FakeCommit`으로
 * 턴·계획·정리가 커밋했을 결과만 DB에 남긴다. 각본이 없으면 아무 말 없이 끝난 것처럼 처리한다.
 */
export class ScriptedLlm {
  readonly log: LoggedTask[] = [];
  readonly #scripts: { turn: Script[]; cleanup: Script[]; plan: Script[] } = {
    turn: [],
    cleanup: [],
    plan: [],
  };

  onTurn(...scripts: Script[]): this {
    this.#scripts.turn.push(...scripts);
    return this;
  }

  onCleanup(...scripts: Script[]): this {
    this.#scripts.cleanup.push(...scripts);
    return this;
  }

  onPlan(...scripts: Script[]): this {
    this.#scripts.plan.push(...scripts);
    return this;
  }

  handlersFor(ctx: HarnessContext): LlmTaskHandlers {
    const run = async (task: LlmTask, scripts: Script[], silentOutcome: Script) => {
      this.log.push({ task, startedAt: ctx.clock.now() });
      if (this.log.length > RUNAWAY_LIMIT) throw new Error("LLM 작업이 끝없이 반복된다");
      const commit = new FakeCommit(ctx, task);
      await (scripts.shift() ?? silentOutcome)(commit);
    };
    return {
      turn: (task) => run(task, this.#scripts.turn, silentTurn),
      cleanup: (task) => run(task, this.#scripts.cleanup, (c) => c.finishCleanup()),
      plan: (task) => run(task, this.#scripts.plan, (c) => c.finishPlan()),
    };
  }
}

function silentTurn(commit: FakeCommit): void {
  const task = commit.task as TurnTask;
  if (task.trigger === "open") commit.cancelOpening();
  else if (task.trigger === "user") commit.ignore();
  else commit.waitQuietly();
}

export interface Speech {
  say?: string | string[];
  continueAfter?: DurationLike;
}

export class FakeCommit {
  readonly task: LlmTask;
  readonly #ctx: HarnessContext;
  /** 턴이 pre에서 입력으로 고정한 user 메시지의 끝. 그 뒤에 온 것은 이 턴이 답하지 않은 것으로 남는다. */
  readonly #seenUpToId: number;
  #flowId: number | undefined;

  constructor(ctx: HarnessContext, task: LlmTask) {
    this.#ctx = ctx;
    this.task = task;
    this.#seenUpToId = ctx.messages.latestUserMessageId();
    this.#flowId = "flowId" in task ? task.flowId : undefined;
  }

  at(localTime: string): DateTime {
    return parseLocalTime(localTime, this.#ctx.config.timezone, this.#ctx.clock.now());
  }

  get #now(): DateTime {
    return this.#ctx.clock.now();
  }

  get flowId(): number {
    if (this.#flowId === undefined) throw new Error("이 작업에는 흐름이 없다");
    return this.#flowId;
  }

  openFlow(speech: Speech = {}): number {
    const task = this.#turnTask("open", "user");
    return inTransaction(this.#ctx.db, () => {
      const opening =
        task.trigger === "open" ? this.#ctx.reservations.findById(task.reservationId) : undefined;
      const flowId = this.#ctx.flows.open({
        opener: task.trigger === "open" ? "ai" : "user",
        openedByReservationId: opening?.id ?? null,
        openedIntent: opening?.intent ?? null,
        planDate: this.#ctx.calendar.currentPlanDate(this.#now),
        startedAt: this.#now,
      });
      if (opening) {
        for (const goalId of this.#ctx.reservations.goalIdsOf(opening.id))
          this.#ctx.flows.addGoal(flowId, goalId);
        this.#ctx.reservations.delete(opening.id);
      }
      this.#ctx.messages.moveOutsideMessagesIntoFlow(flowId);
      this.#flowId = flowId;
      this.#speakInFlow(speech);
      return flowId;
    });
  }

  reply(speech: Speech = {}): void {
    inTransaction(this.#ctx.db, () => this.#speakInFlow(speech));
  }

  waitQuietly(): void {
    this.reply({});
  }

  endFlow(speech: Pick<Speech, "say"> = {}): void {
    inTransaction(this.#ctx.db, () => {
      this.#ctx.flows.recordTurn(this.flowId, this.#seenUpToId);
      this.#queue(speech.say);
      closeFlow(this.#ctx, this.flowId, "agent");
    });
  }

  ignore(): void {
    this.#turnTask("user");
    this.#ctx.messages.markPendingIgnored();
  }

  cancelOpening(): void {
    const task = this.#turnTask("open");
    inTransaction(this.#ctx.db, () => {
      this.#ctx.reservations.delete(task.reservationId);
      scheduleFollowUpsForUncoveredGoals(this.#ctx);
    });
  }

  createGoal(goal: { title: string; dueAt?: string }): number {
    const goalId = this.#ctx.goals.create({
      jobId: "sample",
      jobSnapshot: "",
      title: goal.title,
      doneCriteria: "",
      dueAt: goal.dueAt === undefined ? null : this.at(goal.dueAt),
      planDate: this.#ctx.calendar.currentPlanDate(this.#now),
      createdAt: this.#now,
    });
    this.#ctx.flows.addGoal(this.flowId, goalId);
    return goalId;
  }

  closeGoal(goalId: number): void {
    this.#ctx.goals.close(goalId, "done", "끝냄", this.#now);
  }

  scheduleOpening(opening: { at: string; intent?: string; goalIds?: number[] }): number {
    return this.#ctx.reservations.scheduleOpening({
      at: this.at(opening.at),
      intent: opening.intent ?? "개입",
      planDate: this.#ctx.calendar.currentPlanDate(this.#now),
      source: this.task.kind === "plan" ? "plan" : "turn",
      goalIds: opening.goalIds ?? [],
      createdAt: this.#now,
    });
  }

  finishCleanup(): void {
    this.#ctx.flows.finishCleanup(this.#cleanupFlowId(), "done");
  }

  failCleanup(): void {
    const flow = this.#ctx.flows.findById(this.#cleanupFlowId())!;
    const delaySec = cleanupBackoffDelaySec(flow.cleanup_attempts + 1, this.#ctx.config);
    this.#ctx.flows.recordCleanupAttempt(flow.id, this.#now.plus({ seconds: delaySec }));
  }

  finishPlan(plan: { openings?: { at: string; intent?: string }[] } = {}): void {
    inTransaction(this.#ctx.db, () => {
      for (const opening of plan.openings ?? []) this.scheduleOpening(opening);
      this.#ctx.harnessState.markPlanned(this.#ctx.calendar.currentPlanDate(this.#now));
    });
  }

  failPlan(): void {
    const attempts = this.#ctx.harnessState.get().plan_attempts + 1;
    this.#ctx.harnessState.recordPlanAttempt(
      this.#now.plus({ seconds: turnBackoffDelaySec(attempts, this.#ctx.config) }),
    );
  }

  #speakInFlow(speech: Speech): void {
    this.#ctx.flows.recordTurn(this.flowId, this.#seenUpToId);
    this.#queue(speech.say);
    const continueAt = this.#now.plus(
      speech.continueAfter ?? { seconds: this.#ctx.config.continue_default_sec },
    );
    this.#ctx.reservations.scheduleContinue(this.flowId, continueAt, "turn", this.#now);
  }

  #queue(say: string | string[] | undefined): void {
    for (const text of typeof say === "string" ? [say] : (say ?? [])) {
      this.#ctx.messages.queueAssistantMessage(this.flowId, text, this.#now);
    }
  }

  #turnTask<T extends TurnTask["trigger"]>(...triggers: T[]): Extract<TurnTask, { trigger: T }> {
    const task = this.task;
    if (task.kind !== "turn" || !triggers.includes(task.trigger as T)) {
      throw new Error(`${triggers.join("/")} 턴에서만 쓸 수 있다`);
    }
    return task as Extract<TurnTask, { trigger: T }>;
  }

  #cleanupFlowId(): number {
    if (this.task.kind !== "cleanup") throw new Error("정리 작업에서만 쓸 수 있다");
    return this.task.flowId;
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
