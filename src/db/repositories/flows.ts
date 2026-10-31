import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { type PlanDate, fromDbTime, toDbTime } from "../../time.ts";

export type FlowEndReason = "agent" | "blackout" | "stale" | "failed";
export type CleanupStatus = "pending" | "done" | "failed" | "skipped";

export interface Flow {
  id: number;
  opener: "ai" | "user";
  opened_by_reservation_id: number | null;
  opened_intent: string | null;
  opened_job_id: string | null;
  plan_date: PlanDate;
  turn_count: number;
  answered_upto_id: number;
  started_at: string;
  ended_at: string | null;
  end_reason: FlowEndReason | null;
  cleanup_status: CleanupStatus | null;
  cleanup_attempts: number;
  cleanup_next_at: string | null;
  summary: string | null;
  compacted_until_id: number | null;
}

export interface NewFlow {
  opener: Flow["opener"];
  openedByReservationId: number | null;
  openedIntent: string | null;
  openedJobId: string | null;
  planDate: PlanDate;
  startedAt: DateTime;
}

export class FlowRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  findById(flowId: number): Flow | undefined {
    return this.#db.prepare("SELECT * FROM flows WHERE id = ?").get(flowId) as Flow | undefined;
  }

  findOpen(): Flow | undefined {
    return this.#db.prepare("SELECT * FROM flows WHERE ended_at IS NULL").get() as Flow | undefined;
  }

  findLatestClosed(): Flow | undefined {
    return this.#db
      .prepare(
        "SELECT * FROM flows WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC LIMIT 1",
      )
      .get() as Flow | undefined;
  }

  findOldestAwaitingCleanup(): Flow | undefined {
    return this.#db
      .prepare("SELECT * FROM flows WHERE cleanup_status = 'pending' ORDER BY ended_at, id LIMIT 1")
      .get() as Flow | undefined;
  }

  earliestCleanupRetryAt(): DateTime | undefined {
    const row = this.#db
      .prepare("SELECT MIN(cleanup_next_at) AS at FROM flows WHERE cleanup_status = 'pending'")
      .get() as { at: string | null };
    return row.at === null ? undefined : fromDbTime(row.at);
  }

  open(flow: NewFlow): number {
    const result = this.#db
      .prepare(
        `INSERT INTO flows (opener, opened_by_reservation_id, opened_intent, opened_job_id, plan_date, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        flow.opener,
        flow.openedByReservationId,
        flow.openedIntent,
        flow.openedJobId,
        flow.planDate,
        toDbTime(flow.startedAt),
      );
    return Number(result.lastInsertRowid);
  }

  recordTurn(flowId: number, answeredUptoId: number): void {
    this.#db
      .prepare(
        "UPDATE flows SET turn_count = turn_count + 1, answered_upto_id = MAX(answered_upto_id, ?) WHERE id = ?",
      )
      .run(answeredUptoId, flowId);
  }

  saveSummary(flowId: number, summary: string, compactedUntilId: number): void {
    this.#db
      .prepare("UPDATE flows SET summary = ?, compacted_until_id = ? WHERE id = ?")
      .run(summary, compactedUntilId, flowId);
  }

  close(
    flowId: number,
    reason: FlowEndReason,
    endedAt: DateTime,
    cleanupStatus: "pending" | "skipped",
  ): void {
    const cleanupNextAt = cleanupStatus === "pending" ? toDbTime(endedAt) : null;
    this.#db
      .prepare(
        `UPDATE flows SET ended_at = ?, end_reason = ?, cleanup_status = ?, cleanup_attempts = 0, cleanup_next_at = ?
         WHERE id = ?`,
      )
      .run(toDbTime(endedAt), reason, cleanupStatus, cleanupNextAt, flowId);
  }

  recordCleanupAttempt(flowId: number, nextAt: DateTime): number {
    const row = this.#db
      .prepare(
        `UPDATE flows SET cleanup_attempts = cleanup_attempts + 1, cleanup_next_at = ?
         WHERE id = ? RETURNING cleanup_attempts`,
      )
      .get(toDbTime(nextAt), flowId) as { cleanup_attempts: number };
    return row.cleanup_attempts;
  }

  finishCleanup(flowId: number, status: "done" | "failed"): void {
    this.#db
      .prepare("UPDATE flows SET cleanup_status = ?, cleanup_next_at = NULL WHERE id = ?")
      .run(status, flowId);
  }

  addGoal(flowId: number, goalId: number): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO flow_goals (flow_id, goal_id) VALUES (?, ?)")
      .run(flowId, goalId);
  }
}
