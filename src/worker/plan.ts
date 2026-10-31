import type { DateTime } from "luxon";
import { inTransaction } from "../db/transaction.ts";
import { type PlanDate, failureBackoffDelaySec } from "../time.ts";
import { holdIfOutOfBudget } from "./budget-gate.ts";
import type { HarnessContext } from "./context.ts";
import { fitOpeningTime, formatLocalTime } from "./reservation-times.ts";
import type { PlanTask } from "./tasks.ts";
import { createPlanTools } from "./tools/plan-tools.ts";
import type { ToolBox } from "./tools/tool-box.ts";

export interface PlanOutput {
  body: string;
  openings: { at: DateTime; intent: string; jobId?: string; goalIds: number[] }[];
}

export interface PlanRequest {
  planDate: PlanDate;
  tools: ToolBox;
}

/** 하루 구상과 개시 예약을 내는 쪽. 던지면 실패다. */
export interface PlanDecider {
  decide(request: PlanRequest): Promise<PlanOutput>;
}

export async function runPlan(
  ctx: HarnessContext,
  decider: PlanDecider,
  _task: PlanTask,
): Promise<void> {
  if (await holdIfOutOfBudget(ctx)) return;
  const attempts = recordPlanAttempt(ctx);
  const planDate = ctx.calendar.currentPlanDate(ctx.clock.now());

  let output: PlanOutput;
  try {
    output = await decider.decide({ planDate, tools: createPlanTools(ctx) });
  } catch (error) {
    ctx.logger.warn(`계획일 ${planDate}의 계획이 실패했다(${attempts}번째)`, error);
    return;
  }
  commitPlan(ctx, planDate, output);
}

/** 시도를 io 전에 기록한다. 커밋 전에 죽어도 재시작이 백오프를 지킨다. */
function recordPlanAttempt(ctx: HarnessContext): number {
  return inTransaction(ctx.db, () => {
    const attempts = ctx.harnessState.get().plan_attempts + 1;
    const retryAt = ctx.clock.now().plus({ seconds: failureBackoffDelaySec(attempts, ctx.config) });
    ctx.harnessState.recordPlanAttempt(retryAt);
    return attempts;
  });
}

/**
 * 계획은 날 넘김 뒤에 돌아 이전 계획의 예약은 이미 없다. 그래서 기존 예약을 건드리지 않고 더하기만 한다.
 * 어떤 목표의 예약도 사라지지 않으므로 되묻기와 I3 보정이 필요 없다.
 */
function commitPlan(ctx: HarnessContext, planDate: PlanDate, output: PlanOutput): void {
  const now = ctx.clock.now();
  inTransaction(ctx.db, () => {
    ctx.plans.save(planDate, output.body, now);
    const openings = fitOpenings(ctx, planDate, output.openings, now);
    const room = Math.max(0, ctx.config.open_max_pending - countOpeningsUnderLimit(ctx));
    for (const opening of openings.slice(0, room)) {
      ctx.reservations.scheduleOpening({
        ...opening,
        planDate,
        source: "plan",
        createdAt: now,
      });
    }
    for (const opening of openings.slice(room)) {
      logDroppedOpening(ctx, opening, `개시 예약 상한(${ctx.config.open_max_pending}개)`);
    }
    ctx.harnessState.markPlanned(planDate);
  });
}

/** 상한은 자른 시각 순으로 적용한다. 당겨진 과거 시각이 가장 이르므로 먼저 남는다. */
function fitOpenings(
  ctx: HarnessContext,
  planDate: PlanDate,
  openings: PlanOutput["openings"],
  now: DateTime,
): PlanOutput["openings"] {
  const activeGoalIds = new Set(
    ctx.goals
      .findActive()
      .filter((goal) => goal.plan_date === planDate)
      .map((goal) => goal.id),
  );
  const jobIds = new Set(ctx.prompts.jobPolicies.map((job) => job.id));
  const fitted: PlanOutput["openings"] = [];
  for (const opening of openings) {
    const time = fitOpeningTime(ctx, opening.at, planDate, now);
    if (!time.ok) {
      logDroppedOpening(ctx, opening, time.reason);
      continue;
    }
    const unknownGoalIds = opening.goalIds.filter((id) => !activeGoalIds.has(id));
    if (unknownGoalIds.length > 0) {
      ctx.logger.info(
        `계획 예약에서 활성 목표가 아닌 것을 뺐다(${unknownGoalIds.map((id) => `#${id}`).join(", ")}): ${describeOpening(ctx, opening)}`,
      );
    }
    const isKnownJob = opening.jobId === undefined || jobIds.has(opening.jobId);
    if (!isKnownJob) {
      ctx.logger.info(
        `계획 예약에서 없는 방침을 뺐다(${opening.jobId}): ${describeOpening(ctx, opening)}`,
      );
    }
    fitted.push({
      at: time.at,
      intent: opening.intent,
      jobId: isKnownJob ? opening.jobId : undefined,
      goalIds: opening.goalIds.filter((id) => activeGoalIds.has(id)),
    });
  }
  return fitted.sort((a, b) => a.at.toMillis() - b.at.toMillis());
}

function countOpeningsUnderLimit(ctx: HarnessContext): number {
  return ctx.reservations.findOpenings().filter((opening) => opening.source !== "harness").length;
}

function logDroppedOpening(
  ctx: HarnessContext,
  opening: PlanOutput["openings"][number],
  reason: string,
): void {
  ctx.logger.info(`계획 예약을 버렸다(${reason}): ${describeOpening(ctx, opening)}`);
}

function describeOpening(ctx: HarnessContext, opening: PlanOutput["openings"][number]): string {
  return `${formatLocalTime(opening.at, ctx.config.timezone)} ${opening.intent}`;
}
