import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../src/db/repositories/messages.ts";
import { ScriptedLlm } from "../fakes/llm-tasks.ts";
import { type TestApp, startApp } from "../rig.ts";

function userMessages(app: TestApp): Pick<Message, "content" | "flow_id" | "triage">[] {
  return app.rows("SELECT content, flow_id, triage FROM messages WHERE role = 'user' ORDER BY id");
}

test("7: 흐름이 열려 있으면 메시지는 그 흐름에 들어가고 판정이 없다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) =>
    turn.say("응", { continueAfter: { minutes: 30 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("시작하자");
  await app.advance({ seconds: 20 });

  await app.user("하나 더");

  assert.deepEqual(userMessages(app).at(-1), { content: "하나 더", flow_id: 1, triage: null });
});

test("8: 흐름이 없으면 흐름 밖 판정 대기로 저장된다", async (t) => {
  const app = await startApp(t);

  await app.user("안녕");

  assert.deepEqual(userMessages(app), [{ content: "안녕", flow_id: null, triage: "pending" }]);
});

test("9: 같은 update를 다시 받으면 무시한다", async (t) => {
  const app = await startApp(t);
  const update = app.telegram.textUpdate("안녕");

  await app.receive(update);
  await app.receive(app.telegram.repeat(update));

  assert.equal(userMessages(app).length, 1);
});

test("10: owner_chat_id가 아닌 채팅은 무시한다", async (t) => {
  const app = await startApp(t);

  await app.receive(app.telegram.textUpdate("누구세요", 999));
  await app.advance({ minutes: 1 });

  assert.equal(userMessages(app).length, 0);
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan"]);
});

test("11: /로 시작하는 텍스트도 일반 메시지로 판정에 간다", async (t) => {
  const app = await startApp(t);

  await app.user("/pause");
  await app.advance({ seconds: 20 });

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 10:00 turn:user"]);
});

test("11a: 사진은 저장하지 않고 판정·디바운스도 없다", async (t) => {
  const app = await startApp(t);

  await app.receive(app.telegram.photoUpdate());
  await app.advance({ minutes: 1 });

  assert.equal(userMessages(app).length, 0);
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan"]);
});

test("11b: 메시지 수정은 무시하고 원문을 그대로 둔다", async (t) => {
  const app = await startApp(t);
  const original = app.telegram.textUpdate("10시에 할게");
  await app.receive(original);

  await app.receive(app.telegram.editedUpdate(original.message!.message_id, "11시에 할게"));

  assert.deepEqual(
    userMessages(app).map((message) => message.content),
    ["10시에 할게"],
  );
});

test("11c: 몰아 받은 메시지 3개는 저장 시각 기준이라 한 디바운스로 묶여 턴 하나가 된다", async (t) => {
  const app = await startApp(t);

  await app.user("하나");
  await app.user("둘");
  await app.user("셋");
  await app.advance({ minutes: 1 });

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 10:00 turn:user"]);
  assert.deepEqual(
    userMessages(app).map((message) => message.triage),
    ["ignored", "ignored", "ignored"],
  );
});
