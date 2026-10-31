import { inTransaction } from "../db/transaction.ts";
import type { PlanDate } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { closeFlow, scheduleFollowUpsForUncoveredGoals } from "./flow.ts";
import { fitContinueTime } from "./reservation-times.ts";
import type { TurnTask } from "./tasks.ts";
import type { TurnChanges } from "./tools/turn-changes.ts";
import type { TurnOutput } from "./turn.ts";

export interface DecidedTurn {
  task: TurnTask;
  planDate: PlanDate;
  /** 턴이 본 user 메시지의 끝. 그 뒤에 온 것은 이 턴이 답하지 않은 것으로 남는다. */
  lastSeenUserMessageId: number;
  output: TurnOutput;
  changes: TurnChanges;
  /** io 중에 와서 텔레그램에서 지운 user 메시지. 말한 턴이면 `busy`로 표시한다. */
  busyMessageIds: number[];
}

export function commitTurn(ctx: HarnessContext, turn: DecidedTurn): void {
  inTransaction(ctx.db, () => {
    const output = hasOpeningTurnRunIntoBlackout(ctx, turn.task)
      ? { ...turn.output, messages: [] }
      : turn.output;
    const isSilent = output.messages.length === 0;
    if (isSilent && turn.changes.hasChanges) {
      ctx.logger.warn(`말 없는 턴(${turn.task.trigger})의 도구 효과를 버렸다`);
    }

    if (isSilent && opensFlow(turn.task)) {
      declineToOpenFlow(ctx, turn);
      ctx.harnessState.resetTurnFailures();
      return;
    }

    const flowId = "flowId" in turn.task ? turn.task.flowId : openFlowFor(ctx, turn);
    if (!isSilent) {
      ctx.messages.markBusy(turn.busyMessageIds);
      turn.changes.applyTo(ctx, flowId);
      const createdJobId = turn.changes.firstCreatedGoalJobId;
      if (createdJobId !== undefined) ctx.flows.settleJobIfUnset(flowId, createdJobId);
      queueMessages(ctx, flowId, output.messages);
    }
    ctx.flows.recordTurn(flowId, turn.lastSeenUserMessageId);
    ctx.harnessState.resetTurnFailures();

    const isQuietlyWaiting = isSilent && output.next.kind === "continue";
    if (!isQuietlyWaiting) replaceContinueOrClose(ctx, flowId, output.next);
  });
}

function opensFlow(task: TurnTask): boolean {
  return task.trigger === "open" || task.trigger === "user";
}

/** io가 블랙아웃 시작을 넘긴 AI 개시 턴은 말 없는 개입 취소로 바꾼다. 블랙아웃에 새 흐름을 열지 않는다. */
export function hasOpeningTurnRunIntoBlackout(ctx: HarnessContext, task: TurnTask): boolean {
  return task.trigger === "open" && ctx.calendar.isInBlackout(ctx.clock.now());
}

function declineToOpenFlow(ctx: HarnessContext, turn: DecidedTurn): void {
  if (turn.task.trigger === "user") {
    ctx.messages.markPendingIgnoredUpTo(turn.lastSeenUserMessageId);
  } else if (turn.task.trigger === "open") {
    ctx.reservations.delete(turn.task.reservationId);
    scheduleFollowUpsForUncoveredGoals(ctx);
  }
}

function openFlowFor(ctx: HarnessContext, turn: DecidedTurn): number {
  const opening =
    turn.task.trigger === "open" ? ctx.reservations.findById(turn.task.reservationId) : undefined;
  const flowId = ctx.flows.open({
    opener: opening ? "ai" : "user",
    openedByReservationId: opening?.id ?? null,
    openedIntent: opening?.intent ?? null,
    jobId: opening?.job_id ?? null,
    planDate: turn.planDate,
    startedAt: ctx.clock.now(),
  });
  ctx.messages.moveOutsideMessagesIntoFlow(flowId, ctx.config.outside_messages_max);
  if (opening) {
    for (const goalId of ctx.reservations.goalIdsOf(opening.id)) ctx.flows.addGoal(flowId, goalId);
    ctx.reservations.delete(opening.id);
  }
  return flowId;
}

function queueMessages(ctx: HarnessContext, flowId: number, messages: string[]): void {
  for (const text of messages) ctx.messages.queueAssistantMessage(flowId, text, ctx.clock.now());
}

function replaceContinueOrClose(
  ctx: HarnessContext,
  flowId: number,
  next: TurnOutput["next"],
): void {
  ctx.reservations.deleteContinue(flowId);
  if (next.kind === "end") {
    closeFlow(ctx, flowId, "agent");
    return;
  }
  const now = ctx.clock.now();
  const flow = ctx.flows.findById(flowId)!;
  const fitted = fitContinueTime(ctx, next.at, flow.plan_date, now);
  if (fitted.wasFilledWithDefault) {
    ctx.logger.warn(
      `이어가기 시각이 빠지거나 지나서 ${ctx.config.continue_default_sec}초 뒤로 메웠다`,
    );
  }
  ctx.reservations.scheduleContinue(flowId, fitted.at, "turn", now);
}
