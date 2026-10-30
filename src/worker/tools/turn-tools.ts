import type { DateTime } from "luxon";
import { z } from "zod";
import type { PlanDate } from "../../time.ts";
import type { HarnessContext } from "../context.ts";
import { fitOpeningTime, formatLocalTime, parseLocalTime } from "../reservation-times.ts";
import type { TurnChanges } from "./turn-changes.ts";
import { type ToolResult, ToolBox, defineTool, rejected } from "./tool-box.ts";
import { memoryReadTool } from "./memory-read.ts";

export interface TurnToolScope {
  ctx: HarnessContext;
  changes: TurnChanges;
  /** 턴이 시작할 때 고정한 계획일. 도구의 "오늘"은 모두 이 날이다. */
  planDate: PlanDate;
}

const localTime = z.string().describe("설정 시간대의 로컬 시각 YYYY-MM-DD HH:mm");
const goalIds = z.array(z.number().int());

export function createTurnTools(scope: TurnToolScope): ToolBox {
  const { ctx, changes, planDate } = scope;
  const now = () => ctx.clock.now();

  return new ToolBox({
    job_read: defineTool({
      description: "방침 본문을 읽는다",
      args: z.object({ job_id: z.string() }),
      run({ job_id }) {
        const job = findJob(scope, job_id);
        if (job === undefined) return rejected(`방침 ${job_id}가 없다`);
        return { ok: true, prompt: job.prompt };
      },
    }),

    memory_read: memoryReadTool((title) => ctx.memory.findSection(title)?.content),

    goal_create: defineTool({
      description: "방침에서 목표를 만든다",
      args: z.object({
        job_id: z.string(),
        title: z.string().min(1),
        done_criteria: z.string(),
        due_at: localTime.optional(),
      }),
      run(args) {
        const job = findJob(scope, args.job_id);
        if (job === undefined) return rejected(`방침 ${args.job_id}가 없다`);
        if (changes.activeGoalCount >= ctx.config.goal_max_active) {
          return rejected(`활성 목표가 이미 상한(${ctx.config.goal_max_active}개)이다`);
        }
        const dueAt = parseDueAt(scope, args.due_at, planDate);
        if (dueAt instanceof Rejection) return dueAt.result;
        const goalId = changes.createGoal({
          jobId: job.id,
          jobSnapshot: job.prompt,
          title: args.title,
          doneCriteria: args.done_criteria,
          dueAt: dueAt ?? null,
          planDate,
          createdAt: now(),
        });
        return { ok: true, goal_id: goalId };
      },
    }),

    goal_update: defineTool({
      description: "활성 목표의 진행 메모나 마감을 바꾼다",
      args: z.object({
        goal_id: z.number().int(),
        progress: z.string().optional(),
        due_at: localTime.optional(),
      }),
      run(args) {
        const goal = changes.findActiveGoal(args.goal_id);
        if (goal === undefined) return rejected(`목표 ${args.goal_id}는 활성 목표가 아니다`);
        const dueAt = parseDueAt(scope, args.due_at, goal.planDate);
        if (dueAt instanceof Rejection) return dueAt.result;
        changes.updateGoal(goal.id, { progress: args.progress, dueAt });
        return { ok: true };
      },
    }),

    goal_close: defineTool({
      description: "활성 목표를 닫는다",
      args: z.object({
        goal_id: z.number().int(),
        result: z.enum(["done", "failed", "dropped"]),
        reason: z.string(),
      }),
      run(args) {
        const goal = changes.findActiveGoal(args.goal_id);
        if (goal === undefined) return rejected(`목표 ${args.goal_id}는 활성 목표가 아니다`);
        changes.closeGoal(goal.id, args.result, args.reason, now());
        return { ok: true };
      },
    }),

    open_reserve: defineTool({
      description: "새 흐름을 열 개시 예약을 잡는다",
      args: z.object({ at: localTime, intent: z.string().min(1), goal_ids: goalIds.default([]) }),
      run(args) {
        const goalsRejection = rejectInvalidGoalIds(scope, args.goal_ids);
        if (goalsRejection) return goalsRejection;
        if (changes.countOpeningsUnderLimit() >= ctx.config.open_max_pending) {
          return rejected(`대기 중인 개시 예약이 이미 상한(${ctx.config.open_max_pending}개)이다`);
        }
        const at = fitRequestedOpeningTime(scope, args.at);
        if (at instanceof Rejection) return at.result;
        const reservationId = changes.scheduleOpening({
          at,
          intent: args.intent,
          planDate,
          source: "turn",
          goalIds: args.goal_ids,
          createdAt: now(),
        });
        return {
          ok: true,
          reservation_id: reservationId,
          at: formatLocalTime(at, ctx.config.timezone),
        };
      },
    }),

    open_update: defineTool({
      description: "개시 예약의 시각·의도·겨냥한 목표를 바꾼다",
      args: z.object({
        reservation_id: z.number().int(),
        at: localTime.optional(),
        intent: z.string().min(1).optional(),
        goal_ids: goalIds.optional(),
      }),
      run(args) {
        if (changes.findOpening(args.reservation_id) === undefined) {
          return rejected(`${args.reservation_id}는 개시 예약이 아니다`);
        }
        if (args.at === undefined && args.intent === undefined && args.goal_ids === undefined) {
          return rejected("바꿀 필드가 없다");
        }
        const goalsRejection = args.goal_ids && rejectInvalidGoalIds(scope, args.goal_ids);
        if (goalsRejection) return goalsRejection;
        const at = args.at === undefined ? undefined : fitRequestedOpeningTime(scope, args.at);
        if (at instanceof Rejection) return at.result;
        changes.updateOpening(args.reservation_id, {
          at,
          intent: args.intent,
          goalIds: args.goal_ids,
        });
        return { ok: true };
      },
    }),

    open_cancel: defineTool({
      description: "개시 예약을 취소한다",
      args: z.object({ reservation_id: z.number().int() }),
      run({ reservation_id }) {
        if (changes.findOpening(reservation_id) === undefined) {
          return rejected(`${reservation_id}는 개시 예약이 아니다`);
        }
        changes.cancelOpening(reservation_id);
        return { ok: true };
      },
    }),
  });
}

