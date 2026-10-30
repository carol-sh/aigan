import type { DateTime } from "luxon";
import { fromDbTime } from "../time.ts";
import { debounceEndsAt, isPlanOverdue } from "../worker/conditions.ts";
import type { HarnessContext } from "../worker/context.ts";

export function nextDeadline(ctx: HarnessContext): DateTime | undefined {
  const now = ctx.clock.now();
  const planDate = ctx.calendar.currentPlanDate(now);
  const state = ctx.harnessState.get();
  const candidates = [
    ctx.reservations.earliestScheduledAt(),
    debounceExpiry(ctx),
    dbTimeOrUndefined(state.turn_retry_at),
    ctx.flows.earliestCleanupRetryAt(),
    // 계획이 밀렸어도 따로 넣는다. 계획 재시도만 넣으면 그날은 블랙아웃 시작에 깨어나지 않아,
    // 이어가기가 턴 백오프에 막힌 동안 흐름 닫기와 날 넘김이 늦어진다.
    ctx.calendar.nextBlackoutStart(now),
    isPlanOverdue(state, planDate) ? dbTimeOrUndefined(state.plan_retry_at) : undefined,
    ctx.calendar.isInBlackout(now) ? ctx.calendar.blackoutEndOf(planDate) : undefined,
    dbTimeOrUndefined(state.hold_until),
  ];
  // 이미 지난 값은 다른 조건(열린 흐름, 정리, 백오프, 보류, 디바운스)에 막힌 작업이다. 조준하면 타이머가
  // 곧바로 발화하고 아무것도 고르지 못하는 바쁜 루프가 된다(L1). 막는 조건은 각자 기한이나 wake()를 갖는다.
  return earliest(candidates.filter((at): at is DateTime => at !== undefined && at > now));
}

function debounceExpiry(ctx: HarnessContext): DateTime | undefined {
  const openFlow = ctx.flows.findOpen();
  const lastMessageAt = openFlow
    ? ctx.messages.latestUnansweredAt(openFlow)
    : ctx.messages.latestPendingAt();
  return lastMessageAt && debounceEndsAt(ctx, lastMessageAt);
}

function dbTimeOrUndefined(text: string | null): DateTime | undefined {
  return text === null ? undefined : fromDbTime(text);
}

function earliest(times: DateTime[]): DateTime | undefined {
  return times.reduce<DateTime | undefined>(
    (min, at) => (min === undefined || at < min ? at : min),
    undefined,
  );
}
