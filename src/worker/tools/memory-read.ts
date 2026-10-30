import { z } from "zod";
import { type Tool, defineTool, rejected } from "./tool-box.ts";

export function memoryReadTool(readSection: (title: string) => string | undefined): Tool<unknown> {
  return defineTool({
    description: "기억 칸의 본문을 읽는다",
    args: z.object({ title: z.string() }),
    run({ title }) {
      const content = readSection(title.trim());
      if (content === undefined) return rejected(`기억 칸 "${title}"이 없다`);
      return { ok: true, content };
    },
  });
}
