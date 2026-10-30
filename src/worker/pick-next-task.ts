import type { DateTime } from "luxon";
import type { Flow } from "../db/repositories/flows.ts";
import type { HarnessState } from "../db/repositories/harness-state.ts";
import type { Reservation } from "../db/repositories/reservations.ts";
import { type PlanDate, fromDbTime } from "../time.ts";
import { isDue, isPlanOverdue, isTurnBackoffOver, isUserStillTyping } from "./conditions.ts";
import type { HarnessContext } from "./context.ts";
import { hasLeftoversFromPastPlanDays } from "./flow.ts";
import type { Task } from "./tasks.ts";

export function pickNextTask(ctx: HarnessContext): Task | null {
  const now = ctx.clock.now();
  const planDate = ctx.calendar.currentPlanDate(now);
  const openFlow = ctx.flows.findOpen();
  const flowAwaitingCleanup = ctx.flows.findOldestAwaitingCleanup();

  if (openFlow && hasFlowOutlivedItsDay(ctx, openFlow, planDate, now)) {
    return { kind: "closeFlowForBlackout", flowId: openFlow.id };
  }
  if (!openFlow && !flowAwaitingCleanup && hasLeftoversFromPastPlanDays(ctx, planDate)) {
    return { kind: "closePastPlanDays" };
  }

  const state = ctx.harnessState.get();
  if (state.hold_reason !== null) {
    return isHoldDueForCheck(ctx, state, now) ? { kind: "checkHoldRecovery" } : null;
  }
  if (openFlow) return pickTurnInOpenFlow(ctx, openFlow, state, now);
  if (flowAwaitingCleanup) {
    return isDue(flowAwaitingCleanup.cleanup_next_at, now)
      ? { kind: "cleanup", flowId: flowAwaitingCleanup.id }
      : null;
  }
  if (!isTurnBackoffOver(state, now)) return null;
  if (!ctx.calendar.isInBlackout(now)) {
    const lastPendingAt = ctx.messages.latestPendingAt();
    if (isUserStillTyping(ctx, lastPendingAt, now)) return null;
    const overdueOpening = ctx.reservations.findFiredOpenings()[0];
    if (overdueOpening) return openingTask(ctx, overdueOpening);
    if (lastPendingAt) return { kind: "turn", trigger: "user" };
  }
  if (isPlanOverdue(state, planDate) && isDue(state.plan_retry_at, now)) return { kind: "plan" };
  return null;
}

/** 블랙아웃을 자며 지나쳐 깨어난 경우도 있어서, 블랙아웃 중인지와 함께 흐름의 계획일이 지났는지 본다. */
function hasFlowOutlivedItsDay(
  ctx: HarnessContext,
  flow: Flow,
  currentPlanDate: PlanDate,
  now: DateTime,
): boolean {
  return ctx.calendar.isInBlackout(now) || flow.plan_date < currentPlanDate;
}

function isHoldDueForCheck(ctx: HarnessContext, state: HarnessState, now: DateTime): boolean {
  if (state.hold_reason === "blocked") {
    return (
      state.hold_since !== null && ctx.messages.hasUserMessageSince(fromDbTime(state.hold_since))
    );
  }
  return state.hold_until !== null && isDue(state.hold_until, now);
}

function pickTurnInOpenFlow(
  ctx: HarnessContext,
  flow: Flow,
  state: HarnessState,
  now: DateTime,
): Task | null {
  const lastUnansweredAt = ctx.messages.latestUnansweredAt(flow);
  if (isUserStillTyping(ctx, lastUnansweredAt, now)) return null;
  if (!isTurnBackoffOver(state, now)) return null;
  if (ctx.reservations.findContinue(flow.id)?.state === "fired") {
    return { kind: "turn", trigger: "continue", flowId: flow.id };
  }
  if (lastUnansweredAt) return { kind: "turn", trigger: "reply", flowId: flow.id };
  return null;
}

function openingTask(ctx: HarnessContext, opening: Reservation): Task {
  const goalIds = ctx.reservations.goalIdsOf(opening.id);
  if (goalIds.length > 0 && ctx.goals.areAllClosed(goalIds)) {
    return { kind: "discardOpeningForClosedGoals", reservationId: opening.id };
  }
  return { kind: "turn", trigger: "open", reservationId: opening.id };
}
