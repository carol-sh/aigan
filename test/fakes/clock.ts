import { DateTime } from "luxon";
import type { CancelTimer, Clock } from "../../src/ports.ts";

interface PendingTimer {
  dueAtMonotonicMs: number;
  onFire: () => void;
}

/**
 * 벽시계와 단조 시계를 따로 둔다. `advance`는 둘 다 진행하며 그 사이 타이머를 순서대로 발화하고,
 * `suspend`는 기기 절전처럼 벽시계만 진행한다.
 */
export class FakeClock implements Clock {
  #wallMs: number;
  #monotonicMs = 0;
  #nextTimerId = 1;
  readonly #timers = new Map<number, PendingTimer>();

  constructor(start: DateTime) {
    this.#wallMs = start.toMillis();
  }

  now(): DateTime {
    return DateTime.fromMillis(this.#wallMs, { zone: "utc" });
  }

  setTimer(delayMs: number, onFire: () => void): CancelTimer {
    const id = this.#nextTimerId++;
    this.#timers.set(id, { dueAtMonotonicMs: this.#monotonicMs + Math.max(0, delayMs), onFire });
    return () => this.#timers.delete(id);
  }

  async advance(durationMs: number): Promise<void> {
    const targetMs = this.#monotonicMs + durationMs;
    await flushAsyncWork();
    for (let next = this.#nextTimerDueBy(targetMs); next; next = this.#nextTimerDueBy(targetMs)) {
      const [id, timer] = next;
      this.#moveBoth(timer.dueAtMonotonicMs - this.#monotonicMs);
      this.#timers.delete(id);
      timer.onFire();
      await flushAsyncWork();
    }
    this.#moveBoth(targetMs - this.#monotonicMs);
    await flushAsyncWork();
  }

  suspend(durationMs: number): void {
    this.#wallMs += durationMs;
  }

  /** 프로세스가 내려가 있던 동안. 타이머는 프로세스와 함께 사라진다. */
  passWhileDown(durationMs: number): void {
    this.#timers.clear();
    this.#moveBoth(durationMs);
  }

  #moveBoth(durationMs: number): void {
    this.#wallMs += durationMs;
    this.#monotonicMs += durationMs;
  }

  #nextTimerDueBy(limitMs: number): [number, PendingTimer] | undefined {
    let earliest: [number, PendingTimer] | undefined;
    for (const entry of this.#timers) {
      if (entry[1].dueAtMonotonicMs > limitMs) continue;
      if (!earliest || entry[1].dueAtMonotonicMs < earliest[1].dueAtMonotonicMs) earliest = entry;
    }
    return earliest;
  }
}

export async function flushAsyncWork(): Promise<void> {
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}
