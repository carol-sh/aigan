import type { Config } from "../config.ts";
import type { BalanceSource } from "../ports.ts";
import type { Connections } from "../worker/boot.ts";
import { createOpenAiChatClient } from "./openai-chat.ts";
import { BotTelegram, createTelegramApi } from "./telegram.ts";

export class UnsupportedProviderError extends Error {}

/** openai는 게이트가 잔액을 묻지 않는다(§6.3). 불리면 버그다. */
const balanceNotChecked: BalanceSource = {
  fetchBalance: () => Promise.reject(new Error("openai는 잔액을 확인하지 않는다")),
};

export function connectToServices(config: Config): Connections {
  if (config.provider === "deepseek") {
    throw new UnsupportedProviderError(
      "provider=deepseek는 아직 지원하지 않는다. 잔액 조회 어댑터가 없다",
    );
  }
  return {
    chat: createOpenAiChatClient(config),
    telegram: new BotTelegram(createTelegramApi(config), config.owner_chat_id),
    balance: balanceNotChecked,
  };
}
