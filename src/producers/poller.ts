import type { Update } from "grammy/types";
import type { HarnessContext } from "../worker/context.ts";

/** 저장했으면 true. 호출한 쪽이 루프를 깨운다. */
export function recordIncomingMessage(ctx: HarnessContext, update: Update): boolean {
  const message = update.message;
  if (!message || message.chat.id !== ctx.config.owner_chat_id) return false;
  if (message.text === undefined) return false;
  if (ctx.messages.hasTelegramUpdate(update.update_id)) return false;
  ctx.messages.recordUserMessage({
    flowId: ctx.flows.findOpen()?.id ?? null,
    content: message.text,
    receivedAt: ctx.clock.now(),
    telegramUpdateId: update.update_id,
    telegramMessageId: message.message_id,
  });
  return true;
}
