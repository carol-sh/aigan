import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Flow } from "../../db/repositories/flows.ts";
import type { Goal } from "../../db/repositories/goals.ts";
import type { Message } from "../../db/repositories/messages.ts";
import { fromDbTime } from "../../time.ts";
import type { HarnessContext } from "../../worker/context.ts";
import { formatLocalTime } from "../../worker/reservation-times.ts";
import { NONE, type TimeView, renderMemory, renderMessages, renderSection } from "./transcript.ts";

export interface CleanupInput {
  flow: Flow;
  memory: { state: string; sectionTitles: string[] };
  goals: { goal: Goal; isInFlow: boolean }[];
  messages: Message[];
}

export function assembleCleanupInput(ctx: HarnessContext, flowId: number): CleanupInput {
  const flow = ctx.flows.findById(flowId)!;
  return {
    flow,
    memory: {
      state: ctx.memory.readState(),
      sectionTitles: ctx.memory.listSections().map((section) => section.title),
    },
    goals: ctx.goals
      .findForCleanup(flow.id, flow.plan_date)
      .map(({ is_in_flow, ...goal }) => ({ goal, isInFlow: is_in_flow === 1 })),
    messages: ctx.messages.findShownInFlow(flow.id),
  };
}

export function renderCleanupInput(
  input: CleanupInput,
  cleanupRules: string,
  view: TimeView,
): ChatCompletionMessageParam[] {
  const document = [
    renderSection("기억", renderMemory(input.memory.state, input.memory.sectionTitles)),
    renderSection("흐름", renderFlow(input.flow, view.timezone)),
    renderSection(`목표 (계획일 ${input.flow.plan_date})`, input.goals.map(renderGoal)),
    renderSection("대화", renderMessages(input.messages, view)),
    renderSection("지금", [formatLocalTime(view.now, view.timezone)]),
  ].join("\n\n");

  return [
    { role: "system", content: cleanupRules },
    { role: "user", content: document },
  ];
}

function renderFlow(flow: Flow, timezone: string): string[] {
  const opener = flow.opener === "ai" ? `AI(개시 의도: ${flow.opened_intent ?? NONE})` : "사용자";
  const startedAt = formatLocalTime(fromDbTime(flow.started_at), timezone);
  const endedAt = flow.ended_at ? formatLocalTime(fromDbTime(flow.ended_at), timezone) : NONE;
  return [`개시: ${opener}`, `시작: ${startedAt} / 종료: ${endedAt} (${flow.end_reason ?? NONE})`];
}

function renderGoal({ goal, isInFlow }: CleanupInput["goals"][number]): string {
  const headline = [
    `- #${goal.id} ${goal.title} (${goal.job_id}) [${goal.state}]`,
    goal.end_reason,
    isInFlow && "— 이 흐름에서 다룸",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    headline,
    `  완료 조건: ${goal.done_criteria || NONE}`,
    `  진행 메모: ${goal.progress || NONE}`,
  ].join("\n");
}
