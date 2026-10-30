import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { type PlanDate, toDbTime } from "../../time.ts";

export type GoalState = "active" | "done" | "failed" | "dropped" | "expired";

export interface Goal {
  id: number;
  job_id: string;
  job_snapshot: string;
  title: string;
  done_criteria: string;
  due_at: string | null;
  progress: string;
  plan_date: PlanDate;
  state: GoalState;
  end_reason: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface NewGoal {
  /** 턴이 도구 결과로 미리 알려 준 id. 없으면 SQLite가 정한다. */
  id?: number;
  jobId: string;
  jobSnapshot: string;
  title: string;
  doneCriteria: string;
  dueAt: DateTime | null;
  planDate: PlanDate;
  createdAt: DateTime;
}

export class GoalRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  findById(goalId: number): Goal | undefined {
    return this.#db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as Goal | undefined;
  }

  create(goal: NewGoal): number {
    const result = this.#db
      .prepare(
        `INSERT INTO goals (id, job_id, job_snapshot, title, done_criteria, due_at, plan_date, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        goal.id ?? null,
        goal.jobId,
        goal.jobSnapshot,
        goal.title,
        goal.doneCriteria,
        goal.dueAt && toDbTime(goal.dueAt),
        goal.planDate,
        toDbTime(goal.createdAt),
      );
    return Number(result.lastInsertRowid);
  }

  findActive(): Goal[] {
    return this.#db
      .prepare("SELECT * FROM goals WHERE state = 'active' ORDER BY id")
      .all() as unknown as Goal[];
  }

  maxId(): number {
    const row = this.#db.prepare("SELECT MAX(id) AS id FROM goals").get() as { id: number | null };
    return row.id ?? 0;
  }

  update(goalId: number, changes: { progress?: string; dueAt?: DateTime }): void {
    if (changes.progress !== undefined) {
      this.#db.prepare("UPDATE goals SET progress = ? WHERE id = ?").run(changes.progress, goalId);
    }
    if (changes.dueAt !== undefined) {
      this.#db
        .prepare("UPDATE goals SET due_at = ? WHERE id = ?")
        .run(toDbTime(changes.dueAt), goalId);
    }
  }

  close(
    goalId: number,
    state: Exclude<GoalState, "active">,
    reason: string,
    closedAt: DateTime,
  ): void {
    this.#db
      .prepare(
        "UPDATE goals SET state = ?, end_reason = ?, closed_at = ? WHERE id = ? AND state = 'active'",
      )
      .run(state, reason, toDbTime(closedAt), goalId);
  }

  /** I3: 자신을 `goal_ids`에 포함한 개시 예약이 하나도 없는 활성 목표. */
  findActiveWithoutOpening(planDate: PlanDate): Goal[] {
    return this.#db
      .prepare(
        `SELECT * FROM goals
         WHERE state = 'active' AND plan_date = ?
           AND id NOT IN (
             SELECT reservation_goals.goal_id FROM reservation_goals
             JOIN reservations ON reservations.id = reservation_goals.reservation_id
             WHERE reservations.kind = 'open')
         ORDER BY id`,
      )
      .all(planDate) as unknown as Goal[];
  }

  hasActiveBefore(planDate: PlanDate): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM goals WHERE state = 'active' AND plan_date < ?")
        .get(planDate) !== undefined
    );
  }

  areAllClosed(goalIds: number[]): boolean {
    const placeholders = goalIds.map(() => "?").join(", ");
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS active FROM goals WHERE state = 'active' AND id IN (${placeholders})`,
      )
      .get(...goalIds) as { active: number };
    return row.active === 0;
  }

  expireActiveBefore(planDate: PlanDate, closedAt: DateTime): number {
    const result = this.#db
      .prepare(
        `UPDATE goals SET state = 'expired', end_reason = '날 넘김', closed_at = ?
         WHERE state = 'active' AND plan_date < ?`,
      )
      .run(toDbTime(closedAt), planDate);
    return Number(result.changes);
  }
}
