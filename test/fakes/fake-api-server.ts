import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Update } from "grammy/types";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

export interface TelegramFailure {
  status: number;
  description: string;
  parameters?: Record<string, unknown>;
}

export type ChatReply = ChatCompletion | { status: number; body: unknown };
export type ChatResponder = (params: ChatCompletionCreateParamsNonStreaming) => ChatReply;

/** 빈 롱폴을 붙잡아 두는 시간. 실제 30초 대신 짧게 둬서 테스트가 빨리 끝난다. */
const EMPTY_POLL_HOLD_MS = 50;

/**
 * 텔레그램 Bot API와 OpenAI Chat Completions 흉내를 한 포트에서 낸다. 받은 요청을 기록하고,
 * 다음 응답을 실패로 바꿀 수 있다. 어댑터와 `serve` 프로세스를 네트워크 없이 끝까지 돌리는 데 쓴다.
 */
export class FakeApiServer {
  readonly telegramCalls: TelegramCall[] = [];
  readonly chatRequests: {
    authorization: string | undefined;
    body: ChatCompletionCreateParamsNonStreaming;
  }[] = [];
  readonly #server = createServer((request, response) => void this.#handle(request, response));
  readonly #pendingUpdates: Update[] = [];
  readonly #telegramFailures = new Map<string, TelegramFailure[]>();
  readonly #chatReplies: ChatReply[] = [];
  #chatResponder: ChatResponder | undefined;
  #nextMessageId = 1000;
  #nextUpdateId = 1;

  static async start(): Promise<FakeApiServer> {
    const server = new FakeApiServer();
    await new Promise<void>((resolve) => server.#server.listen(0, "127.0.0.1", resolve));
    return server;
  }

  get url(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  callsTo(method: string): Record<string, unknown>[] {
    return this.telegramCalls.filter((call) => call.method === method).map((call) => call.body);
  }

  /** 주인 채팅(또는 `chatId`)에서 온 텍스트 메시지 업데이트를 쌓는다. */
  queueTextUpdate(text: string, chatId: number): Update {
    const update = {
      update_id: this.#nextUpdateId++,
      message: {
        message_id: this.#nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "private", first_name: "주인" },
        text,
      },
    } as Update;
    this.#pendingUpdates.push(update);
    return update;
  }

  failNextTelegram(method: string, ...failures: TelegramFailure[]): void {
    this.#telegramFailures.set(method, [
      ...(this.#telegramFailures.get(method) ?? []),
      ...failures,
    ]);
  }

  replyToChat(...replies: ChatReply[]): void {
    this.#chatReplies.push(...replies);
  }

  /** 쌓인 답이 없을 때 쓴다. */
  respondToChatWith(responder: ChatResponder): void {
    this.#chatResponder = responder;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const telegramPath = /^\/bot[^/]+\/(\w+)$/.exec(request.url ?? "");
    if (telegramPath) return this.#handleTelegram(telegramPath[1]!, body, response);
    if (request.url === "/v1/chat/completions") return this.#handleChat(request, body, response);
    sendJson(response, 404, { error: `알 수 없는 경로 ${request.url}` });
  }

  async #handleTelegram(
    method: string,
    body: Record<string, unknown>,
    response: ServerResponse,
  ): Promise<void> {
    this.telegramCalls.push({ method, body });
    const failure = this.#telegramFailures.get(method)?.shift();
    if (failure) {
      sendJson(response, failure.status, {
        ok: false,
        error_code: failure.status,
        description: failure.description,
        parameters: failure.parameters,
      });
      return;
    }
    if (method === "getUpdates") {
      sendJson(response, 200, { ok: true, result: await this.#takeUpdates(body) });
      return;
    }
    const result =
      method === "sendMessage"
        ? {
            message_id: this.#nextMessageId++,
            date: 0,
            chat: { id: body.chat_id, type: "private" },
          }
        : true;
    sendJson(response, 200, { ok: true, result });
  }

  /** 텔레그램처럼 `offset` 앞의 것은 확인된 것으로 보고 버린다. */
  async #takeUpdates(body: Record<string, unknown>): Promise<Update[]> {
    const offset = Number(body.offset ?? 0);
    const confirmed = this.#pendingUpdates.filter((update) => update.update_id < offset);
    for (const update of confirmed)
      this.#pendingUpdates.splice(this.#pendingUpdates.indexOf(update), 1);
    if (this.#pendingUpdates.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, EMPTY_POLL_HOLD_MS));
    }
    return [...this.#pendingUpdates];
  }

  #handleChat(
    request: IncomingMessage,
    body: Record<string, unknown>,
    response: ServerResponse,
  ): void {
    const params = body as unknown as ChatCompletionCreateParamsNonStreaming;
    this.chatRequests.push({ authorization: request.headers.authorization, body: params });
    const reply = this.#chatReplies.shift() ?? this.#chatResponder?.(params);
    if (reply === undefined) {
      sendJson(response, 500, { error: { message: "가짜 서버에 준비된 답이 없다" } });
    } else if ("status" in reply && "body" in reply) {
      sendJson(response, reply.status, reply.body);
    } else {
      sendJson(response, 200, reply);
    }
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function chatCompletion(content: string): ChatCompletion {
  return {
    id: "fake",
    object: "chat.completion",
    created: 0,
    model: "fake",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
