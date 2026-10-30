import type { HarnessContext } from "../context.ts";
import { memoryReadTool } from "./memory-read.ts";
import { ToolBox } from "./tool-box.ts";

export function createPlanTools(ctx: HarnessContext): ToolBox {
  return new ToolBox({
    memory_read: memoryReadTool((title) => ctx.memory.findSection(title)?.content),
  });
}
