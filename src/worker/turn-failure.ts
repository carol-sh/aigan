import { inTransaction } from "../db/transaction.ts";
import { LlmCallError } from "../llm/conversation.ts";
import { describeTrigger } from "../llm/input/turn-input.ts";
import { turnBackoffDelaySec } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { closeFlow, scheduleFollowUpsForUncoveredGoals } from "./flow.ts";
import { alertOperator } from "./operator-alert.ts";
import { formatLocalTime } from "./reservation-times.ts";
import type { TurnTask } from "./tasks.ts";

/**
 * 시도를 io 전에 실패 한 번으로 기록해 두고, 성공 커밋이 지운다. io 뒤 커밋 전에 죽으면 실패 처리를
 * 거치지 않으므로, 실패 뒤에 세면 재시작 직후 같은 호출이 백오프 없이 다시 나간다. 자동 재시작과 만나면
 * 끝없이 과금된다. 연속 실패 알림도 여기서 검사해, `failTurn`을 거치지 않는 크래시 반복도 알린다.
 */
export async function recordTurnAttempt(ctx: HarnessContext): Promise<void> {
  const now = ctx.clock.now();
  const { failuresSoFar, retryAt } = inTransaction(ctx.db, () => {
    const failuresSoFar = ctx.harnessState.get().failure_count;
    const retryAt = now.plus({
      seconds: turnBackoffDelaySec(failuresSoFar + 1, ctx.config),
    });
    ctx.harnessState.recordTurnAttempt(retryAt);
    return { failuresSoFar, retryAt };
  });
  if (failuresSoFar === ctx.config.failure_alert_after) {
    await alertOperator(
      ctx,
      `턴이 ${failuresSoFar}번 연속 실패했다. 이번 시도가 실패하면 ${formatLocalTime(retryAt, ctx.config.timezone)} 뒤에 다시 한다.`,
    );
  }
}

export interface FailedTurn {
  task: TurnTask;
  lastSeenUserMessageId: number;
  error: unknown;
}

/**
 * 시작 때 올린 `failure_count`와 `turn_retry_at`은 그대로 두어 백오프를 지킨다. 출력 실패만 트리거 포기로
 * 센다. 같은 입력이면 다시 해도 같은 출력 실패가 나기 쉬워, 두면 그 작업 하나가 다른 일을 모두 막는다.
 * API 실패는 잠깐 죽은 것일 수 있어 백오프만 한다.
 */
export async function failTurn(ctx: HarnessContext, turn: FailedTurn): Promise<void> {
  const outputFailures = inTransaction(ctx.db, () => {
    if (!isOutputFailure(turn.error)) return undefined;
    const count = ctx.harnessState.countOutputFailure(triggerKeyOf(turn.task));
    if (count >= ctx.config.turn_max_attempts) {
      giveUpTrigger(ctx, turn);
      ctx.harnessState.clearOutputFailures();
    }
    return count;
  });

  const trigger = describeTrigger(turn.task);
  const countNote =
    outputFailures === undefined
      ? ""
      : ` 출력 실패 ${outputFailures}/${ctx.config.turn_max_attempts}`;
  ctx.logger.warn(`턴(${trigger})이 실패했다.${countNote}`, turn.error);
  if (outputFailures !== undefined && outputFailures >= ctx.config.turn_max_attempts) {
    await alertOperator(
      ctx,
      `턴(${trigger})을 포기했다. 출력 실패 ${outputFailures}번. 마지막 오류: ${errorMessage(turn.error)}`,
    );
  }
}

function isOutputFailure(error: unknown): boolean {
  return error instanceof LlmCallError && error.isOutputFailure;
}

function triggerKeyOf(task: TurnTask): string {
  switch (task.trigger) {
    case "open":
      return `open:${task.reservationId}`;
    case "user":
      return "user";
    case "continue":
    case "reply":
      return `flow:${task.flowId}`;
  }
}

/** 트리거만 버린다. 판정 대기는 이 턴이 본 것까지만 무시한다. io 중에 온 것은 다음 판정을 받는다. */
function giveUpTrigger(ctx: HarnessContext, { task, lastSeenUserMessageId }: FailedTurn): void {
  switch (task.trigger) {
    case "open":
      ctx.reservations.delete(task.reservationId);
      scheduleFollowUpsForUncoveredGoals(ctx);
      return;
    case "user":
      ctx.messages.markPendingIgnoredUpTo(lastSeenUserMessageId);
      return;
    case "continue":
    case "reply":
      closeFlow(ctx, task.flowId, "failed");
      return;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
