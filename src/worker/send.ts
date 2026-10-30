import { inTransaction } from "../db/transaction.ts";
import { TelegramError } from "../ports.ts";
import { sleep } from "../time.ts";
import type { HarnessContext } from "./context.ts";

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const MAX_SEND_ATTEMPTS = 3;
const MAX_RATE_LIMIT_WAITS = 10;

type DeliveryOutcome = "delivered" | "failed" | "blockedByUser";

export async function sendOutbox(ctx: HarnessContext): Promise<void> {
  const sender = new PacedSender(ctx);
  for (const message of ctx.messages.findOutbox()) {
    const outcome = await sender.deliver(message.content);
    if (outcome === "blockedByUser") {
      enterBlockedHold(ctx);
      return;
    }
    if (outcome === "delivered") ctx.messages.markSent(message.id, ctx.clock.now());
    else ctx.messages.markUndelivered(message.id);
  }
}

export function splitForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current === "" ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== "") chunks.push(current);
    current = line;
    while (current.length > limit) {
      chunks.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current !== "" || chunks.length === 0) chunks.push(current);
  return chunks;
}

function enterBlockedHold(ctx: HarnessContext): void {
  const voided = inTransaction(ctx.db, () => {
    ctx.harnessState.enterHold("blocked", ctx.clock.now(), null);
    return ctx.messages.markAllOutboxUndelivered();
  });
  ctx.logger.warn(
    `사용자가 봇을 차단했다. 보낼 메시지 ${voided}개를 버리고 보류(blocked)에 들어간다`,
  );
}

class PacedSender {
  readonly #ctx: HarnessContext;
  #hasSentBefore = false;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  async deliver(text: string): Promise<DeliveryOutcome> {
    for (const chunk of splitForTelegram(text)) {
      const outcome = await this.#sendChunk(chunk);
      if (outcome !== "delivered") return outcome;
    }
    return "delivered";
  }

  async #sendChunk(chunk: string): Promise<DeliveryOutcome> {
    let failedAttempts = 0;
    let rateLimitWaits = 0;
    while (true) {
      await this.#waitBetweenMessages();
      try {
        await this.#ctx.telegram.sendMessage(chunk);
        return "delivered";
      } catch (error) {
        if (error instanceof TelegramError && error.isBlockedByUser) return "blockedByUser";
        if (
          error instanceof TelegramError &&
          error.isRateLimited &&
          rateLimitWaits < MAX_RATE_LIMIT_WAITS
        ) {
          rateLimitWaits += 1;
          await sleep(this.#ctx.clock, (error.retryAfterSec ?? 1) * 1000);
          continue;
        }
        failedAttempts += 1;
        this.#ctx.logger.warn(`전송 실패 ${failedAttempts}/${MAX_SEND_ATTEMPTS}: ${String(error)}`);
        if (failedAttempts >= MAX_SEND_ATTEMPTS) return "failed";
      }
    }
  }

  async #waitBetweenMessages(): Promise<void> {
    if (this.#hasSentBefore) await sleep(this.#ctx.clock, this.#ctx.config.send_interval_ms);
    this.#hasSentBefore = true;
  }
}
