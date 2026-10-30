import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { type PlanDate, fromDbTime, toDbTime } from "../../time.ts";

export type ReservationSource = "turn" | "plan" | "harness";

export interface Reservation {
  id: number;
  kind: "continue" | "open";
  at: string;
  state: "scheduled" | "fired";
  flow_id: number | null;
  intent: string | null;
  plan_date: PlanDate | null;
  source: ReservationSource;
  created_at: string;
}

export interface NewOpening {
  at: DateTime;
  intent: string;
  planDate: PlanDate;
  source: ReservationSource;
  goalIds: number[];
  createdAt: DateTime;
}

export class ReservationRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  findById(reservationId: number): Reservation | undefined {
    return this.#db.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId) as
      | Reservation
      | undefined;
  }

  findContinue(flowId: number): Reservation | undefined {
    return this.#db
      .prepare("SELECT * FROM reservations WHERE kind = 'continue' AND flow_id = ?")
      .get(flowId) as Reservation | undefined;
  }

  findFiredOpenings(): Reservation[] {
    return this.#db
      .prepare("SELECT * FROM reservations WHERE kind = 'open' AND state = 'fired' ORDER BY at, id")
      .all() as unknown as Reservation[];
  }

  goalIdsOf(reservationId: number): number[] {
    const rows = this.#db
      .prepare("SELECT goal_id FROM reservation_goals WHERE reservation_id = ? ORDER BY goal_id")
      .all(reservationId) as { goal_id: number }[];
    return rows.map((row) => row.goal_id);
  }

  earliestScheduledAt(): DateTime | undefined {
    const row = this.#db
      .prepare("SELECT MIN(at) AS at FROM reservations WHERE state = 'scheduled'")
      .get() as { at: string | null };
    return row.at === null ? undefined : fromDbTime(row.at);
  }

  fireDue(now: DateTime): number {
    const result = this.#db
      .prepare("UPDATE reservations SET state = 'fired' WHERE state = 'scheduled' AND at <= ?")
      .run(toDbTime(now));
    return Number(result.changes);
  }

  scheduleOpening(opening: NewOpening): number {
    const result = this.#db
      .prepare(
        `INSERT INTO reservations (kind, at, intent, plan_date, source, created_at)
         VALUES ('open', ?, ?, ?, ?, ?)`,
      )
      .run(
        toDbTime(opening.at),
        opening.intent,
        opening.planDate,
        opening.source,
        toDbTime(opening.createdAt),
      );
    const reservationId = Number(result.lastInsertRowid);
    const linkGoal = this.#db.prepare(
      "INSERT INTO reservation_goals (reservation_id, goal_id) VALUES (?, ?)",
    );
    for (const goalId of opening.goalIds) linkGoal.run(reservationId, goalId);
    return reservationId;
  }

  /** 이어가기 예약은 흐름당 하나라서, 있으면 새 시각으로 바꾸고 `scheduled`로 되돌린다. */
  scheduleContinue(
    flowId: number,
    at: DateTime,
    source: ReservationSource,
    createdAt: DateTime,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO reservations (kind, at, flow_id, source, created_at) VALUES ('continue', ?, ?, ?, ?)
         ON CONFLICT (flow_id) WHERE kind = 'continue'
         DO UPDATE SET at = excluded.at, state = 'scheduled', source = excluded.source`,
      )
      .run(toDbTime(at), flowId, source, toDbTime(createdAt));
  }

  delete(reservationId: number): void {
    this.#db.prepare("DELETE FROM reservations WHERE id = ?").run(reservationId);
  }

  deleteContinue(flowId: number): void {
    this.#db
      .prepare("DELETE FROM reservations WHERE kind = 'continue' AND flow_id = ?")
      .run(flowId);
  }

  hasOpeningsBefore(planDate: PlanDate): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM reservations WHERE kind = 'open' AND plan_date < ?")
        .get(planDate) !== undefined
    );
  }

  deleteOpeningsBefore(planDate: PlanDate): number {
    const result = this.#db
      .prepare("DELETE FROM reservations WHERE kind = 'open' AND plan_date < ?")
      .run(planDate);
    return Number(result.changes);
  }
}
