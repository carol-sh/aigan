import type { CompactDecider, CompactRequest } from "../worker/compact.ts";
import type { HarnessContext } from "../worker/context.ts";
import { ToolBox } from "../worker/tools/tool-box.ts";
import { LlmConversation } from "./conversation.ts";
import { renderCompactInput } from "./input/compact-input.ts";
import { parseCompactOutput } from "./outputs.ts";

export class LlmCompactDecider implements CompactDecider {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  decide(request: CompactRequest): Promise<string> {
    const ctx = this.#ctx;
    const conversation = new LlmConversation(ctx, {
      kind: "compact",
      flowId: request.flowId,
      messages: renderCompactInput(request, ctx.prompts.compactRules!, {
        now: ctx.clock.now(),
        timezone: ctx.config.timezone,
      }),
      tools: new ToolBox({}),
      maxToolRounds: 0,
    });
    return conversation.ask(parseCompactOutput);
  }
}
