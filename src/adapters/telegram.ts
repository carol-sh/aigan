import { Api, GrammyError } from "grammy";
import type { Config } from "../config.ts";
import { type Telegram, TelegramError } from "../ports.ts";

/** 롱폴 30초에 여유를 둔다. */
const REQUEST_TIMEOUT_SEC = 60;

export function createTelegramApi(config: Config): Api {
  return new Api(config.bot_token, {
    apiRoot: config.telegram_api_root,
    timeoutSeconds: REQUEST_TIMEOUT_SEC,
  });
}

/** 주인 채팅 하나에만 말한다. 재시도와 429·403 처리는 하네스(`send.ts`)가 하고, 여기서는 오류의 모양만 옮긴다. */
export class BotTelegram implements Telegram {
  readonly #api: Api;
  readonly #chatId: number;

  constructor(api: Api, chatId: number) {
    this.#api = api;
    this.#chatId = chatId;
  }

  sendMessage(text: string): Promise<void> {
    return this.#call(() => this.#api.sendMessage(this.#chatId, text));
  }

  deleteMessage(messageId: number): Promise<void> {
    return this.#call(() => this.#api.deleteMessage(this.#chatId, messageId));
  }

  showTyping(): Promise<void> {
    return this.#call(() => this.#api.sendChatAction(this.#chatId, "typing"));
  }

  async #call(request: () => Promise<unknown>): Promise<void> {
    try {
      await request();
    } catch (error) {
      throw error instanceof GrammyError ? toTelegramError(error) : error;
    }
  }
}

export function toTelegramError(error: GrammyError): TelegramError {
  return new TelegramError(error.error_code, error.description, error.parameters.retry_after);
}
