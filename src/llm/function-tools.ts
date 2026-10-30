import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { ToolBox } from "../worker/tools/tool-box.ts";

export function toFunctionTools(tools: ToolBox): ChatCompletionFunctionTool[] {
  return tools.definitions.map(({ name, description, args }) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(args, { io: "input" });
    return {
      type: "function",
      function: { name, description, parameters: { ...parameters, additionalProperties: false } },
    };
  });
}
