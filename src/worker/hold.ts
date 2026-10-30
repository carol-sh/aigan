import type { DateTime } from "luxon";
import type { HarnessState } from "../db/repositories/harness-state.ts";
import { fromDbTime } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { alertOperator } from "./operator-alert.ts";
import { formatLocalTime } from "./reservation-times.ts";
import { resumePendingWork } from "./resume.ts";

export type HoldEntry =
  | { reason: "daily_limit" }
  | { reason: "balance"; balance: number }
  | { reason: "blocked" };

/** 보류에 들어가 언제 다시 볼지 기록하고 운영자에게 알린다. `blocked`면 알림은 로그로만 남는다. */
export async function enterHold(ctx: HarnessContext, entry: HoldEntry): Promise<void> {
  const now = ctx.clock.now();
  const until = entry.reason === "blocked" ? null : nextHoldCheckAt(ctx, entry.reason, now);
  ctx.harnessState.enterHold(entry.reason, now, until);
  await alertOperator(ctx, describeHoldEntry(ctx, entry, until));
}

function describeHoldEntry(ctx: HarnessContext, entry: HoldEntry, until: DateTime | null): string {
  const untilText = until && formatLocalTime(until, ctx.config.timezone);
  switch (entry.reason) {
    case "daily_limit":
      return `오늘 LLM 요청이 상한(${ctx.config.daily_call_limit}건)에 닿아 보류에 들어간다. ${untilText}에 풀린다.`;
    case "balance":
      return `잔액(${entry.balance})이 기준(${ctx.config.balance_threshold})보다 적어 보류에 들어간다. ${untilText}에 다시 확인한다.`;
    case "blocked":
      return "사용자가 봇을 차단해 보류에 들어간다. 사용자가 다시 메시지를 보내면 풀린다.";
  }
}

export async function checkHoldRecovery(ctx: HarnessContext): Promise<void> {
  const state = ctx.harnessState.get();
  const now = ctx.clock.now();
  if (!isHoldRecovered(ctx, state, now)) {
    ctx.harnessState.postponeHoldCheck(nextHoldCheckAt(ctx, state.hold_reason, now));
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

function nextHoldCheckAt(
  ctx: HarnessContext,
  reason: HarnessState["hold_reason"],
  now: DateTime,
): DateTime {
  if (reason === "daily_limit") return ctx.calendar.nextLocalMidnight(now);
  return now.plus({ seconds: ctx.config.balance_retry_sec ?? ctx.config.timer_max_sleep_sec });
}
