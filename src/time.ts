import { DateTime } from "luxon";
import type { BlackoutWindow, ClockTime, Config } from "./config.ts";
import type { Clock } from "./ports.ts";

/** 로컬 날짜 `YYYY-MM-DD`. 블랙아웃이 끝나는 날로 정한다. */
export type PlanDate = string;

export function toDbTime(time: DateTime): string {
  return time.toUTC().toISO()!;
}

export function fromDbTime(text: string): DateTime {
  return DateTime.fromISO(text, { zone: "utc" });
}

export function sleep(clock: Clock, delayMs: number): Promise<void> {
  return new Promise((resolve) => clock.setTimer(delayMs, resolve));
}

/**
 * 블랙아웃 구간 하나가 계획일 하나에 대응한다. 계획일 D의 블랙아웃은 D의 `end` 시각에 끝나고,
 * 자정을 넘는 설정이면 전날 `start` 시각에 시작한다. 깨어 있는 구간은 그 끝에서 다음 계획일의 블랙아웃 시작까지다.
 */
export class PlanCalendar {
  readonly #timezone: string;
  readonly #blackout: BlackoutWindow;

  constructor(timezone: string, blackout: BlackoutWindow) {
    this.#timezone = timezone;
    this.#blackout = blackout;
  }

  static fromConfig(config: Config): PlanCalendar {
    return new PlanCalendar(config.timezone, config.blackout);
  }

  currentPlanDate(now: DateTime): PlanDate {
    let candidate = this.#localDate(now).plus({ days: 1 });
    while (this.#blackoutStartOn(candidate) > now) {
      candidate = candidate.minus({ days: 1 });
    }
    return candidate.toISODate()!;
  }

  isInBlackout(now: DateTime): boolean {
    return now < this.blackoutEndOf(this.currentPlanDate(now));
  }

  blackoutEndOf(planDate: PlanDate): DateTime {
    return this.#atClockTime(this.#parsePlanDate(planDate), this.#blackout.end);
  }

  endOfDay(planDate: PlanDate): DateTime {
    return this.#blackoutStartOn(this.#parsePlanDate(planDate).plus({ days: 1 }));
  }

  nextBlackoutStart(now: DateTime): DateTime {
    return this.endOfDay(this.currentPlanDate(now));
  }

  localDate(now: DateTime): string {
    return this.#localDate(now).toISODate()!;
  }

  nextLocalMidnight(now: DateTime): DateTime {
    return this.#localDate(now).plus({ days: 1 }).toUTC();
  }

  #blackoutStartOn(planDay: DateTime): DateTime {
    const startDay = this.#crossesMidnight() ? planDay.minus({ days: 1 }) : planDay;
    return this.#atClockTime(startDay, this.#blackout.start);
  }

  #crossesMidnight(): boolean {
    const { start, end } = this.#blackout;
    return start.hour * 60 + start.minute > end.hour * 60 + end.minute;
  }

  #atClockTime(day: DateTime, time: ClockTime): DateTime {
    return DateTime.fromObject(
      { year: day.year, month: day.month, day: day.day, hour: time.hour, minute: time.minute },
      { zone: this.#timezone },
    ).toUTC();
  }

  #localDate(now: DateTime): DateTime {
    return now.setZone(this.#timezone).startOf("day");
  }

  #parsePlanDate(planDate: PlanDate): DateTime {
    return DateTime.fromISO(planDate, { zone: this.#timezone });
  }
}

export function turnBackoffDelaySec(failureCount: number, config: Config): number {
  return exponentialBackoff(
    failureCount,
    config.failure_backoff_first_sec,
    config.failure_backoff_cap_sec,
  );
}

export function cleanupBackoffDelaySec(attempts: number, config: Config): number {
  return exponentialBackoff(
    attempts,
    config.cleanup_backoff_first_sec,
    config.cleanup_backoff_cap_sec,
  );
}

function exponentialBackoff(attempt: number, firstSec: number, capSec: number): number {
  return Math.min(firstSec * 2 ** (attempt - 1), capSec);
}
