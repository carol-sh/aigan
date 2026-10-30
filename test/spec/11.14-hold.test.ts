import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedLlm } from "../fakes/scripted-llm.ts";
import { createTwoGoalsCheckedAt } from "../fakes/scenarios.ts";
import { type TestApp, startApp } from "../rig.ts";

const ONLY_ONE_CALL_A_DAY = { daily_call_limit: "1" };

/** 판정 턴 하나(말 없이 무시, 요청 1건)로 `daily_call_limit`=1을 다 쓴다. */
async function spendTheOnlyDailyCall(app: TestApp): Promise<void> {
  await app.user("첫 말");
  await app.advance({ seconds: 20 });
}

function holdState(app: TestApp) {
  return app.row("SELECT hold_reason, hold_since, hold_until FROM harness_state");
}

test("107: 일일 상한에 닿은 뒤의 개시 턴은 게이트가 보류에 넣고, 예약과 실패 상태를 그대로 둔다", async (t) => {
  const llm = new ScriptedLlm().onPlan((plan) =>
    plan.finishPlan({ openings: [{ at: "12:00", intent: "점심 확인" }] }),
  );
  const app = await startApp(t, { llm, config: ONLY_ONE_CALL_A_DAY });
  await spendTheOnlyDailyCall(app);

  await app.advanceTo("12:01");

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 10:00 turn:user"]);
  assert.deepEqual(holdState(app), {
    hold_reason: "daily_limit",
    hold_since: app.at("12:00").toISO(),
    hold_until: app.at("2026-10-31 00:00").toISO(),
  });
  assert.deepEqual(app.rows("SELECT state FROM reservations"), [{ state: "fired" }]);
  assert.deepEqual(app.row("SELECT failure_count, turn_retry_at FROM harness_state"), {
    failure_count: 0,
    turn_retry_at: null,
  });
  assert.deepEqual(app.telegram.alerts, [
    "오늘 LLM 요청이 상한(1건)에 닿아 보류에 들어간다. 2026-10-31 00:00에 풀린다.",
  ]);
});

test("107a: 상한은 작업 단위라, 시작할 때 남아 있으면 도구 라운드와 되묻기로 넘겨도 턴을 끝까지 커밋한다", async (t) => {
  const llm = new ScriptedLlm()
    .onTurn(async (turn) => {
      await turn.createGoal({ title: "물 2리터" });
      return turn.end("물 마셔");
    })
    .onReconsider(async (turn) => {
      await turn.reserveOpening({ at: "15:00", intent: "물 확인", goalIds: [1] });
      return turn.end("물 마셔. 3시에 볼게");
    });
  const app = await startApp(t, { llm, config: ONLY_ONE_CALL_A_DAY });

  await app.user("뭐 할까");
  await app.advance({ seconds: 20 });

  assert.equal(app.telegram.sent[0], "물 마셔. 3시에 볼게");
  assert.equal(app.row("SELECT state FROM goals").state, "active");
  assert.ok((app.row("SELECT daily_calls FROM harness_state").daily_calls as number) > 1);
  assert.equal(holdState(app).hold_reason, "daily_limit");
  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:00 turn:user",
    "10-30 10:00 turn:user:reconsider",
  ]);
});

test("108: 보류 중에 온 메시지는 기록만 한다", async (t) => {
  const app = await startApp(t, { config: ONLY_ONE_CALL_A_DAY });
  await spendTheOnlyDailyCall(app);
  await app.user("안녕");
  await app.advance({ seconds: 20 });

  await app.user("자니");
  await app.advance({ hours: 1 });

  assert.deepEqual(app.rows("SELECT content, triage FROM messages"), [
    { content: "첫 말", triage: "ignored" },
    { content: "안녕", triage: "pending" },
    { content: "자니", triage: "pending" },
  ]);
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 10:00 turn:user"]);
  assert.equal(app.telegram.alerts.length, 1);
});

test("109: 일일 상한 보류는 로컬 자정에 풀리고 재개 뒤 밀린 것을 처리한다", async (t) => {
  const app = await startApp(t, { config: ONLY_ONE_CALL_A_DAY });
  await spendTheOnlyDailyCall(app);
  await app.user("안녕");
  await app.advance({ seconds: 20 });

  await app.advanceTo("2026-10-31 00:01");
  assert.equal(holdState(app).hold_reason, null);

  await app.advanceTo("08:01");
  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:00 turn:user",
    "10-31 00:00 plan",
    "10-31 08:00 turn:user",
  ]);
});

test("109a: 일일 상한 보류 중 내려가 자정을 넘겨 재시작하면 부팅 뒤 바로 풀고 밀린 것을 처리한다", async (t) => {
  const app = await startApp(t, { config: { daily_call_limit: "2" } });
  for (const text of ["하나", "둘", "셋"]) {
    await app.user(text);
    await app.advance({ seconds: 20 });
  }
  assert.equal(holdState(app).hold_reason, "daily_limit");

  await app.restart({ downFor: { hours: 23 } });

  assert.equal(holdState(app).hold_reason, null);
  assert.deepEqual(app.llmTasks.slice(3), ["10-31 09:01 turn:user", "10-31 09:01 plan"]);
});

