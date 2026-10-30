import { DateTime } from "luxon";
import { inTransaction } from "../db/transaction.ts";
import type { FlowEndReason } from "../db/repositories/flows.ts";
import type { Goal } from "../db/repositories/goals.ts";
import { type PlanDate, fromDbTime } from "../time.ts";
import type { HarnessContext } from "./context.ts";

export function closeFlow(ctx: HarnessContext, flowId: number, reason: FlowEndReason): void {
  inTransaction(ctx.db, () => {
    const flow = ctx.flows.findById(flowId);
    if (!flow || flow.ended_at !== null) throw new Error(`흐름 ${flowId}는 열려 있지 않다`);
    ctx.reservations.deleteContinue(flow.id);
    ctx.flows.close(
      flow.id,
      reason,
      ctx.clock.now(),
      ctx.prompts.cleanupRules === undefined ? "skipped" : "pending",
    );
    ctx.messages.moveUnansweredOutOfFlow(flow);
    scheduleFollowUpsForUncoveredGoals(ctx);
  });
  ctx.logger.info(`흐름 ${flowId}를 닫았다(${reason})`);
}

export function scheduleFollowUpsForUncoveredGoals(ctx: HarnessContext): void {
  const now = ctx.clock.now();
  const planDate = ctx.calendar.currentPlanDate(now);
  for (const goal of ctx.goals.findActiveWithoutOpening(planDate)) {
    const at = followUpTimeFor(ctx, goal, planDate, now);
    if (at === undefined) {
      ctx.logger.info(`목표 ${goal.id}는 그날 남은 시간이 없어 후속 확인을 잡지 않았다`);
      continue;
    }
    ctx.reservations.scheduleOpening({
      at,
      intent: "후속 확인",
      planDate,
      source: "harness",
      goalIds: [goal.id],
      createdAt: now,
    });
    ctx.logger.warn(`예약이 없는 목표 ${goal.id}에 후속 확인을 잡았다(${at.toISO()})`);
  }
}

/**
 * 마감이 지났으면 `due_at` 대신 `orphan_goal_delay`를 쓴다. 지난 마감을 그대로 쓰면
 * 앞쪽 클램프가 `now + min_lead`로 당겨서 몇 분마다 다시 확인하게 된다(L7).
 */
function followUpTimeFor(
  ctx: HarnessContext,
  goal: Goal,
  planDate: PlanDate,
  now: DateTime,
): DateTime | undefined {
  const minLead = { seconds: ctx.config.min_lead_sec };
  const endOfDay = ctx.calendar.endOfDay(planDate);
  const dueAt = goal.due_at === null ? undefined : fromDbTime(goal.due_at);
  const preferred =
    dueAt !== undefined && dueAt > now
      ? dueAt
      : now.plus({ seconds: ctx.config.orphan_goal_delay_sec });
  const at = DateTime.max(
    DateTime.min(preferred, endOfDay.minus(minLead)),
    now.plus(minLead),
    ctx.calendar.blackoutEndOf(planDate),
  );
  return at < endOfDay ? at : undefined;
}

export function hasLeftoversFromPastPlanDays(
  ctx: HarnessContext,
  currentPlanDate: PlanDate,
): boolean {
  return (
    ctx.goals.hasActiveBefore(currentPlanDate) ||
    ctx.reservations.hasOpeningsBefore(currentPlanDate)
  );
}

export function closePastPlanDays(ctx: HarnessContext): void {
  const now = ctx.clock.now();
  const planDate = ctx.calendar.currentPlanDate(now);
  const { expiredGoals, deletedOpenings } = inTransaction(ctx.db, () => ({
    expiredGoals: ctx.goals.expireActiveBefore(planDate, now),
    deletedOpenings: ctx.reservations.deleteOpeningsBefore(planDate),
  }));
  ctx.logger.info(`날 넘김: 목표 ${expiredGoals}개 만료, 개시 예약 ${deletedOpenings}개 삭제`);
}

export function discardOpeningForClosedGoals(ctx: HarnessContext, reservationId: number): void {
  inTransaction(ctx.db, () => {
    ctx.reservations.delete(reservationId);
    scheduleFollowUpsForUncoveredGoals(ctx);
  });
  ctx.logger.info(`겨냥한 목표가 모두 끝난 개시 예약 ${reservationId}를 지웠다`);
}
