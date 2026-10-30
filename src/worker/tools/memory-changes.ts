import type { MemoryRepository, MemoryWrite } from "../../db/repositories/memory.ts";

type MemoryChange =
  | { kind: "writeState"; content: string }
  | { kind: "writeSection"; title: string; content: string }
  | { kind: "deleteSection"; title: string };

/** 정리 도구가 바꾼 기억을 커밋 전까지 메모리에 모은다. 정리가 성공해야 완료 표시와 함께 반영한다. */
export class MemoryChanges {
  #state: string;
  readonly #sections: Map<string, string>;
  readonly #changes: MemoryChange[] = [];

  private constructor(state: string, sections: Map<string, string>) {
    this.#state = state;
    this.#sections = sections;
  }

  static load(memory: MemoryRepository): MemoryChanges {
    const sections = memory.listSections().map(({ title, content }) => [title, content] as const);
    return new MemoryChanges(memory.readState(), new Map(sections));
  }

  get state(): string {
    return this.#state;
  }

  get sectionCount(): number {
    return this.#sections.size;
  }

  readSection(title: string): string | undefined {
    return this.#sections.get(title);
  }

  hasSection(title: string): boolean {
    return this.#sections.has(title);
  }

  writeState(content: string): void {
    this.#state = content;
    this.#changes.push({ kind: "writeState", content });
  }

  writeSection(title: string, content: string): void {
    this.#sections.set(title, content);
    this.#changes.push({ kind: "writeSection", title, content });
  }

  deleteSection(title: string): void {
    this.#sections.delete(title);
    this.#changes.push({ kind: "deleteSection", title });
  }

  applyTo(memory: MemoryRepository, write: MemoryWrite): void {
    for (const change of this.#changes) {
      switch (change.kind) {
        case "writeState":
          memory.writeState(change.content, write);
          break;
        case "writeSection":
          memory.writeSection(change.title, change.content, write);
          break;
        case "deleteSection":
          memory.deleteSection(change.title);
          break;
      }
    }
  }
}
