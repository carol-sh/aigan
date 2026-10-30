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
