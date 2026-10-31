import type { DateTime } from "luxon";
import type { GoalState, NewGoal } from "../../db/repositories/goals.ts";
import type { Repositories } from "../../db/repositories/index.ts";
import type { NewOpening, ReservationSource } from "../../db/repositories/reservations.ts";
import { type PlanDate, fromDbTime } from "../../time.ts";

export interface WorkingGoal {
  id: number;
  title: string;
  planDate: PlanDate;
}

export interface WorkingOpening {
  id: number;
  at: DateTime;
  goalIds: number[];
  source: ReservationSource;
}

export interface OpeningChanges {
  at?: DateTime;
  intent?: string;
  /** null은 방침을 뗀다. */
  jobId?: string | null;
  goalIds?: number[];
}

type ClosedGoalState = Exclude<GoalState, "active">;

type TurnChange =
  | { kind: "createGoal"; goal: NewGoal & { id: number } }
  | { kind: "updateGoal"; goalId: number; progress?: string; dueAt?: DateTime }
  | {
      kind: "closeGoal";
      goalId: number;
      state: ClosedGoalState;
      reason: string;
      closedAt: DateTime;
    }
  | { kind: "scheduleOpening"; opening: NewOpening & { id: number } }
  | { kind: "updateOpening"; reservationId: number; changes: OpeningChanges }
  | { kind: "cancelOpening"; reservationId: number };

/**
 * 턴 도구가 바꾼 것을 커밋 전까지 메모리에 모은다. 다음 도구 라운드는 바뀐 상태를 읽고,
 * 말한 턴의 커밋이 순서대로 저장소에 반영한다. io 동안 DB 트랜잭션을 열어 두면 그사이 폴러가
 * 넣은 메시지까지 말 없는 턴과 함께 되돌아가기 때문이다.
 */
export class TurnChanges {
  readonly #activeGoals: Map<number, WorkingGoal>;
  readonly #openings: Map<number, WorkingOpening>;
  readonly #changes: TurnChange[] = [];
  readonly #touchedGoalIds = new Set<number>();
  #nextGoalId: number;
  #nextReservationId: number;

  private constructor(
    activeGoals: WorkingGoal[],
    openings: WorkingOpening[],
    maxGoalId: number,
    maxReservationId: number,
  ) {
    this.#activeGoals = new Map(activeGoals.map((goal) => [goal.id, goal]));
    this.#openings = new Map(openings.map((opening) => [opening.id, opening]));
    this.#nextGoalId = maxGoalId + 1;
    this.#nextReservationId = maxReservationId + 1;
  }

  /**
   * AI 개시 턴은 자기 개시 예약을 이미 지운 것으로 본다. 커밋이 어차피 지우므로 상한 집계에 넣으면
   * 상한이 하나 줄고(L5), 고치거나 취소할 대상도 아니다.
   *
   * 새 목표·예약 id는 지금의 최댓값 다음으로 미리 정해 도구 결과로 돌려준다. io 동안 목표·예약을
   * 넣는 쪽은 이 턴뿐이라(폴러는 메시지, 타이머는 예약 상태만 바꾼다) 커밋 때 그 id가 비어 있다.
   */
  static load(repos: Repositories, options: { consumedOpeningId?: number } = {}): TurnChanges {
    const activeGoals = repos.goals
      .findActive()
      .map((goal) => ({ id: goal.id, title: goal.title, planDate: goal.plan_date }));
    const openings = repos.reservations
      .findOpenings()
      .filter((opening) => opening.id !== options.consumedOpeningId)
      .map((opening) => ({
        id: opening.id,
        at: fromDbTime(opening.at),
        goalIds: repos.reservations.goalIdsOf(opening.id),
        source: opening.source,
      }));
    return new TurnChanges(activeGoals, openings, repos.goals.maxId(), repos.reservations.maxId());
  }

  get hasChanges(): boolean {
    return this.#changes.length > 0;
  }

  /** 흐름의 방침이 비어 있으면 이 방침으로 정한다. */
  get firstCreatedGoalJobId(): string | undefined {
    const created = this.#changes.find((change) => change.kind === "createGoal");
    return created?.kind === "createGoal" ? created.goal.jobId : undefined;
  }

  get activeGoalCount(): number {
    return this.#activeGoals.size;
  }

  findActiveGoal(goalId: number): WorkingGoal | undefined {
    return this.#activeGoals.get(goalId);
  }

  findOpening(reservationId: number): WorkingOpening | undefined {
    return this.#openings.get(reservationId);
  }

  countOpeningsUnderLimit(): number {
    return [...this.#openings.values()].filter((opening) => opening.source !== "harness").length;
  }

  activeGoalsWithoutOpening(planDate: PlanDate): WorkingGoal[] {
    const coveredGoalIds = new Set([...this.#openings.values()].flatMap((o) => o.goalIds));
    return [...this.#activeGoals.values()].filter(
      (goal) => goal.planDate === planDate && !coveredGoalIds.has(goal.id),
    );
  }

  createGoal(goal: NewGoal): number {
    const id = this.#nextGoalId++;
    this.#activeGoals.set(id, { id, title: goal.title, planDate: goal.planDate });
    this.#record({ kind: "createGoal", goal: { ...goal, id } }, id);
    return id;
  }

  updateGoal(goalId: number, changes: { progress?: string; dueAt?: DateTime }): void {
    this.#record({ kind: "updateGoal", goalId, ...changes }, goalId);
  }

  closeGoal(goalId: number, state: ClosedGoalState, reason: string, closedAt: DateTime): void {
    this.#activeGoals.delete(goalId);
    this.#record({ kind: "closeGoal", goalId, state, reason, closedAt }, goalId);
  }

  scheduleOpening(opening: NewOpening): number {
    const id = this.#nextReservationId++;
    this.#openings.set(id, {
      id,
      at: opening.at,
      goalIds: opening.goalIds,
      source: opening.source,
    });
    this.#record({ kind: "scheduleOpening", opening: { ...opening, id } });
    return id;
  }

  updateOpening(reservationId: number, changes: OpeningChanges): void {
    const opening = this.#openings.get(reservationId)!;
    this.#openings.set(reservationId, {
      ...opening,
      at: changes.at ?? opening.at,
      goalIds: changes.goalIds ?? opening.goalIds,
    });
    this.#record({ kind: "updateOpening", reservationId, changes });
  }

  cancelOpening(reservationId: number): void {
    this.#openings.delete(reservationId);
    this.#record({ kind: "cancelOpening", reservationId });
  }

  applyTo(repos: Repositories, flowId: number): void {
    for (const change of this.#changes) applyChange(repos, change);
    for (const goalId of this.#touchedGoalIds) repos.flows.addGoal(flowId, goalId);
  }

  #record(change: TurnChange, touchedGoalId?: number): void {
    this.#changes.push(change);
    if (touchedGoalId !== undefined) this.#touchedGoalIds.add(touchedGoalId);
  }
}

function applyChange(repos: Repositories, change: TurnChange): void {
  switch (change.kind) {
    case "createGoal":
      repos.goals.create(change.goal);
      return;
    case "updateGoal":
      repos.goals.update(change.goalId, { progress: change.progress, dueAt: change.dueAt });
      return;
    case "closeGoal":
      repos.goals.close(change.goalId, change.state, change.reason, change.closedAt);
      return;
    case "scheduleOpening":
      repos.reservations.scheduleOpening(change.opening);
      return;
    case "updateOpening":
      repos.reservations.updateOpening(change.reservationId, change.changes);
      return;
    case "cancelOpening":
      repos.reservations.delete(change.reservationId);
      return;
  }
}
