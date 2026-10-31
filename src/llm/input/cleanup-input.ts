import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Flow } from "../../db/repositories/flows.ts";
import type { Goal } from "../../db/repositories/goals.ts";
import type { Message } from "../../db/repositories/messages.ts";
import { fromDbTime } from "../../time.ts";
import type { HarnessContext } from "../../worker/context.ts";
import { formatLocalTime } from "../../worker/reservation-times.ts";
import { countChars, viewCompactedConversation } from "../../worker/compact.ts";
import {
  type ConversationView,
  type MemoryView,
  NONE,
  type TimeView,
  renderConversation,
  renderMemory,
  renderSection,
  viewMemory,
} from "./transcript.ts";

export interface CleanupInput {
  flow: Flow;
  memory: MemoryView;
  goals: { goal: Goal; isInFlow: boolean }[];
  conversation: ConversationView;
}

export function assembleCleanupInput(ctx: HarnessContext, flowId: number): CleanupInput {
  const flow = ctx.flows.findById(flowId)!;
  return {
    flow,
    // 쓰기가 통째 교체라 읽지 않고 쓰면 누적 기록이 사라진다. 정리는 칸을 다시 쓰는 일이라 본문을 다 준다.
    memory: viewMemory(ctx.memory, () => true),
    goals: ctx.goals
      .findForCleanup(flow.id, flow.plan_date)
      .map(({ is_in_flow, ...goal }) => ({ goal, isInFlow: is_in_flow === 1 })),
    conversation: chooseConversationForCleanup(flow, ctx.messages.findShownInFlow(flow.id), ctx),
  };
}

/** 압축이 버린 세부도 기록에는 필요하므로 원문을 준다. 원문이 너무 길 때만 턴과 같은 압축본으로 바꾼다. */
function chooseConversationForCleanup(
  flow: Flow,
  shownMessages: Message[],
  ctx: HarnessContext,
): ConversationView {
  if (countChars(shownMessages) <= ctx.config.cleanup_raw_max_chars) {
    return { summary: undefined, messages: shownMessages };
  }
  return viewCompactedConversation(flow, shownMessages);
}

export function renderCleanupInput(
  input: CleanupInput,
  cleanupRules: string,
  view: TimeView,
): ChatCompletionMessageParam[] {
  const document = [
    renderSection("기억", renderMemory(input.memory)),
    renderSection("흐름", renderFlow(input.flow, view.timezone)),
    renderSection(`목표 (계획일 ${input.flow.plan_date})`, input.goals.map(renderGoal)),
    renderSection("대화", renderConversation(input.conversation, view)),
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
