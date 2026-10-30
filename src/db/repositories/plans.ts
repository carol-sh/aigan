import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { type PlanDate, toDbTime } from "../../time.ts";

export class PlanRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  findBody(planDate: PlanDate): string | undefined {
    const row = this.#db.prepare("SELECT body FROM plans WHERE plan_date = ?").get(planDate) as
      | { body: string }
      | undefined;
    return row?.body;
  }

  save(planDate: PlanDate, body: string, createdAt: DateTime): void {
    this.#db
      .prepare(
        `INSERT INTO plans (plan_date, body, created_at) VALUES (?, ?, ?)
         ON CONFLICT (plan_date) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`,
      )
      .run(planDate, body, toDbTime(createdAt));
  }
}
