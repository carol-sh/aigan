import { DateTime } from "luxon";
import type { CancelTimer, Clock } from "../ports.ts";

export class SystemClock implements Clock {
  now(): DateTime {
    return DateTime.utc();
  }

  setTimer(delayMs: number, onFire: () => void): CancelTimer {
    const timer = setTimeout(onFire, Math.max(0, delayMs));
    return () => clearTimeout(timer);
  }
}
