import type { Update } from "grammy/types";
import type { Telegram } from "../../src/ports.ts";
import { OWNER_CHAT_ID } from "./config.ts";

type ScriptedFailure = Error | "hang";

export class FakeTelegram implements Telegram {
  readonly sent: string[] = [];
  readonly deleted: number[] = [];
  typingShownCount = 0;
  #scriptedFailures: ScriptedFailure[] = [];
  #scriptedDeleteFailures: ScriptedFailure[] = [];
  #nextUpdateId = 1;
  #nextMessageId = 1;

  /** 보낸 것 중 운영자 알림만. 앞의 표식은 뗀다. */
  get alerts(): string[] {
    return this.sent
      .filter((text) => text.startsWith("[aigan 알림] "))
      .map((text) => text.slice("[aigan 알림] ".length));
  }

  failNextSends(...failures: ScriptedFailure[]): void {
    this.#scriptedFailures.push(...failures);
  }

  async sendMessage(text: string): Promise<void> {
    const failure = this.#scriptedFailures.shift();
    if (failure === "hang") return new Promise(() => {});
    if (failure) throw failure;
    this.sent.push(text);
  }

  failNextDeletes(...failures: ScriptedFailure[]): void {
    this.#scriptedDeleteFailures.push(...failures);
  }

  async deleteMessage(messageId: number): Promise<void> {
    const failure = this.#scriptedDeleteFailures.shift();
    if (failure === "hang") return new Promise(() => {});
    if (failure) throw failure;
    this.deleted.push(messageId);
  }

  async showTyping(): Promise<void> {
    this.typingShownCount++;
  }

  textUpdate(text: string, chatId = OWNER_CHAT_ID): Update {
    return this.#update({ text, chat: privateChat(chatId) });
  }

  photoUpdate(): Update {
    return this.#update({
      photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
      chat: privateChat(OWNER_CHAT_ID),
    });
  }

  editedUpdate(messageId: number, text: string): Update {
    return {
      update_id: this.#nextUpdateId++,
      edited_message: {
        message_id: messageId,
        date: 0,
        edit_date: 0,
        chat: privateChat(OWNER_CHAT_ID),
        text,
      },
    } as Update;
  }

  repeat(update: Update): Update {
    return structuredClone(update);
  }

  #update(message: Record<string, unknown>): Update {
    return {
      update_id: this.#nextUpdateId++,
      message: { message_id: this.#nextMessageId++, date: 0, ...message },
    } as Update;
  }
}

function privateChat(id: number) {
  return { id, type: "private", first_name: "owner" };
}
