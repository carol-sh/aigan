import type { DateTime } from "luxon";
import type { PlanDate } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { hasTimeLeftForOpening } from "./reservation-times.ts";
import type { TurnTask } from "./tasks.ts";
import { TurnChanges, type WorkingGoal } from "./tools/turn-changes.ts";
import type { ToolBox } from "./tools/tool-box.ts";
import { createTurnTools } from "./tools/turn-tools.ts";
import { commitTurn } from "./turn-commit.ts";

export interface TurnOutput {
  messages: string[];
  next: { kind: "continue"; at?: DateTime } | { kind: "end" };
}

export interface TurnRequest {
  task: TurnTask;
  planDate: PlanDate;
  tools: ToolBox;
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

export class InvalidTurnOutputError extends Error {}

export async function runTurn(
  ctx: HarnessContext,
  decider: TurnDecider,
  task: TurnTask,
): Promise<void> {
  const planDate = ctx.calendar.currentPlanDate(ctx.clock.now());
  const lastSeenUserMessageId = ctx.messages.latestUserMessageId();
  const consumedOpeningId = task.trigger === "open" ? task.reservationId : undefined;
  const changes = TurnChanges.load(ctx, { consumedOpeningId });
  const conversation = decider.begin({
    task,
    planDate,
    tools: createTurnTools({ ctx, changes, planDate }),
  });

  let output: TurnOutput;
  try {
    output = checkedOutput(task, await conversation.decide());
  } catch (error) {
    ctx.logger.warn(`턴(${task.trigger})이 실패해 아무것도 바꾸지 않았다`, error);
    return;
  }

  const goalsWithoutNextCheck = leavesNoFlow(task, output)
    ? findGoalsWithoutNextCheck(ctx, output.messages.length > 0 ? changes : undefined, {
        planDate,
        consumedOpeningId,
      })
    : [];
  if (goalsWithoutNextCheck.length > 0) {
    output = await reconsiderOrKeep(ctx, conversation, task, output, goalsWithoutNextCheck);
  }

  commitTurn(ctx, { task, planDate, lastSeenUserMessageId, output, changes });
}

function checkedOutput(task: TurnTask, output: TurnOutput): TurnOutput {
  if (
    task.trigger === "continue" &&
    output.messages.length === 0 &&
    output.next.kind === "continue"
  ) {
    throw new InvalidTurnOutputError("이어가기 턴은 말 없이 이어갈 수 없다");
  }
  return output;
}

async function reconsiderOrKeep(
  ctx: HarnessContext,
  conversation: TurnConversation,
  task: TurnTask,
  firstOutput: TurnOutput,
  goalsWithoutNextCheck: WorkingGoal[],
): Promise<TurnOutput> {
  try {
    return checkedOutput(task, await conversation.reconsider(goalsWithoutNextCheck));
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
