import { z } from "zod";
import type { Config } from "../../config.ts";
import type { MemoryChanges } from "./memory-changes.ts";
import { memoryReadTool } from "./memory-read.ts";
import { ToolBox, defineTool, rejected } from "./tool-box.ts";

const SECTION_TITLE_MAX_CHARS = 100;

/** 앞뒤 공백을 지운 제목. 1–100자가 아니면 없다. */
export function normalizeSectionTitle(title: string): string | undefined {
  const trimmed = title.trim();
  const isValidLength = trimmed.length >= 1 && trimmed.length <= SECTION_TITLE_MAX_CHARS;
  return isValidLength ? trimmed : undefined;
}

export function createCleanupTools(config: Config, memory: MemoryChanges): ToolBox {
  return new ToolBox({
    memory_read: memoryReadTool((title) => memory.readSection(title)),

    state_write: defineTool({
      description: "state를 통째로 바꾼다",
      args: z.object({ content: z.string() }),
      run({ content }) {
        if (content.length > config.state_max_chars) {
          return rejected(`state는 ${config.state_max_chars}자까지다. 지금 ${content.length}자다`);
        }
        memory.writeState(content);
        return { ok: true };
      },
    }),

    memory_write: defineTool({
      description: "기억 칸을 통째로 바꾼다. 없으면 만든다",
      args: z.object({ title: z.string(), content: z.string() }),
      run(args) {
        const title = normalizeSectionTitle(args.title);
        if (title === undefined) {
          return rejected(`제목은 앞뒤 공백을 빼고 1–${SECTION_TITLE_MAX_CHARS}자여야 한다`);
        }
        if (args.content.trim() === "") {
          return rejected("본문이 비었다. 칸을 지우려면 memory_delete");
        }
        if (args.content.length > config.memory_section_max_chars) {
          return rejected(
            `칸 본문은 ${config.memory_section_max_chars}자까지다. 지금 ${args.content.length}자다`,
          );
        }
        if (!memory.hasSection(title) && memory.sectionCount >= config.memory_max_sections) {
          return rejected(
            `칸은 ${config.memory_max_sections}개까지다. 기존 칸에 합치거나 지운 뒤 만든다`,
          );
        }
        memory.writeSection(title, args.content);
        return { ok: true };
      },
    }),

    memory_delete: defineTool({
      description: "기억 칸을 지운다",
      args: z.object({ title: z.string() }),
      run(args) {
        const title = args.title.trim();
        if (!memory.hasSection(title)) return rejected(`기억 칸 "${args.title}"이 없다`);
        memory.deleteSection(title);
        return { ok: true };
      },
    }),
  });
}
