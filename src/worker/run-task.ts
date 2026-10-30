import type { HarnessContext } from "./context.ts";
import { closeFlow, closePastPlanDays, discardOpeningForClosedGoals } from "./flow.ts";
import { checkHoldRecovery } from "./hold.ts";
import { resumePendingWork } from "./resume.ts";
import type { LlmTaskHandlers, Task } from "./tasks.ts";

export async function runTask(
  ctx: HarnessContext,
  llm: LlmTaskHandlers,
  task: Task,
): Promise<void> {
  switch (task.kind) {
    case "resumePendingWork":
      return resumePendingWork(ctx);
    case "closeFlowForBlackout":
      return closeFlow(ctx, task.flowId, "blackout");
    case "closePastPlanDays":
      return closePastPlanDays(ctx);
    case "discardOpeningForClosedGoals":
      return discardOpeningForClosedGoals(ctx, task.reservationId);
    case "checkHoldRecovery":
      return checkHoldRecovery(ctx);
    case "turn":
      return llm.turn(task);
    case "cleanup":
      return llm.cleanup(task);
    case "plan":
      return llm.plan(task);
  }
}
