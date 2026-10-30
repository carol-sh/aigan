import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config.ts";
import { MemoryRepository } from "../db/repositories/memory.ts";
import { fromDbTime } from "../time.ts";
import { formatLocalTime } from "../worker/reservation-times.ts";

/** 서버가 돌고 있어도 된다(§9.10). 읽기 전용으로 열어 잠금도 마이그레이션도 하지 않는다. */
export function runMemory(dataDir: string): number {
  const dbPath = join(dataDir, "aigan.db");
  if (!existsSync(dbPath)) {
    process.stdout.write("아직 기억이 없다\n");
    return 0;
  }
  const timezone = readTimezone(dataDir);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const memory = new MemoryRepository(db);
    const state = memory.findState();
    const describeUpdate = (updatedAt: string | null, flowId: number | null) =>
      updatedAt === null
        ? ""
        : ` 갱신 ${formatLocalTime(fromDbTime(updatedAt), timezone)} (흐름 #${flowId})`;
    const blocks = [
      state.content === ""
        ? "[state] (비어 있음)"
        : `[state]${describeUpdate(state.updated_at, state.updated_by_flow_id)}\n${state.content}`,
      ...memory
        .listSections()
        .map(
          (section) =>
            `[${section.title}]${describeUpdate(section.updated_at, section.updated_by_flow_id)}\n${section.content}`,
        ),
    ];
    if (blocks.length === 1) blocks.push("(칸 없음)");
    process.stdout.write(`${blocks.join("\n\n")}\n`);
    return 0;
  } finally {
    db.close();
  }
}

/** 설정이 깨져 있어도 기억은 볼 수 있어야 해서, 읽지 못하면 UTC로 보여 준다. */
function readTimezone(dataDir: string): string {
  try {
    return loadConfig(join(dataDir, "config")).timezone;
  } catch {
    return "UTC";
  }
}
