import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { type PlanDate, toDbTime } from "../../time.ts";

export type HoldReason = "balance" | "daily_limit" | "blocked";

export interface HarnessState {
  hold_reason: HoldReason | null;
  hold_until: string | null;
  hold_since: string | null;
  last_plan_date: PlanDate | null;
  plan_attempts: number;
  plan_retry_at: string | null;
  failure_count: number;
  output_fail_count: number;
  output_fail_key: string | null;
  turn_retry_at: string | null;
  daily_calls: number;
  daily_calls_date: string | null;
}

export class HarnessStateRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(): HarnessState {
    return this.#db
      .prepare("SELECT * FROM harness_state WHERE id = 1")
      .get() as unknown as HarnessState;
  }

  enterHold(reason: HoldReason, since: DateTime, until: DateTime | null): void {
    this.#db
      .prepare(
        "UPDATE harness_state SET hold_reason = ?, hold_since = ?, hold_until = ? WHERE id = 1",
      )
      .run(reason, toDbTime(since), until && toDbTime(until));
  }

  postponeHoldCheck(until: DateTime): void {
    this.#db.prepare("UPDATE harness_state SET hold_until = ? WHERE id = 1").run(toDbTime(until));
  }

  clearHold(): void {
    this.#db
      .prepare(
        "UPDATE harness_state SET hold_reason = NULL, hold_since = NULL, hold_until = NULL WHERE id = 1",
      )
      .run();
  }

  resetTurnFailures(): void {
    this.#db
      .prepare(
        `UPDATE harness_state
         SET failure_count = 0, output_fail_count = 0, output_fail_key = NULL, turn_retry_at = NULL
         WHERE id = 1`,
      )
      .run();
  }

  /** 요청 한 건을 센다. 날짜가 바뀌었으면 먼저 0으로 되돌린다. */
  countLlmRequest(localDate: string): void {
    this.#db
      .prepare(
        `UPDATE harness_state
         SET daily_calls = CASE WHEN daily_calls_date = :localDate THEN daily_calls + 1 ELSE 1 END,
             daily_calls_date = :localDate
         WHERE id = 1`,
      )
      .run({ localDate });
  }

  recordPlanAttempt(retryAt: DateTime): void {
    this.#db
      .prepare(
        "UPDATE harness_state SET plan_attempts = plan_attempts + 1, plan_retry_at = ? WHERE id = 1",
      )
      .run(toDbTime(retryAt));
  }

  markPlanned(planDate: PlanDate): void {
    this.#db
      .prepare(
        "UPDATE harness_state SET last_plan_date = ?, plan_attempts = 0, plan_retry_at = NULL WHERE id = 1",
      )
      .run(planDate);
  }
}
