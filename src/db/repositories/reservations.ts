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
  job_id: string | null;
  plan_date: PlanDate | null;
  source: ReservationSource;
  created_at: string;
}

export interface NewOpening {
  /** 턴이 도구 결과로 미리 알려 준 id. 없으면 SQLite가 정한다. */
  id?: number;
  at: DateTime;
  intent: string;
  /** 이 개입이 하는 방침. 그 흐름의 턴이 본문을 본다. */
  jobId?: string;
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
        `INSERT INTO reservations (id, kind, at, intent, job_id, plan_date, source, created_at)
         VALUES (?, 'open', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opening.id ?? null,
        toDbTime(opening.at),
        opening.intent,
        opening.jobId ?? null,
        opening.planDate,
        opening.source,
        toDbTime(opening.createdAt),
      );
    const reservationId = Number(result.lastInsertRowid);
    this.#linkGoals(reservationId, opening.goalIds);
    return reservationId;
  }

  /** `at`을 바꾸면 밀린 개입을 미루는 것이라 `scheduled`로 되돌린다. */
  updateOpening(
    reservationId: number,
    changes: { at?: DateTime; intent?: string; jobId?: string | null; goalIds?: number[] },
  ): void {
    if (changes.at !== undefined) {
      this.#db
        .prepare("UPDATE reservations SET at = ?, state = 'scheduled' WHERE id = ?")
        .run(toDbTime(changes.at), reservationId);
    }
    if (changes.intent !== undefined) {
      this.#db
        .prepare("UPDATE reservations SET intent = ? WHERE id = ?")
        .run(changes.intent, reservationId);
    }
    if (changes.jobId !== undefined) {
      this.#db
        .prepare("UPDATE reservations SET job_id = ? WHERE id = ?")
        .run(changes.jobId, reservationId);
    }
    if (changes.goalIds !== undefined) {
      this.#db.prepare("DELETE FROM reservation_goals WHERE reservation_id = ?").run(reservationId);
      this.#linkGoals(reservationId, changes.goalIds);
    }
  }

  findOpenings(): Reservation[] {
    return this.#db
      .prepare("SELECT * FROM reservations WHERE kind = 'open' ORDER BY at, id")
      .all() as unknown as Reservation[];
  }

  maxId(): number {
    const row = this.#db.prepare("SELECT MAX(id) AS id FROM reservations").get() as {
      id: number | null;
    };
    return row.id ?? 0;
  }

  #linkGoals(reservationId: number, goalIds: number[]): void {
    const linkGoal = this.#db.prepare(
      "INSERT INTO reservation_goals (reservation_id, goal_id) VALUES (?, ?)",
    );
    for (const goalId of goalIds) linkGoal.run(reservationId, goalId);
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