class Rejection {
  readonly result: ToolResult;

  constructor(reason: string) {
    this.result = rejected(reason);
  }
}

function findJob({ ctx }: TurnToolScope, jobId: string) {
  return ctx.prompts.jobPolicies.find((job) => job.id === jobId);
}

function parseRequestedTime({ ctx }: TurnToolScope, text: string): DateTime | Rejection {
  return (
    parseLocalTime(text, ctx.config.timezone) ??
    new Rejection(`${text}는 YYYY-MM-DD HH:mm 형식의 시각이 아니다`)
  );
}

function parseDueAt(
  scope: TurnToolScope,
  text: string | undefined,
  goalPlanDate: PlanDate,
): DateTime | undefined | Rejection {
  if (text === undefined) return undefined;
  const dueAt = parseRequestedTime(scope, text);
  if (dueAt instanceof Rejection) return dueAt;
  const { calendar, config } = scope.ctx;
  const wakingStart = calendar.blackoutEndOf(goalPlanDate);
  const wakingEnd = calendar.endOfDay(goalPlanDate);
  if (dueAt < wakingStart || dueAt >= wakingEnd) {
    const window = `${formatLocalTime(wakingStart, config.timezone)} ~ ${formatLocalTime(wakingEnd, config.timezone)}`;
    return new Rejection(`마감은 그날 깨어 있는 구간(${window}) 안이어야 한다`);
  }
  return dueAt;
}

function fitRequestedOpeningTime(scope: TurnToolScope, text: string): DateTime | Rejection {
  const requestedAt = parseRequestedTime(scope, text);
  if (requestedAt instanceof Rejection) return requestedAt;
  const fitted = fitOpeningTime(scope.ctx, requestedAt, scope.planDate, scope.ctx.clock.now());
  return fitted.ok ? fitted.at : new Rejection(fitted.reason);
}

function rejectInvalidGoalIds(scope: TurnToolScope, ids: number[]): ToolResult | undefined {
  const invalidIds = ids.filter(
    (id) => scope.changes.findActiveGoal(id)?.planDate !== scope.planDate,
  );
  if (invalidIds.length === 0) return undefined;
  return rejected(`목표 ${invalidIds.join(", ")}는 오늘의 활성 목표가 아니다`);
}
