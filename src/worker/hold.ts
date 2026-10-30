import type { DateTime } from "luxon";
import type { HarnessState } from "../db/repositories/harness-state.ts";
import { fromDbTime } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { resumePendingWork } from "./resume.ts";

export async function checkHoldRecovery(ctx: HarnessContext): Promise<void> {
  const state = ctx.harnessState.get();
  const now = ctx.clock.now();
  if (!isHoldRecovered(ctx, state, now)) {
    ctx.harnessState.postponeHoldCheck(nextHoldCheckAt(ctx, state, now));
    return;
  }
  ctx.harnessState.clearHold();
  ctx.logger.info(`보류(${state.hold_reason})를 풀었다`);
  await resumePendingWork(ctx);
}

function isHoldRecovered(ctx: HarnessContext, state: HarnessState, now: DateTime): boolean {
  switch (state.hold_reason) {
    case "blocked":
      return (
        state.hold_since !== null && ctx.messages.hasUserMessageSince(fromDbTime(state.hold_since))
      );
    case "daily_limit":
      return state.daily_calls_date !== ctx.calendar.localDate(now);
    case "balance":
      return false;
    case null:
      return true;
  }
}

function nextHoldCheckAt(ctx: HarnessContext, state: HarnessState, now: DateTime): DateTime {
  if (state.hold_reason === "daily_limit") return ctx.calendar.nextLocalMidnight(now);
  return now.plus({ seconds: ctx.config.balance_retry_sec ?? ctx.config.timer_max_sleep_sec });
}
