import type { Logger } from "../../src/ports.ts";

export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  readonly errors: unknown[] = [];

  info(message: string): void {
    this.lines.push(`info ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }

  error(message: string, cause?: unknown): void {
    this.lines.push(`error ${message}`);
    this.errors.push(cause ?? message);
  }
}
