import type { DateTime } from "luxon";
import type { HarnessState } from "../db/repositories/harness-state.ts";
import { type PlanDate, fromDbTime } from "../time.ts";
import type { HarnessContext } from "./context.ts";

export function isDue(at: string | null, now: DateTime): boolean {
  return at === null || fromDbTime(at) <= now;
}

export function isTurnBackoffOver(state: HarnessState, now: DateTime): boolean {
  return isDue(state.turn_retry_at, now);
}

export function isPlanOverdue(state: HarnessState, currentPlanDate: PlanDate): boolean {
  return state.last_plan_date === null || state.last_plan_date < currentPlanDate;
}

export function debounceEndsAt(ctx: HarnessContext, lastMessageAt: DateTime): DateTime {
  return lastMessageAt.plus({ seconds: ctx.config.message_debounce_sec });
}

export function isUserStillTyping(
  ctx: HarnessContext,
  lastMessageAt: DateTime | undefined,
  now: DateTime,
): boolean {
  return lastMessageAt !== undefined && debounceEndsAt(ctx, lastMessageAt) > now;
}
