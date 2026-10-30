import type { DateTime } from "luxon";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";

export interface Clock {
  now(): DateTime;
  /** 런타임 타이머처럼 단조 시계를 따른다. 기기가 절전하면 멈출 수 있다. */
  setTimer(delayMs: number, onFire: () => void): CancelTimer;
}

export type CancelTimer = () => void;

export interface ChatClient {
  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
}

export interface Telegram {
  sendMessage(text: string): Promise<void>;
  deleteMessage(messageId: number): Promise<void>;
  showTyping(): Promise<void>;
}

export class TelegramError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | undefined;

  constructor(status: number, description: string, retryAfterSec?: number) {
    super(`telegram ${status}: ${description}`);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }

  get isBlockedByUser(): boolean {
    return this.status === 403;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, cause?: unknown): void;
}
