import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { ScriptedLlm } from "../fakes/scripted-llm.ts";
import { startApp } from "../rig.ts";

function lastMessageOf(request: ChatCompletionCreateParamsNonStreaming): string {
  return String(request.messages.at(-1)?.content);
}

function llmCalls(app: Awaited<ReturnType<typeof startApp>>) {
  return app.rows<{ kind: string; flow_id: number | null; success: number; error: string | null }>(
    "SELECT kind, flow_id, success, error FROM llm_calls ORDER BY id",
  );
}

test("76: 읽을 수 없는 답이면 사유를 알려 주며 강제 호출로 한 번 더 묻고, 고친 답으로 커밋한다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) =>
    turn.malformed({ onRetry: turn.say("응", { continueAfter: { hours: 1 } }) }),
  );
  const app = await startApp(t, { llm });
  await app.user("시작");

  await app.advance({ seconds: 20 });

  const [first, retry] = app.llm.requestsOf("turn");
  assert.equal(first?.tool_choice, undefined);
  assert.equal(retry?.tool_choice, "none");
  assert.match(lastMessageOf(retry!), /^출력이 형식에 맞지 않는다: JSON 객체가 아니다/);
  assert.deepEqual(
    llmCalls(app).map(({ success, error }) => ({ success, error })),
    [
      { success: 0, error: "parse: JSON 객체가 아니다" },
      { success: 1, error: null },
    ],
  );
  assert.deepEqual(app.telegram.sent, ["응"]);
});

test("재시도에도 읽을 수 없으면 아무것도 바꾸지 않고 로그를 남긴다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("응", { continueAfter: { minutes: 10 } }),
    async (turn) => {
      await turn.createGoal({ title: "산책" });
      return turn.malformed();
    },
    (turn) => turn.say("다시 말해 줘", { continueAfter: { hours: 1 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  await app.user("하나 더");

  await app.advance({ seconds: 20 });

  assert.deepEqual(app.rows("SELECT id FROM goals"), []);
  assert.ok(app.logger.lines.some((line) => line.includes("턴(reply)이 실패")));
  assert.deepEqual(app.telegram.sent, ["응", "다시 말해 줘"]);
});

test("48h: 이어가기 턴이 말 없이 이어가면 스키마 위반이라 재시도하고, 또 그러면 이어가기 예약을 건드리지 않는다", async (t) => {
  let continueSeenByNextAttempt: unknown[] = [];
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("물 마셔", { continueAfter: { minutes: 10 } }),
    (turn) => turn.silent(),
    (turn) => {
      continueSeenByNextAttempt = app.rows(
        "SELECT state, at FROM reservations WHERE kind = 'continue'",
      );
      return turn.end("나중에 보자");
    },
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });

  await app.advanceTo("10:11");

  const [, failedAttempt, retry] = app.llm.requestsOf("turn");
  assert.equal(failedAttempt?.messages.length, 2);
  assert.match(lastMessageOf(retry!), /이어가기 턴은 말 없이 이어갈 수 없다/);
  assert.deepEqual(
    llmCalls(app)
      .slice(1, 3)
      .map(({ error }) => error?.startsWith("parse: 이어가기 턴은 말 없이 이어갈 수 없다")),
    [true, true],
  );
  assert.deepEqual(continueSeenByNextAttempt, [
    { state: "fired", at: app.at("10:10").plus({ seconds: 20 }).toISO() },
  ]);
});

test("API 오류는 재시도하지 않고 기록한다. 턴은 아무것도 바꾸지 않는다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) => turn.apiError());
  const app = await startApp(t, { llm });
  await app.user("시작");

  await app.advance({ seconds: 20 });

  assert.deepEqual(llmCalls(app)[0], {
    kind: "turn",
    flow_id: null,
    success: 0,
    error: "api: 각본이 API 오류를 냈다",
  });
  const nextRequest = app.llm.requestsOf("turn")[1];
  assert.equal(nextRequest?.messages.length, 2, "실패한 대화를 잇지 않고 새 대화로 다시 돈다");
});

test("llm_calls는 요청마다 종류·흐름·토큰·요청과 응답을 남긴다", async (t) => {
  const llm = new ScriptedLlm()
    .onTurn(
      async (turn) => {
        await turn.createGoal({ title: "물" });
        return turn.say("물 마셔", { continueAfter: { hours: 1 } });
      },
      async (turn) => {
        await turn.use("goal_close", { goal_id: 1, result: "done", reason: "마심" });
        return turn.end("잘했어");
      },
    )
    .onCleanup(async (cleanup) => {
      await cleanup.use("state_write", { content: "물 마심" });
    });
  const app = await startApp(t, { llm });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });
  await app.user("마셨어");

  await app.advance({ seconds: 20 });

  assert.deepEqual(
    llmCalls(app).map(({ kind, flow_id }) => `${kind}:${flow_id}`),
    ["turn:null", "turn:null", "turn:1", "turn:1", "cleanup:1", "cleanup:1"],
  );
  const call = app.row<Record<string, unknown>>(
    "SELECT input_tokens, cached_tokens, output_tokens, request, response FROM llm_calls WHERE id = 1",
  );
  assert.deepEqual(
    { input: call.input_tokens, cached: call.cached_tokens, output: call.output_tokens },
    { input: 100, cached: 80, output: 10 },
  );
  assert.equal(JSON.parse(call.request as string).model, "test-model");
  assert.equal(
    JSON.parse(call.response as string).choices[0].message.tool_calls[0].function.name,
    "goal_create",
  );
});
