import type { Api } from "grammy";
import type { Update } from "grammy/types";
import type { Logger } from "../ports.ts";

const LONG_POLL_SEC = 30;

/** grammY는 Node용 AbortSignal 타입을 따로 둔다. 런타임에는 표준 AbortSignal을 받는다. */
type GrammySignal = Parameters<Api["getUpdates"]>[1];
const MAX_RETRY_DELAY_MS = 60_000;

export interface PollerOptions {
  /** 오류 뒤 첫 대기. 두 배씩 늘려 60초에서 멈춘다. */
  firstRetryDelayMs?: number;
}

/**
 * 오프셋은 저장하지 않는다. 텔레그램은 확인하지 않은 업데이트를 다시 주고, 같은 업데이트는
 * 수신 기록의 `tg_update_id` 중복 검사가 버린다. 그래서 재시작해도 잃거나 두 번 넣지 않는다.
 */
export class TelegramPoller {
  readonly #api: Api;
  readonly #logger: Logger;
  readonly #firstRetryDelayMs: number;
  readonly #abort = new AbortController();
  #isStopped = false;
  #stopped = Promise.resolve();

  constructor(api: Api, logger: Logger, options: PollerOptions = {}) {
    this.#api = api;
    this.#logger = logger;
    this.#firstRetryDelayMs = options.firstRetryDelayMs ?? 1000;
  }

  start(onUpdate: (update: Update) => void): void {
    this.#stopped = this.#pollUntilStopped(onUpdate);
  }

  /** 기다리던 롱폴을 바로 끊는다. */
  stop(): Promise<void> {
    this.#isStopped = true;
    this.#abort.abort();
    return this.#stopped;
  }

  async #pollUntilStopped(onUpdate: (update: Update) => void): Promise<void> {
    let offset = 0;
    let retryDelayMs = this.#firstRetryDelayMs;
    while (!this.#isStopped) {
      try {
        const updates = await this.#api.getUpdates(
          { offset, timeout: LONG_POLL_SEC, allowed_updates: ["message"] },
          this.#abort.signal as GrammySignal,
        );
        for (const update of updates) {
          onUpdate(update);
          offset = update.update_id + 1;
        }
        retryDelayMs = this.#firstRetryDelayMs;
      } catch (error) {
        if (this.#isStopped) return;
        this.#logger.warn(`텔레그램 업데이트를 받지 못했다. ${retryDelayMs}ms 뒤 다시 한다`, error);
        await this.#wait(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  #wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      this.#abort.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
