import type { CleanupDecider, CleanupRequest } from "../worker/cleanup.ts";
import type { HarnessContext } from "../worker/context.ts";
import { LlmConversation } from "./conversation.ts";
import { assembleCleanupInput, renderCleanupInput } from "./input/cleanup-input.ts";
import { parseCleanupOutput } from "./outputs.ts";

export class LlmCleanupDecider implements CleanupDecider {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  async decide({ flowId, tools }: CleanupRequest): Promise<void> {
    const ctx = this.#ctx;
    const conversation = new LlmConversation(ctx, {
      kind: "cleanup",
      flowId,
      messages: renderCleanupInput(assembleCleanupInput(ctx, flowId), ctx.prompts.cleanupRules!, {
        now: ctx.clock.now(),
        timezone: ctx.config.timezone,
      }),
      tools,
      maxToolRounds: ctx.config.max_cleanup_tool_rounds,
    });
    await conversation.ask(parseCleanupOutput);
  }
}
