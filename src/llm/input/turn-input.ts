import type { DateTime } from "luxon";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Goal } from "../../db/repositories/goals.ts";
import type { Message } from "../../db/repositories/messages.ts";
import type { JobPolicy, Prompts } from "../../prompts.ts";
import { type PlanDate, fromDbTime } from "../../time.ts";
import type { HarnessContext } from "../../worker/context.ts";
import { formatLocalTime } from "../../worker/reservation-times.ts";
import { viewCompactedConversation } from "../../worker/compact.ts";
import type { TurnTask } from "../../worker/tasks.ts";
import {
  type ConversationView,
  NONE,
  type OpeningView,
  type TimeView,
  formatDuration,
  formatShortTime,
  renderConversation,
  renderMemory,
  renderMessages,
  renderOpening,
  renderSection,
} from "./transcript.ts";

/** 턴이 모델에게 보여 줄 것. 무엇을 고를지는 `assembleTurnInput`이, 어떻게 쓸지는 `renderTurnInput`이 정한다. */
export interface TurnInput {
  task: TurnTask;
  now: DateTime;
  endOfDay: DateTime;
  jobs: JobPolicy[];
  memory: { state: string; sectionTitles: string[] };
  planBody: string | undefined;
  previousFlowTail: { endedAt: DateTime; messages: Message[] } | undefined;
  flowConversation: ConversationView;
  activeGoals: { goal: Goal; openingIds: number[] }[];
  closedGoals: Goal[];
  openings: OpeningView[];
  outside: { omittedCount: number; messages: Message[] };
  openedIntent: string | undefined;
  scheduledAt: DateTime | undefined;
  /** 입력에 넣은 user 메시지의 최대 id. 턴은 여기까지 본 것으로 커밋한다. */
  lastShownUserMessageId: number;
}

export function assembleTurnInput(
  ctx: HarnessContext,
  task: TurnTask,
  planDate: PlanDate,
): TurnInput {
  const now = ctx.clock.now();
  const flow = "flowId" in task ? ctx.flows.findById(task.flowId) : undefined;
  const consumedOpening =
    task.trigger === "open" ? ctx.reservations.findById(task.reservationId) : undefined;
  const flowMessages = flow ? ctx.messages.findShownInFlow(flow.id) : [];
  const flowConversation: ConversationView = flow
    ? viewCompactedConversation(flow, flowMessages)
    : { summary: undefined, messages: [] };
  const outsideMessages = ctx.messages.findShownOutsideFlow();
  const outside = keepLatest(outsideMessages, ctx.config.outside_messages_max);
  const openings = listOpeningsForTurn(ctx, consumedOpening?.id);

  return {
    task,
    now,
    endOfDay: ctx.calendar.endOfDay(planDate),
    jobs: ctx.prompts.jobPolicies,
    memory: {
      state: ctx.memory.readState(),
      sectionTitles: ctx.memory.listSections().map((section) => section.title),
    },
    planBody: ctx.plans.findBody(planDate),
    previousFlowTail: findPreviousFlowTail(
      ctx,
      tailBaseTime(flowMessages[0] ?? outsideMessages[0], now),
    ),
    flowConversation,
    activeGoals: ctx.goals.findActive().map((goal) => ({
      goal,
      openingIds: openings
        .filter(({ goalIds }) => goalIds.includes(goal.id))
        .map(({ reservation }) => reservation.id),
    })),
    closedGoals: ctx.goals.findClosedOn(planDate),
    openings,
    outside,
    openedIntent: (consumedOpening?.intent ?? flow?.opened_intent) || undefined,
    scheduledAt: consumedOpening && fromDbTime(consumedOpening.at),
    lastShownUserMessageId: maxUserMessageId([...flowConversation.messages, ...outside.messages]),
  };
}

/** AI 개시 턴의 예약은 커밋이 지울 것이라 도구 검증처럼 이미 없는 것으로 보여 준다. */
function listOpeningsForTurn(
  ctx: HarnessContext,
  consumedOpeningId: number | undefined,
): TurnInput["openings"] {
  return ctx.reservations
    .findOpenings()
    .filter((reservation) => reservation.id !== consumedOpeningId)
    .map((reservation) => ({ reservation, goalIds: ctx.reservations.goalIdsOf(reservation.id) }));
}

function keepLatest(messages: Message[], limit: number): TurnInput["outside"] {
  const omittedCount = Math.max(0, messages.length - limit);
  return { omittedCount, messages: messages.slice(omittedCount) };
}

/**
 * 처리 시각이 아니라 메시지 시각으로 잰다. 블랙아웃 직전에 닫힌 흐름에 대한 답은 아침에 처리되는데,
 * 그 답이 무엇에 대한 말인지 알려면 꼬리가 필요하다.
 */
function tailBaseTime(firstMessage: Message | undefined, now: DateTime): DateTime {
  return firstMessage ? fromDbTime(firstMessage.ts) : now;
}

