import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { DateTime } from "luxon";
import { Gate } from "../fakes/gate.ts";
import { ScriptedLlm, type ScriptedTurn, inputSection } from "../fakes/scripted-llm.ts";
import { type TestApp, startApp } from "../rig.ts";

function lastMessageOf(request: ChatCompletionCreateParamsNonStreaming): string {
  return String(request.messages.at(-1)?.content);
}

/** 부팅 때 도는 계획의 요청은 뺀다. */
function llmCalls(app: TestApp) {
  return app.rows<{ kind: string; flow_id: number | null; success: number; error: string | null }>(
    "SELECT kind, flow_id, success, error FROM llm_calls WHERE kind != 'plan' ORDER BY id",
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
    app
      .rows("SELECT kind, flow_id FROM llm_calls ORDER BY id")
      .map(({ kind, flow_id }) => `${kind}:${flow_id}`),
    ["plan:null", "turn:null", "turn:null", "turn:1", "turn:1", "cleanup:1", "cleanup:1"],
  );
  const call = app.row<Record<string, unknown>>(
    "SELECT input_tokens, cached_tokens, output_tokens, request, response FROM llm_calls WHERE id = 2",
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

const neverFinishes = () => new Promise<never>(() => {});

function turnStartTimes(app: TestApp): string[] {
  return app.llm.log
    .filter(({ task }) => task.kind === "turn")
    .map(({ startedAt }) => startedAt.setZone("Asia/Seoul").toFormat("HH:mm:ss"));
}

function malformedTimes(count: number) {
  return Array.from({ length: count }, () => (turn: ScriptedTurn) => turn.malformed());
}

test("76a: 턴은 io 전에 실패 한 번과 재시도 시각을 기록하고, 성공 커밋(말 없는 판정 포함)이 지운다", async (t) => {
  let seenDuringIo: unknown;
  const llm = new ScriptedLlm().onTurn((turn) => {
    seenDuringIo = app.row("SELECT failure_count, turn_retry_at FROM harness_state");
    return turn.silent();
  });
  const app = await startApp(t, { llm });
  await app.user("심심해");

  await app.advance({ seconds: 20 });

  assert.deepEqual(seenDuringIo, {
    failure_count: 1,
    turn_retry_at: app.at("10:10").plus({ seconds: 20 }).toISO(),
  });
  assert.deepEqual(app.row("SELECT failure_count, turn_retry_at FROM harness_state"), {
    failure_count: 0,
    turn_retry_at: null,
  });
  assert.deepEqual(app.rows("SELECT triage FROM messages"), [{ triage: "ignored" }]);
});

test("78: 연속 실패가 failure_alert_after에 닿으면 다음 시도를 시작할 때 한 번만 알린다", async (t) => {
  const apiErrors = Array.from({ length: 5 }, () => (turn: ScriptedTurn) => turn.apiError());
  const app = await startApp(t, { llm: new ScriptedLlm().onTurn(...apiErrors) });
  await app.user("시작");

  await app.advanceTo("13:00");

  assert.deepEqual(turnStartTimes(app), [
    "10:00:20",
    "10:10:20",
    "10:30:20",
    "11:10:20",
    "12:30:20",
  ]);
  assert.deepEqual(app.telegram.alerts, [
    "턴이 3번 연속 실패했다. 이번 시도가 실패하면 2026-10-30 12:30 뒤에 다시 한다.",
  ]);
});

test("79: 턴 백오프 중에도 블랙아웃 시작의 흐름 닫기·정리·날 넘김은 돌고, 계획은 백오프 뒤에 돈다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    async (turn) => {
      await turn.createGoal({ title: "스트레칭" });
      return turn.say("해", { continueAfter: { hours: 1 } });
    },
    (turn) => turn.apiError(),
  );
  const app = await startApp(t, {
    at: "2026-10-30 22:40",
    llm,
    config: { blackout: "23:00-07:00", failure_backoff_first_sec: "3600" },
  });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  await app.user("하나 더");
  await app.advance({ seconds: 20 });

  await app.advanceTo("23:50");

  assert.deepEqual(app.llmTasks.slice(2), [
    "10-30 22:40 turn:reply",
    "10-30 23:00 cleanup",
    "10-30 23:40 plan",
  ]);
  assert.deepEqual(app.row("SELECT end_reason, ended_at FROM flows"), {
    end_reason: "blackout",
    ended_at: app.at("23:00").toISO(),
  });
  assert.deepEqual(app.row("SELECT state, closed_at FROM goals"), {
    state: "expired",
    closed_at: app.at("23:00").toISO(),
  });
});

