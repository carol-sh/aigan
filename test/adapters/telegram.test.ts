import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { Update } from "grammy/types";
import { TelegramPoller } from "../../src/adapters/telegram-poller.ts";
import { BotTelegram, createTelegramApi } from "../../src/adapters/telegram.ts";
import { TelegramError } from "../../src/ports.ts";
import { OWNER_CHAT_ID, testConfig } from "../fakes/config.ts";
import { FakeApiServer } from "../fakes/fake-api-server.ts";
import { MemoryLogger } from "../fakes/logger.ts";

async function startServer(t: TestContext) {
  const server = await FakeApiServer.start();
  t.after(() => server.close());
  const api = createTelegramApi(testConfig({ telegram_api_root: server.url }));
  return { server, api, telegram: new BotTelegram(api, OWNER_CHAT_ID) };
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("던져야 한다");
}

test("텔레그램 전송·지우기·입력 중 표시는 주인 채팅으로 평문을 보낸다", async (t) => {
  const { server, telegram } = await startServer(t);

  await telegram.sendMessage("안녕\n둘째 줄");
  await telegram.deleteMessage(42);
  await telegram.showTyping();

  assert.deepEqual(server.telegramCalls, [
    { method: "sendMessage", body: { chat_id: OWNER_CHAT_ID, text: "안녕\n둘째 줄" } },
    { method: "deleteMessage", body: { chat_id: OWNER_CHAT_ID, message_id: 42 } },
    { method: "sendChatAction", body: { chat_id: OWNER_CHAT_ID, action: "typing" } },
  ]);
});

test("텔레그램 오류 응답은 상태와 retry_after를 담은 TelegramError가 된다", async (t) => {
  const { server, telegram } = await startServer(t);
  server.failNextTelegram(
    "sendMessage",
    { status: 403, description: "Forbidden: bot was blocked by the user" },
    { status: 429, description: "Too Many Requests", parameters: { retry_after: 3 } },
    { status: 400, description: "Bad Request: message text is empty" },
  );

  const blocked = await catchError(telegram.sendMessage("a"));
  const limited = await catchError(telegram.sendMessage("b"));
  const bad = await catchError(telegram.sendMessage("c"));

  assert.ok(blocked instanceof TelegramError && blocked.isBlockedByUser);
  assert.ok(limited instanceof TelegramError && limited.isRateLimited);
  assert.equal(limited.retryAfterSec, 3);
  assert.ok(bad instanceof TelegramError && !bad.isBlockedByUser && !bad.isRateLimited);
  assert.equal(bad.status, 400);
});

test("롱폴러는 업데이트를 순서대로 넘기고, 다음 요청의 offset을 마지막 id + 1로 올리며, 메시지만 받는다", async (t) => {
  const { server, api } = await startServer(t);
  const first = server.queueTextUpdate("하나", OWNER_CHAT_ID);
  const second = server.queueTextUpdate("둘", OWNER_CHAT_ID);
  const received: Update[] = [];
  const poller = new TelegramPoller(api, new MemoryLogger());

  poller.start((update) => received.push(update));
  await waitUntil(() => server.callsTo("getUpdates").length >= 2);
  await poller.stop();

  assert.deepEqual(
    received.map((update) => update.message?.text),
    ["하나", "둘"],
  );
  const [firstPoll, secondPoll] = server.callsTo("getUpdates");
  assert.deepEqual(firstPoll, { offset: 0, timeout: 30, allowed_updates: ["message"] });
  assert.equal(secondPoll?.offset, second.update_id + 1);
  assert.ok(second.update_id > first.update_id);
});

test("롱폴러는 오류가 나면 경고를 남기고 기다렸다가 다시 받아 온다", async (t) => {
  const { server, api } = await startServer(t);
  server.failNextTelegram("getUpdates", { status: 500, description: "Internal Server Error" });
  server.queueTextUpdate("다시 받음", OWNER_CHAT_ID);
  const received: Update[] = [];
  const logger = new MemoryLogger();
  const poller = new TelegramPoller(api, logger, { firstRetryDelayMs: 10 });

  poller.start((update) => received.push(update));
  await waitUntil(() => received.length === 1);
  await poller.stop();

  assert.equal(received[0]?.message?.text, "다시 받음");
  assert.ok(logger.lines[0]?.startsWith("warn 텔레그램 업데이트를 받지 못했다. 10ms 뒤 다시 한다"));
});

test("롱폴러의 stop은 기다리는 중인 롱폴을 바로 끊는다", async (t) => {
  const { server, api } = await startServer(t);
  const logger = new MemoryLogger();
  const poller = new TelegramPoller(api, logger);
  poller.start(() => {});
  await waitUntil(() => server.callsTo("getUpdates").length >= 1);

  const startedAt = Date.now();
  await poller.stop();

  assert.ok(Date.now() - startedAt < 1000);
  assert.deepEqual(logger.lines, []);
});

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("기다리던 일이 일어나지 않았다");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
