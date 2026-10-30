import { DateTime } from "luxon";
import type { Config } from "../config.ts";
import type { PlanCalendar, PlanDate } from "../time.ts";

export interface ReservationTimeRules {
  calendar: PlanCalendar;
  config: Config;
}

export type FittedOpeningTime = { ok: true; at: DateTime } | { ok: false; reason: string };

export function earliestOpeningAt(
  rules: ReservationTimeRules,
  planDate: PlanDate,
  now: DateTime,
): DateTime {
  return DateTime.max(
    now.plus({ seconds: rules.config.min_lead_sec }),
    rules.calendar.blackoutEndOf(planDate),
  );
}

export function hasTimeLeftForOpening(
  rules: ReservationTimeRules,
  planDate: PlanDate,
  now: DateTime,
): boolean {
  return earliestOpeningAt(rules, planDate, now) < rules.calendar.endOfDay(planDate);
}

/**
 * 그날 끝 이후는 당기지 않고 거부한다. 조용히 당기면 "내일 9시"가 "오늘 23:59"로 뜻이 바뀐다.
 * 너무 이른 시각은 블랙아웃 끝과 `now + min_lead` 중 늦은 쪽으로 당긴다.
 */
export function fitOpeningTime(
  rules: ReservationTimeRules,
  requestedAt: DateTime,
  planDate: PlanDate,
  now: DateTime,
): FittedOpeningTime {
  const endOfDay = rules.calendar.endOfDay(planDate);
  const shownEndOfDay = formatLocalTime(endOfDay, rules.config.timezone);
  if (!hasTimeLeftForOpening(rules, planDate, now)) {
    return { ok: false, reason: `그날 끝(${shownEndOfDay})까지 예약할 시간이 남지 않았다` };
  }
  if (requestedAt >= endOfDay) {
    return { ok: false, reason: `그날 끝(${shownEndOfDay}) 이후로는 예약할 수 없다` };
  }
  return { ok: true, at: DateTime.max(requestedAt, earliestOpeningAt(rules, planDate, now)) };
}

export interface FittedContinueTime {
  at: DateTime;
  wasFilledWithDefault: boolean;
}

/** 빠지거나 지난 시각을 `now + min_lead`로 메우지 않는다. 출력 실수 하나가 1분 간격의 턴 반복이 된다. */
export function fitContinueTime(
  rules: ReservationTimeRules,
  requestedAt: DateTime | undefined,
  flowPlanDate: PlanDate,
  now: DateTime,
): FittedContinueTime {
  const wasFilledWithDefault = requestedAt === undefined || requestedAt <= now;
  const wantedAt = wasFilledWithDefault
    ? now.plus({ seconds: rules.config.continue_default_sec })
    : requestedAt;
  const at = DateTime.min(
    DateTime.max(wantedAt, now.plus({ seconds: rules.config.min_lead_sec })),
    rules.calendar.endOfDay(flowPlanDate),
  );
  return { at, wasFilledWithDefault };
}

const LOCAL_TIME_FORMAT = "yyyy-MM-dd HH:mm";

export function formatLocalTime(time: DateTime, timezone: string): string {
  return time.setZone(timezone).toFormat(LOCAL_TIME_FORMAT);
}

export function parseLocalTime(text: string, timezone: string): DateTime | undefined {
  const time = DateTime.fromFormat(text, LOCAL_TIME_FORMAT, { zone: timezone });
  return time.isValid ? time.toUTC() : undefined;
}