test("80a: io 뒤 커밋 전 크래시가 재시작마다 반복돼도, 재시작 직후에는 부르지 않고 간격이 백오프를 따라 상한까지 는다", async (t) => {
  const app = await startApp(t, { llm: new ScriptedLlm().onTurn(...Array(7).fill(neverFinishes)) });
  await app.user("시작");
  await app.advance({ seconds: 20 });

  for (let restarts = 1; restarts <= 6; restarts++) {
    await app.restart({ downFor: { minutes: 1 } });
    assert.equal(turnStartTimes(app).length, restarts, "재시작 직후에는 다시 부르지 않는다");
    const retryAt = app.row<{ turn_retry_at: string }>("SELECT turn_retry_at FROM harness_state");
    await app.advance(DateTime.fromISO(retryAt.turn_retry_at).diff(app.clock.now()));
  }

  const startedAt = app.llm.log
    .filter(({ task }) => task.kind === "turn")
    .map((entry) => entry.startedAt);
  const gapsInMinutes = startedAt
    .slice(1)
    .map((at, index) => at.diff(startedAt[index]!).as("minutes"));
  assert.deepEqual(gapsInMinutes, [10, 20, 40, 80, 120, 120]);
  assert.equal(app.telegram.alerts.length, 1);
});

test("81: 실패 뒤 성공하면 실패 기록을 지우고, 다음 작업을 백오프 없이 고른다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.apiError(),
    (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
    (turn) => turn.say("그래", { continueAfter: { hours: 1 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advanceTo("10:11");

  await app.user("하나 더");
  await app.advance({ seconds: 20 });

  assert.deepEqual(failureState(app), {
    failure_count: 0,
    turn_retry_at: null,
    output_fail_count: 0,
    output_fail_key: null,
  });
  assert.deepEqual(app.telegram.sent, ["응", "그래"]);
  assert.equal(app.llmTasks.at(-1), "10-30 10:11 turn:reply");
});

test("82: 실패한 AI 개시 턴의 예약은 fired로 남고, 백오프 뒤 같은 예약으로 다시 돈다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30", intent: "물 마시기" }] }))
    .onTurn(
      (turn) => turn.apiError(),
      (turn) => turn.say("물 마셔", { continueAfter: { hours: 1 } }),
    );
  const app = await startApp(t, { llm });
  await app.advanceTo("10:31");
  assert.deepEqual(app.rows("SELECT id, state FROM reservations"), [{ id: 1, state: "fired" }]);

  await app.advanceTo("10:41");

  assert.deepEqual(turnStartTimes(app), ["10:30:00", "10:40:00"]);
  assert.deepEqual(
    app.llm.inputs("turn").map((input) => inputSection(input, "이벤트")[0]),
    ["계기: AI 개시(개시 예약 #1)", "계기: AI 개시(개시 예약 #1)"],
  );
  assert.deepEqual(app.telegram.sent, ["물 마셔"]);
});

