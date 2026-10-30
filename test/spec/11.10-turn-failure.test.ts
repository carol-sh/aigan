import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { ScriptedLlm } from "../fakes/scripted-llm.ts";
import { type TestApp, startApp } from "../rig.ts";

function lastMessageOf(request: ChatCompletionCreateParamsNonStreaming): string {
  return String(request.messages.at(-1)?.content);
}

function llmCalls(app: TestApp) {
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

function failureState(app: TestApp) {
  return app.row(
    "SELECT failure_count, turn_retry_at, output_fail_count, output_fail_key FROM harness_state",
  );
}

test("77: 재시도에도 읽을 수 없으면 아무것도 바꾸지 않고, 시작 때 올린 실패 기록을 두고 출력 실패를 센다", async (t) => {
  const llm = new ScriptedLlm().onTurn(async (turn) => {
    await turn.createGoal({ title: "산책" });
    return turn.malformed();
  });
  const app = await startApp(t, { llm });
  await app.user("시작");

  await app.advance({ seconds: 20 });

  assert.deepEqual(app.rows("SELECT id FROM goals"), []);
  assert.deepEqual(app.rows("SELECT triage FROM messages"), [{ triage: "pending" }]);
  assert.deepEqual(failureState(app), {
    failure_count: 1,
    turn_retry_at: app.at("10:10").plus({ seconds: 20 }).toISO(),
    output_fail_count: 1,
    output_fail_key: "user",
  });
  assert.ok(app.logger.lines.some((line) => line.includes("턴(사용자 메시지(흐름 없음))이 실패")));
});

test("77: API 오류는 재시도하지 않고 기록한다. 출력 실패로 세지 않고, 백오프 뒤 새 대화로 다시 돈다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.apiError(),
    (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });

  assert.deepEqual(llmCalls(app)[0], {
    kind: "turn",
    flow_id: null,
    success: 0,
    error: "api: 각본이 API 오류를 냈다",
  });
  assert.deepEqual(failureState(app), {
    failure_count: 1,
    turn_retry_at: app.at("10:10").plus({ seconds: 20 }).toISO(),
    output_fail_count: 0,
    output_fail_key: null,
  });

  await app.advanceTo("10:11");
  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:00 turn:user",
    "10-30 10:10 turn:user",
  ]);
  const nextRequest = app.llm.requestsOf("turn")[1];
  assert.equal(nextRequest?.messages.length, 2, "실패한 대화를 잇지 않고 새 대화로 다시 돈다");
});

test("48h, 82c: 이어가기 턴이 말 없이 이어가면 스키마 위반이라 재시도하고, turn_max_attempts번째에 흐름을 failed로 닫는다", async (t) => {
  let continueSeenBySecondAttempt: unknown[] = [];
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("물 마셔", { continueAfter: { minutes: 10 } }),
    (turn) => turn.silent(),
    (turn) => {
      continueSeenBySecondAttempt = app.rows(
        "SELECT state, at FROM reservations WHERE kind = 'continue'",
      );
      return turn.silent();
    },
    (turn) => turn.silent(),
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

  await app.advanceTo("10:25");
  await app.user("잠깐 나갔다 옴");
  await app.advanceTo("10:41");

  const continueAt = app.at("10:10").plus({ seconds: 20 }).toISO();
  assert.deepEqual(continueSeenBySecondAttempt, [{ state: "fired", at: continueAt }]);
  assert.deepEqual(app.llmTasks.slice(1), [
    "10-30 10:00 turn:user",
    "10-30 10:10 turn:continue",
    "10-30 10:20 turn:continue",
    "10-30 10:40 turn:continue",
    "10-30 10:40 cleanup",
  ]);
  assert.deepEqual(app.row("SELECT end_reason, cleanup_status FROM flows"), {
    end_reason: "failed",
    cleanup_status: "done",
  });
  assert.deepEqual(app.rows("SELECT id FROM reservations WHERE kind = 'continue'"), []);
  assert.deepEqual(
    app.row("SELECT flow_id, triage FROM messages WHERE content = '잠깐 나갔다 옴'"),
    { flow_id: null, triage: "pending" },
  );
  assert.deepEqual(app.telegram.alerts, [
    "턴(이어가기)을 포기했다. 출력 실패 3번. 마지막 오류: parse: 이어가기 턴은 말 없이 이어갈 수 없다. 기다리려면 한 줄이라도 말하거나 end한다",
  ]);
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
