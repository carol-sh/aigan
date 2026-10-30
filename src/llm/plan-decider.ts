import type { HarnessContext } from "../worker/context.ts";
import type { PlanDecider, PlanOutput, PlanRequest } from "../worker/plan.ts";
import { LlmConversation } from "./conversation.ts";
import { assemblePlanInput, renderPlanInput } from "./input/plan-input.ts";
import { planOutputParser } from "./outputs.ts";

export class LlmPlanDecider implements PlanDecider {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  decide({ planDate, tools }: PlanRequest): Promise<PlanOutput> {
    const ctx = this.#ctx;
    const conversation = new LlmConversation(ctx, {
      kind: "plan",
      flowId: null,
      messages: renderPlanInput(
        assemblePlanInput(ctx, planDate),
        ctx.prompts.planRules,
        ctx.config.timezone,
      ),
      tools,
      maxToolRounds: ctx.config.max_tool_rounds,
    });
    return conversation.ask(planOutputParser(ctx.config.timezone));
  }
}
