import type { Logger } from "../ports.ts";

export class ConsoleLogger implements Logger {
  info(message: string): void {
    process.stdout.write(`${timestamp()} INFO ${message}\n`);
  }

  warn(message: string, cause?: unknown): void {
    process.stderr.write(`${timestamp()} WARN ${withCause(message, cause)}\n`);
  }

  error(message: string, cause?: unknown): void {
    process.stderr.write(`${timestamp()} ERROR ${withCause(message, cause)}\n`);
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function withCause(message: string, cause: unknown): string {
  if (cause === undefined) return message;
  const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  return `${message}: ${detail}`;
}