function findPreviousFlowTail(
  ctx: HarnessContext,
  baseTime: DateTime,
): TurnInput["previousFlowTail"] {
  const previous = ctx.flows.findLatestClosed();
  if (previous?.ended_at == null) return undefined;
  const endedAt = fromDbTime(previous.ended_at);
  if (endedAt <= baseTime.minus({ seconds: ctx.config.prev_flow_tail_max_age_sec })) {
    return undefined;
  }
  const messages = ctx.messages.findLastShownInFlow(
    previous.id,
    ctx.config.prev_flow_tail_messages,
  );
  return messages.length > 0 ? { endedAt, messages } : undefined;
}

function maxUserMessageId(messages: Message[]): number {
  return Math.max(0, ...messages.filter((m) => m.role === "user").map((m) => m.id));
}

/**
 * 흐름 안에서 바뀌지 않는 절을 앞에, 덧붙기만 하는 흐름 대화를 그다음에, 도구와 시각으로 바뀌는 절을 뒤에 둔다.
 * 그래야 같은 흐름의 다음 턴이 흐름 대화까지 prefix 캐시를 쓴다.
 */
export function renderTurnInput(
  input: TurnInput,
  prompts: Pick<Prompts, "persona" | "turnRules">,
  timezone: string,
): ChatCompletionMessageParam[] {
  const view: TimeView = { now: input.now, timezone };
  const document = [
    renderSection(
      "방침",
      input.jobs.map((job) => `- ${job.id}: ${job.description}`),
    ),
    renderSection("기억", renderMemory(input.memory.state, input.memory.sectionTitles)),
    renderSection("오늘 계획", [input.planBody ?? "(계획 전)"]),
    renderSection("직전 흐름", renderPreviousFlowTail(input.previousFlowTail, view)),
    renderSection("흐름 대화", renderConversation(input.flowConversation, view)),
    renderSection(
      "지금 활성 목표",
      input.activeGoals.map((goal) => renderActiveGoal(goal, timezone)),
    ),
    renderSection("오늘 종료된 목표", input.closedGoals.map(renderClosedGoal)),
    renderSection(
      "지금 개시 예약",
      input.openings.map((opening) => renderOpening(opening, timezone)),
    ),
    renderSection("흐름 밖 메시지", renderOutsideMessages(input.outside, view)),
    renderSection("이벤트", renderEvent(input, timezone)),
  ].join("\n\n");

  return [
    { role: "system", content: [prompts.persona, prompts.turnRules].filter(Boolean).join("\n\n") },
    { role: "user", content: document },
  ];
}

function renderPreviousFlowTail(tail: TurnInput["previousFlowTail"], view: TimeView): string[] {
  if (tail === undefined) return [];
  return [`${formatShortTime(tail.endedAt, view)} 종료`, ...renderMessages(tail.messages, view)];
}

function renderActiveGoal(
  { goal, openingIds }: TurnInput["activeGoals"][number],
  timezone: string,
): string {
  const facts = [
    goal.job_id,
    goal.due_at && `마감 ${formatLocalTime(fromDbTime(goal.due_at), timezone)}`,
    openingIds.length > 0 && `개시 예약 ${openingIds.map((id) => `#${id}`).join(", ")}`,
  ].filter(Boolean);
  return [
    `- #${goal.id} ${goal.title} (${facts.join(", ")})`,
    `  완료 조건: ${goal.done_criteria || NONE}`,
    `  진행 메모: ${goal.progress || NONE}`,
    "  방침 사본:",
    ...goal.job_snapshot.split("\n").map((line) => `    ${line}`),
  ].join("\n");
}

function renderClosedGoal(goal: Goal): string {
  return `- #${goal.id} ${goal.title} [${goal.state}] ${goal.end_reason ?? ""}`.trimEnd();
}

function renderOutsideMessages(outside: TurnInput["outside"], view: TimeView): string[] {
  const omitted =
    outside.omittedCount > 0 ? [`(이전 흐름 밖 메시지 ${outside.omittedCount}개 생략)`] : [];
  return outside.messages.length > 0 ? [...omitted, ...renderMessages(outside.messages, view)] : [];
}

function renderEvent(input: TurnInput, timezone: string): string[] {
  const scheduled =
    input.scheduledAt === undefined
      ? NONE
      : `${formatLocalTime(input.scheduledAt, timezone)} (${describeLateness(input.scheduledAt, input.now)})`;
  return [
    `계기: ${describeTrigger(input.task)}`,
    `개시 의도: ${input.openedIntent ?? NONE}`,
    `예정: ${scheduled}`,
    `지금: ${formatLocalTime(input.now, timezone)}`,
    `오늘의 끝: ${formatLocalTime(input.endOfDay, timezone)}`,
  ];
}

export function describeTrigger(task: TurnTask): string {
  switch (task.trigger) {
    case "open":
      return `AI 개시(개시 예약 #${task.reservationId})`;
    case "user":
      return "사용자 메시지(흐름 없음)";
    case "reply":
      return "사용자 답장";
    case "continue":
      return "이어가기";
  }
}

function describeLateness(scheduledAt: DateTime, now: DateTime): string {
  const lateMinutes = Math.floor(now.diff(scheduledAt).as("minutes"));
  if (lateMinutes < 1) return "제시간";
  return `${formatDuration(lateMinutes)} 늦음`;
}