test("87: 정리를 기다리는 중 보류에 들어가면 정리는 시도로 세지 않고 멈췄다가, 풀린 뒤 이어진다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) => turn.end("잘 자"));
  const app = await startApp(t, { at: "2026-10-30 22:00", llm, config: ONLY_ONE_CALL_A_DAY });

  await app.user("잘게");
  await app.advance({ minutes: 30 });

  assert.deepEqual(app.row("SELECT cleanup_status, cleanup_attempts FROM flows"), {
    cleanup_status: "pending",
    cleanup_attempts: 0,
  });
  assert.equal(holdState(app).hold_reason, "daily_limit");

  await app.advanceTo("2026-10-31 00:01");
  assert.equal(app.row("SELECT cleanup_status FROM flows").cleanup_status, "done");
  assert.deepEqual(app.llmTasks.slice(2), ["10-31 00:00 cleanup"]);
});

test("111: 보류 중에도 블랙아웃 시작에 흐름을 닫고, 정리·날 넘김·계획은 해제 뒤에 돈다", async (t) => {
  const llm = new ScriptedLlm().onTurn(async (turn) => {
    await turn.createGoal({ title: "산책" });
    return turn.say("응", { continueAfter: { hours: 2 } });
  });
  const app = await startApp(t, {
    at: "2026-10-30 22:00",
    llm,
    config: { blackout: "23:00-07:00", daily_call_limit: "2" },
  });
  await app.user("시작");
  await app.advance({ seconds: 20 });

  await app.advanceTo("23:30");
  assert.equal(holdState(app).hold_reason, "daily_limit");
  assert.deepEqual(app.row("SELECT end_reason, ended_at, cleanup_status FROM flows"), {
    end_reason: "blackout",
    ended_at: app.at("23:00").toISO(),
    cleanup_status: "pending",
  });
  assert.equal(app.row("SELECT state FROM goals").state, "active");

  await app.advanceTo("2026-10-31 00:01");
  assert.equal(app.row("SELECT state FROM goals").state, "expired");
  assert.deepEqual(app.llmTasks.slice(2), ["10-31 00:00 cleanup", "10-31 00:00 plan"]);
});

test("111a: 흐름도 정리 대기도 없으면 날 넘김은 보류 중에 돌고, 계획은 해제 뒤에 돈다", async (t) => {
  const llm = new ScriptedLlm().onTurn(createTwoGoalsCheckedAt("22:50"));
  const app = await startApp(t, {
    at: "2026-10-30 21:00",
    llm,
    // 판정 턴(목표 둘·예약·답 4건)과 정리(1건)까지 쓰고, 22:50 개시 턴에서 보류에 들어간다.
    config: { blackout: "23:00-07:00", daily_call_limit: "5" },
  });
  await app.user("오늘 뭐 하지");

  await app.advanceTo("23:05");
  assert.equal(holdState(app).hold_reason, "daily_limit");
  assert.deepEqual(app.rows("SELECT state FROM goals"), [
    { state: "expired" },
    { state: "expired" },
  ]);
  assert.deepEqual(app.rows("SELECT id FROM reservations"), []);
  assert.equal(app.llmTasks.length, 3);

  await app.advanceTo("2026-10-31 00:01");
  assert.deepEqual(app.llmTasks.slice(3), ["10-31 00:00 plan"]);
});

test("111b: 보류 중 블랙아웃에 온 메시지는 흐름 밖 판정 대기로 남아 해제·블랙아웃 끝 뒤에 판정된다", async (t) => {
  const app = await startApp(t, {
    at: "2026-10-30 22:00",
    config: { blackout: "23:00-07:00", ...ONLY_ONE_CALL_A_DAY },
  });
  await spendTheOnlyDailyCall(app);
  await app.user("하나 더");
  await app.advanceTo("23:30");
  assert.equal(holdState(app).hold_reason, "daily_limit");

  await app.user("자기 전에");
  await app.advanceTo("2026-10-31 06:59");
  assert.deepEqual(app.rows("SELECT content, flow_id, triage FROM messages WHERE id > 1"), [
    { content: "하나 더", flow_id: null, triage: "pending" },
    { content: "자기 전에", flow_id: null, triage: "pending" },
  ]);

  await app.advanceTo("07:01");
  assert.deepEqual(app.llmTasks, [
    "10-30 22:00 plan",
    "10-30 22:00 turn:user",
    "10-31 00:00 plan",
    "10-31 07:00 turn:user",
  ]);
});

test("112: 자정을 넘겨 재시작하면 첫 LLM 요청 직전에 daily_calls를 오늘 날짜로 새로 센다", async (t) => {
  const app = await startApp(t, { at: "2026-10-29 22:00" });
  await app.user("밤 인사");
  await app.advance({ seconds: 20 });
  assert.deepEqual(app.row("SELECT daily_calls, daily_calls_date FROM harness_state"), {
    daily_calls: 1,
    daily_calls_date: "2026-10-29",
  });

  await app.restart({ downFor: { hours: 11 } });
  await app.user("아침 인사");
  await app.advance({ seconds: 20 });

  assert.deepEqual(app.row("SELECT daily_calls, daily_calls_date FROM harness_state"), {
    daily_calls: 1,
    daily_calls_date: "2026-10-30",
  });
});