test("82a: AI 개시 턴이 출력 실패를 turn_max_attempts번 내면 예약을 지우고 후속 확인을 잡고 알린다. 백오프는 이어진다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    async (turn) => {
      const goalId = await turn.createGoal({ title: "보고서 초안" });
      await turn.reserveOpening({ at: "10:30", intent: "초안 확인", goalIds: [goalId] });
      return turn.end("10시 반에 볼게");
    },
    ...malformedTimes(3),
    (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("보고서 써야 돼");
  await app.advance({ seconds: 20 });

  await app.advanceTo("11:05");
  await app.user("아직이야?");
  await app.advanceTo("11:41");

  assert.deepEqual(turnStartTimes(app), [
    "10:00:20",
    "10:30:00",
    "10:40:00",
    "11:00:00",
    "11:40:00",
  ]);
  assert.deepEqual(app.rows("SELECT source, at FROM reservations WHERE kind = 'open'"), [
    { source: "harness", at: app.at("12:00").toISO() },
  ]);
  const [givenUp, streak] = app.telegram.alerts;
  assert.match(
    givenUp!,
    /^턴\(AI 개시\(개시 예약 #1\)\)을 포기했다\. 출력 실패 3번\. 마지막 오류: parse: /,
  );
  assert.match(streak!, /^턴이 3번 연속 실패했다/, "포기 뒤 다음 시도도 연속 실패로 이어 센다");
});

test("82b: 판정 턴이 출력 실패를 turn_max_attempts번 내면 본 메시지만 무시하고, 마지막 시도 중에 온 메시지는 판정 대기로 남는다", async (t) => {
  const lastAttemptGate = new Gate();
  const llm = new ScriptedLlm().onTurn(...malformedTimes(2), async (turn) => {
    await lastAttemptGate.wait();
    return turn.malformed();
  });
  const app = await startApp(t, { llm });
  await app.user("심심해");
  await app.advanceTo("10:30");
  await app.advance({ seconds: 20 });
  await app.user("놀아 줘");
  lastAttemptGate.open();
  await app.advance({ seconds: 1 });

  assert.deepEqual(app.rows("SELECT content, triage FROM messages"), [
    { content: "심심해", triage: "ignored" },
    { content: "놀아 줘", triage: "pending" },
  ]);
  assert.match(app.telegram.alerts[0]!, /^턴\(사용자 메시지\(흐름 없음\)\)을 포기했다/);
});

test("82d: API 오류만 이어지면 백오프만 하고 트리거를 포기하지 않는다", async (t) => {
  const apiErrors = Array.from({ length: 5 }, () => (turn: ScriptedTurn) => turn.apiError());
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(...apiErrors);
  const app = await startApp(t, { llm });

  await app.advanceTo("13:01");

  assert.equal(turnStartTimes(app).length, 5);
  assert.deepEqual(app.rows("SELECT state FROM reservations"), [{ state: "fired" }]);
  assert.ok(app.telegram.alerts.every((alert) => !alert.includes("포기")));
});

test("82e: 출력 실패 사이에 API 오류가 끼어도 출력 실패 횟수는 이어져 세 번째 출력 실패에서 포기한다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.malformed(),
    (turn) => turn.apiError(),
    ...malformedTimes(2),
  );
  const app = await startApp(t, { llm });
  await app.user("심심해");

  await app.advanceTo("10:31");
  assert.deepEqual(app.rows("SELECT triage FROM messages"), [{ triage: "pending" }]);
  assert.equal(failureState(app).output_fail_count, 2);

  await app.advanceTo("11:11");
  assert.deepEqual(app.rows("SELECT triage FROM messages"), [{ triage: "ignored" }]);
  assert.ok(app.telegram.alerts.some((alert) => alert.includes("포기")));
});

test("82f: 출력 실패 두 번 뒤 성공하면 출력 실패 횟수를 지운다", async (t) => {
  const llm = new ScriptedLlm().onTurn(...malformedTimes(2), (turn) =>
    turn.say("응", { continueAfter: { hours: 1 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("심심해");

  await app.advanceTo("10:31");

  assert.deepEqual(failureState(app), {
    failure_count: 0,
    turn_retry_at: null,
    output_fail_count: 0,
    output_fail_key: null,
  });
  assert.deepEqual(app.telegram.sent, ["응"]);
});

test("82g: 다른 트리거의 출력 실패는 1부터 다시 센다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:20" }] }))
    .onTurn(...malformedTimes(3));
  const app = await startApp(t, { llm });
  await app.user("심심해");

  await app.advanceTo("10:31");

  assert.deepEqual(app.llmTasks.slice(1), [
    "10-30 10:00 turn:user",
    "10-30 10:10 turn:user",
    "10-30 10:30 turn:open#1",
  ]);
  assert.deepEqual(
    { count: failureState(app).output_fail_count, key: failureState(app).output_fail_key },
    { count: 1, key: "open:1" },
  );
  assert.deepEqual(app.rows("SELECT triage FROM messages"), [{ triage: "pending" }]);
  assert.deepEqual(app.rows("SELECT state FROM reservations"), [{ state: "fired" }]);
});

test("82h: 모든 턴이 출력 실패하면 트리거를 포기해도 실패 횟수가 이어져, 다음 트리거도 커진 백오프 뒤에 돈다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:35" }] }))
    .onTurn(...malformedTimes(4));
  const app = await startApp(t, { llm });
  await app.user("심심해");

  await app.advanceTo("11:11");

  assert.deepEqual(app.llmTasks.slice(1), [
    "10-30 10:00 turn:user",
    "10-30 10:10 turn:user",
    "10-30 10:30 turn:user",
    "10-30 11:10 turn:open#1",
  ]);
  assert.deepEqual(app.rows("SELECT triage FROM messages"), [{ triage: "ignored" }]);
});
