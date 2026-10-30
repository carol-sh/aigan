export type TurnTask =
  | { kind: "turn"; trigger: "continue" | "reply"; flowId: number }
  | { kind: "turn"; trigger: "open"; reservationId: number }
  | { kind: "turn"; trigger: "user" };

export interface CleanupTask {
  kind: "cleanup";
  flowId: number;
}

export interface PlanTask {
  kind: "plan";
}

export type LlmTask = TurnTask | CleanupTask | PlanTask;

export type HarnessTask =
  | { kind: "resumePendingWork" }
  | { kind: "closeFlowForBlackout"; flowId: number }
  | { kind: "closePastPlanDays" }
  | { kind: "discardOpeningForClosedGoals"; reservationId: number }
  | { kind: "checkHoldRecovery" };

export type Task = HarnessTask | LlmTask;

export interface LlmTaskHandlers {
  turn(task: TurnTask): Promise<void>;
  cleanup(task: CleanupTask): Promise<void>;
  plan(task: PlanTask): Promise<void>;
}
