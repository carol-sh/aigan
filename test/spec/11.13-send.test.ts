import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "../../src/ports.ts";
import { ScriptedLlm } from "../fakes/llm-tasks.ts";
import { type TestApp, startApp } from "../rig.ts";

function replyingWith(...say: string[]): ScriptedLlm {
  return new ScriptedLlm().onTurn((turn) => turn.say(say, { continueAfter: { hours: 1 } }));
}

async function askAndWaitForTurn(app: TestApp): Promise<void> {
  await app.user("얘기하자");
  await app.advance({ seconds: 20 });
}

function assistantMessages(app: TestApp) {
  return app.rows<{ content: string; sent: number; void_reason: string | null }>(
    "SELECT content, sent_at IS NOT NULL AS sent, void_reason FROM messages WHERE role = 'assistant' ORDER BY id",
  );
}

test("100: 4096자를 넘는 메시지는 줄바꿈 경계로 나눠 보낸다", async (t) => {
  const longText = `${"가".repeat(3000)}\n${"나".repeat(2000)}`;
  const app = await startApp(t, { llm: replyingWith(longText) });

  await askAndWaitForTurn(app);
  await app.advance({ seconds: 1 });

  assert.deepEqual(app.telegram.sent, ["가".repeat(3000), "나".repeat(2000)]);
  assert.deepEqual(assistantMessages(app), [{ content: longText, sent: 1, void_reason: null }]);
});

test("101: 커밋 뒤 전송 전에 죽었다가 곧 재시작하면 outbox를 다시 보낸다", async (t) => {
  const app = await startApp(t, { llm: replyingWith("물 마셨어?") });
  app.telegram.failNextSends("hang");
  await askAndWaitForTurn(app);

  await app.restart({ downFor: { minutes: 1 } });

  assert.deepEqual(app.telegram.sent, ["물 마셨어?"]);
  assert.deepEqual(assistantMessages(app), [{ content: "물 마셨어?", sent: 1, void_reason: null }]);
});

test("102: 오래 다운됐다 재시작하면 낡은 outbox는 보내지 않고 undelivered로 둔다", async (t) => {
  const app = await startApp(t, { llm: replyingWith("물 마셨어?") });
  app.telegram.failNextSends("hang");
  await askAndWaitForTurn(app);

  await app.restart({ downFor: { hours: 1 } });

  assert.deepEqual(app.telegram.sent, []);
  assert.deepEqual(assistantMessages(app), [
    { content: "물 마셨어?", sent: 0, void_reason: "undelivered" },
  ]);
});

test("103: 403이면 남은 outbox를 모두 undelivered로 두고 blocked 보류에 들어간다", async (t) => {
  const app = await startApp(t, { llm: replyingWith("하나", "둘") });
  app.telegram.failNextSends(new TelegramError(403, "bot was blocked by the user"));

  await askAndWaitForTurn(app);

  assert.deepEqual(assistantMessages(app), [
    { content: "하나", sent: 0, void_reason: "undelivered" },
    { content: "둘", sent: 0, void_reason: "undelivered" },
  ]);
  assert.deepEqual(app.row("SELECT hold_reason, hold_since, hold_until FROM harness_state"), {
    hold_reason: "blocked",
    hold_since: app.at("10:00").plus({ seconds: 20 }).toISO(),
    hold_until: null,
  });
});

test("104: blocked 중 사용자 메시지가 오면 보류를 풀고 재개한다", async (t) => {
  const llm = replyingWith("하나").onTurn((turn) =>
    turn.say("다시 왔네", { continueAfter: { hours: 1 } }),
  );
  const app = await startApp(t, { llm });
  app.telegram.failNextSends(new TelegramError(403, "bot was blocked by the user"));
  await askAndWaitForTurn(app);
  await app.advance({ minutes: 5 });

  await app.user("차단 풀었어");
  await app.advance({ seconds: 20 });

  assert.equal(app.row("SELECT hold_reason FROM harness_state").hold_reason, null);
  assert.deepEqual(app.llmTasks.slice(2), ["10-30 10:05 turn:reply"]);
  assert.deepEqual(app.telegram.sent, ["다시 왔네"]);
});

test("105: 429면 retry_after만큼 기다렸다가 다시 보낸다", async (t) => {
  const app = await startApp(t, { llm: replyingWith("천천히") });
  app.telegram.failNextSends(new TelegramError(429, "Too Many Requests", 5));
  await askAndWaitForTurn(app);

  await app.advance({ seconds: 4 });
  assert.deepEqual(app.telegram.sent, []);

  await app.advance({ seconds: 1 });
  assert.deepEqual(app.telegram.sent, ["천천히"]);
});

test("106: 그 밖의 전송 오류는 몇 번 재시도한 뒤 그 메시지만 undelivered로 두고 다음 것을 보낸다", async (t) => {
  const app = await startApp(t, { llm: replyingWith("하나", "둘") });
  const serverError = new TelegramError(500, "Internal Server Error");
  app.telegram.failNextSends(serverError, serverError, serverError);

  await askAndWaitForTurn(app);
  await app.advance({ seconds: 5 });

  assert.deepEqual(assistantMessages(app), [
    { content: "하나", sent: 0, void_reason: "undelivered" },
    { content: "둘", sent: 1, void_reason: null },
  ]);
  assert.deepEqual(app.telegram.sent, ["둘"]);
});
