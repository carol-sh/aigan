import type { DateTime } from "luxon";
import { type TurnInput, assembleTurnInput } from "../llm/input/turn-input.ts";
import type { PlanDate } from "../time.ts";
import { holdIfOutOfBudget } from "./budget-gate.ts";
import { type CompactDecider, compactOpenFlowIfLong } from "./compact.ts";
import type { HarnessContext } from "./context.ts";
import { hasTimeLeftForOpening } from "./reservation-times.ts";
import { sendOutbox } from "./send.ts";
import type { TurnTask } from "./tasks.ts";
import { TurnChanges, type WorkingGoal } from "./tools/turn-changes.ts";
import type { ToolBox } from "./tools/tool-box.ts";
import { createTurnTools } from "./tools/turn-tools.ts";
import { deleteMessagesArrivedDuringIo, keepTypingDuring } from "./telegram-during-io.ts";
import { commitTurn, hasOpeningTurnRunIntoBlackout } from "./turn-commit.ts";
import { failTurn, recordTurnAttempt } from "./turn-failure.ts";

export interface TurnOutput {
  messages: string[];
  next: { kind: "continue"; at?: DateTime } | { kind: "end" };
}

export interface TurnRequest {
  task: TurnTask;
  planDate: PlanDate;
  tools: ToolBox;
  input: TurnInput;
}

/** 턴에서 무엇을 말하고 어떤 도구를 쓸지 정하는 쪽. 테스트는 각본, 실제로는 LLM이다. */
export interface TurnDecider {
  begin(request: TurnRequest): TurnConversation;
}

export interface TurnConversation {
  decide(): Promise<TurnOutput>;
  /** 같은 대화에 "이 목표들은 다음 확인이 없다"를 덧붙여 한 번 더 묻는다. */
  reconsider(goalsWithoutNextCheck: WorkingGoal[]): Promise<TurnOutput>;
}

export interface TurnDeciders {
  turn: TurnDecider;
  compact: CompactDecider;
}

export async function runTurn(
  ctx: HarnessContext,
  deciders: TurnDeciders,
  task: TurnTask,
): Promise<void> {
  if (await holdIfOutOfBudget(ctx)) return;
  await recordTurnAttempt(ctx);
  const planDate = ctx.calendar.currentPlanDate(ctx.clock.now());
  const input = assembleTurnInput(ctx, task, planDate);
  const lastMessageIdBeforeIo = ctx.messages.latestMessageId();
  const consumedOpeningId = task.trigger === "open" ? task.reservationId : undefined;
  const changes = TurnChanges.load(ctx, { consumedOpeningId });
  const conversation = deciders.turn.begin({
    task,
    planDate,
    tools: createTurnTools({ ctx, changes, planDate }),
    input,
  });

  const decide = () =>
    decideOutput(ctx, conversation, { task, planDate, changes, consumedOpeningId });
  let output: TurnOutput;
  try {
    output = isInFlowTurn(task) ? await keepTypingDuring(ctx, decide) : await decide();
  } catch (error) {
    await failTurn(ctx, { task, lastSeenUserMessageId: input.lastShownUserMessageId, error });
    return;
  }

  const busyMessageIds = willSpeak(ctx, task, output)
    ? await deleteMessagesArrivedDuringIo(ctx, lastMessageIdBeforeIo)
    : [];
  commitTurn(ctx, {
    task,
    planDate,
    lastSeenUserMessageId: input.lastShownUserMessageId,
    output,
    changes,
    busyMessageIds,
  });
  await sendOutbox(ctx);
  await compactOpenFlowIfLong(ctx, deciders.compact);
}

interface TurnInProgress {
  task: TurnTask;
  planDate: PlanDate;
  changes: TurnChanges;
  consumedOpeningId: number | undefined;
}

/** 결정하고 필요하면 한 번 되묻는다. 되묻기가 실패하면 첫 출력을 쓰고, 결정이 실패하면 던진다. */
async function decideOutput(
  ctx: HarnessContext,
  conversation: TurnConversation,
  turn: TurnInProgress,
): Promise<TurnOutput> {
  const output = await conversation.decide();

  const goalsWithoutNextCheck = leavesNoFlow(turn.task, output)
    ? findGoalsWithoutNextCheck(ctx, output.messages.length > 0 ? turn.changes : undefined, turn)
    : [];
  if (goalsWithoutNextCheck.length === 0) return output;
  return reconsiderOrKeep(ctx, conversation, output, goalsWithoutNextCheck);
}

/** 흐름이 없을 때의 판정·AI 개시 턴은 말할지 모르는 턴이라 입력 중 표시를 띄우지 않는다. */
function isInFlowTurn(task: TurnTask): boolean {
  return task.trigger === "continue" || task.trigger === "reply";
}

function willSpeak(ctx: HarnessContext, task: TurnTask, output: TurnOutput): boolean {
  return output.messages.length > 0 && !hasOpeningTurnRunIntoBlackout(ctx, task);
}

async function reconsiderOrKeep(
  ctx: HarnessContext,
  conversation: TurnConversation,
  firstOutput: TurnOutput,
  goalsWithoutNextCheck: WorkingGoal[],
): Promise<TurnOutput> {
  try {
    return await conversation.reconsider(goalsWithoutNextCheck);
  } catch (error) {
    ctx.logger.warn("되묻기가 실패해 첫 출력으로 커밋한다", error);
    return firstOutput;
  }
}

function leavesNoFlow(task: TurnTask, output: TurnOutput): boolean {
  const isOpeningTurn = task.trigger === "open" || task.trigger === "user";
  return output.next.kind === "end" || (isOpeningTurn && output.messages.length === 0);
}

/**
 * 이 출력을 커밋하면 흐름이 없어지는데 다음 확인이 없는 오늘의 활성 목표. 말 없는 출력은 도구 효과가
 * 버려지므로 효과 없는 상태로 본다. 그날 남은 시간이 없는 목표는 예약할 수 없으니 빼고 날 넘김에 맡긴다.
 */
function findGoalsWithoutNextCheck(
  ctx: HarnessContext,
  committedChanges: TurnChanges | undefined,
  turn: { planDate: PlanDate; consumedOpeningId: number | undefined },
): WorkingGoal[] {
  if (!hasTimeLeftForOpening(ctx, turn.planDate, ctx.clock.now())) return [];
  const changes =
    committedChanges ?? TurnChanges.load(ctx, { consumedOpeningId: turn.consumedOpeningId });
  return changes.activeGoalsWithoutOpening(turn.planDate);
}
