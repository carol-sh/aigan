import { DateTime } from "luxon";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Goal } from "../../db/repositories/goals.ts";
import type { JobPolicy } from "../../prompts.ts";
import { type PlanDate, fromDbTime } from "../../time.ts";
import type { HarnessContext } from "../../worker/context.ts";
import { formatLocalTime } from "../../worker/reservation-times.ts";
import {
  type MemoryView,
  NONE,
  type OpeningView,
  type TimeView,
  formatShortTime,
  renderMemory,
  renderOpening,
  renderSection,
  viewMemory,
} from "./transcript.ts";

export interface PlanInput {
  planDate: PlanDate;
  now: DateTime;
  awakeFrom: DateTime;
  endOfDay: DateTime;
  jobs: JobPolicy[];
  memory: MemoryView;
  activeGoals: Goal[];
  recentlyClosedGoals: Goal[];
  previousPlanDate: PlanDate;
  openings: OpeningView[];
}

export function assemblePlanInput(ctx: HarnessContext, planDate: PlanDate): PlanInput {
  const now = ctx.clock.now();
  return {
    planDate,
    now,
    awakeFrom: ctx.calendar.blackoutEndOf(planDate),
    endOfDay: ctx.calendar.endOfDay(planDate),
    jobs: ctx.prompts.jobPolicies,
    // 하루 한 번이라 칸 본문을 다 넣어도 싸다. 배치는 사용자 기록을 보고 정해야 한다.
    memory: viewMemory(ctx.memory, () => true),
    activeGoals: ctx.goals.findActive(),
    recentlyClosedGoals: ctx.goals.findClosedSince(
      now.minus({ days: ctx.config.recent_goal_days }),
    ),
    previousPlanDate: DateTime.fromISO(planDate).minus({ days: 1 }).toISODate()!,
    openings: ctx.reservations
      .findOpenings()
      .map((reservation) => ({ reservation, goalIds: ctx.reservations.goalIdsOf(reservation.id) })),
  };
}

export function renderPlanInput(
  input: PlanInput,
  planRules: string,
  timezone: string,
): ChatCompletionMessageParam[] {
  const view: TimeView = { now: input.now, timezone };
  const document = [
    renderSection(
      "방침",
      input.jobs.map((job) => `- ${job.id}: ${job.description}`),
    ),
    renderSection("기억", renderMemory(input.memory)),
    renderSection(
      "활성 목표",
      input.activeGoals.map((goal) => renderActiveGoal(goal, timezone)),
    ),
    renderSection(
      "최근 종료 목표",
      input.recentlyClosedGoals.map((goal) =>
        renderClosedGoal(
          goal,
          goal.state === "expired" && goal.plan_date === input.previousPlanDate,
          view,
        ),
      ),
    ),
    renderSection(
      "남아 있는 개시 예약",
      input.openings.map((opening) => renderOpening(opening, timezone)),
    ),
    renderSection("계획일", [
      `계획일: ${input.planDate}`,
      `깨어 있는 구간: ${formatLocalTime(input.awakeFrom, timezone)} – ${formatLocalTime(input.endOfDay, timezone)}`,
      `지금: ${formatLocalTime(input.now, timezone)}`,
    ]),
  ].join("\n\n");

  return [
    { role: "system", content: planRules },
    { role: "user", content: document },
  ];
}

function renderActiveGoal(goal: Goal, timezone: string): string {
  const facts = [
    goal.job_id,
    goal.due_at && `마감 ${formatLocalTime(fromDbTime(goal.due_at), timezone)}`,
  ].filter(Boolean);
  return [
    `- #${goal.id} ${goal.title} (${facts.join(", ")})`,
    `  완료 조건: ${goal.done_criteria || NONE}`,
    `  진행 메모: ${goal.progress || NONE}`,
  ].join("\n");
}

/** 직전 계획일에 끝내지 못하고 만료된 목표는 어디까지 했는지가 오늘 이어 갈지 정하는 근거라 진행 메모도 보인다. */
function renderClosedGoal(goal: Goal, isShowingProgress: boolean, view: TimeView): string {
  const closedAt = formatShortTime(fromDbTime(goal.closed_at!), view);
  const headline = [
    `- #${goal.id} ${goal.title} (${goal.job_id}) [${goal.state}]`,
    goal.end_reason,
    `— ${closedAt} 종료`,
  ]
    .filter(Boolean)
    .join(" ");
  return isShowingProgress ? `${headline}\n  진행 메모: ${goal.progress || NONE}` : headline;
}
