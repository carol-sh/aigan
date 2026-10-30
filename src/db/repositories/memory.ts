import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { toDbTime } from "../../time.ts";

export interface MemorySection {
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  updated_by_flow_id: number;
}

export interface MemoryWrite {
  flowId: number;
  writtenAt: DateTime;
}

export class MemoryRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  readState(): string {
    const row = this.#db.prepare("SELECT content FROM memory_state WHERE id = 1").get() as {
      content: string;
    };
    return row.content;
  }

  writeState(content: string, write: MemoryWrite): void {
    this.#db
      .prepare(
        "UPDATE memory_state SET content = ?, updated_at = ?, updated_by_flow_id = ? WHERE id = 1",
      )
      .run(content, toDbTime(write.writtenAt), write.flowId);
  }

  listSections(): MemorySection[] {
    return this.#db
      .prepare("SELECT * FROM memory_sections ORDER BY created_at, title")
      .all() as unknown as MemorySection[];
  }

  findSection(title: string): MemorySection | undefined {
    return this.#db.prepare("SELECT * FROM memory_sections WHERE title = ?").get(title) as
      | MemorySection
      | undefined;
  }

  writeSection(title: string, content: string, write: MemoryWrite): void {
    const writtenAt = toDbTime(write.writtenAt);
    this.#db
      .prepare(
        `INSERT INTO memory_sections (title, content, created_at, updated_at, updated_by_flow_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (title) DO UPDATE SET
           content = excluded.content, updated_at = excluded.updated_at,
           updated_by_flow_id = excluded.updated_by_flow_id`,
      )
      .run(title, content, writtenAt, writtenAt, write.flowId);
  }

  deleteSection(title: string): void {
    this.#db.prepare("DELETE FROM memory_sections WHERE title = ?").run(title);
  }
}
