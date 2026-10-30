import { inTransaction } from "../db/transaction.ts";
import { cleanupBackoffDelaySec } from "../time.ts";
import { holdIfOutOfBudget } from "./budget-gate.ts";
import type { HarnessContext } from "./context.ts";
import { alertOperator } from "./operator-alert.ts";
import type { CleanupTask } from "./tasks.ts";
import { createCleanupTools } from "./tools/cleanup-tools.ts";
import { MemoryChanges } from "./tools/memory-changes.ts";
import type { ToolBox } from "./tools/tool-box.ts";

export interface CleanupRequest {
  flowId: number;
  tools: ToolBox;
}

/** 닫힌 흐름을 보고 기억을 정리하는 쪽. 끝까지 돌면 성공, 던지면 실패다. */
export interface CleanupDecider {
  decide(request: CleanupRequest): Promise<void>;
}

export async function runCleanup(
  ctx: HarnessContext,
  decider: CleanupDecider,
  task: CleanupTask,
): Promise<void> {
  const flow = ctx.flows.findById(task.flowId)!;
  if (flow.cleanup_attempts >= ctx.config.cleanup_max_attempts) {
    await giveUpCleanup(ctx, flow.id);
    return;
  }
  if (await holdIfOutOfBudget(ctx)) return;
  const attempts = recordCleanupAttempt(ctx, flow.id, flow.cleanup_attempts + 1);

  const memory = MemoryChanges.load(ctx.memory);
  try {
    await decider.decide({ flowId: flow.id, tools: createCleanupTools(ctx.config, memory) });
  } catch (error) {
    ctx.logger.warn(`흐름 ${flow.id}의 정리가 실패했다(${attempts}번째)`, error);
    if (attempts >= ctx.config.cleanup_max_attempts) await giveUpCleanup(ctx, flow.id);
    return;
  }

  inTransaction(ctx.db, () => {
    memory.applyTo(ctx.memory, { flowId: flow.id, writtenAt: ctx.clock.now() });
    ctx.flows.finishCleanup(flow.id, "done");
  });
}

/** 시도를 io 전에 기록한다. 커밋 전에 죽어도 재시작이 백오프를 지키고, 시도 횟수에 들어간다. */
function recordCleanupAttempt(ctx: HarnessContext, flowId: number, attempt: number): number {
  const retryAt = ctx.clock.now().plus({ seconds: cleanupBackoffDelaySec(attempt, ctx.config) });
  return ctx.flows.recordCleanupAttempt(flowId, retryAt);
}

async function giveUpCleanup(ctx: HarnessContext, flowId: number): Promise<void> {
  ctx.flows.finishCleanup(flowId, "failed");
  await alertOperator(
    ctx,
    `흐름 ${flowId}의 정리를 포기했다(${ctx.config.cleanup_max_attempts}번 실패). 이 흐름의 기억 정리는 빠진다.`,
  );
}
