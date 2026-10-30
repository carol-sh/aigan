import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedLlm } from "../fakes/scripted-llm.ts";
import { createTwoGoalsCheckedAt } from "../fakes/scenarios.ts";
import { type TestApp, startApp } from "../rig.ts";

/** 게이트가 아직 없어서 일일 상한 보류를 직접 심는다. 게이트 단계에서 실제 경로로 바꾼다. */
function holdForDailyLimitUntilMidnight(app: TestApp): void {
  app.plant(
    `UPDATE harness_state SET hold_reason = 'daily_limit', hold_since = ?, hold_until = ?,
       daily_calls = 500, daily_calls_date = ?`,
    app.clock.now().toISO(),
    app.harness.ctx.calendar.nextLocalMidnight(app.clock.now()).toISO(),
    app.harness.ctx.calendar.localDate(app.clock.now()),
  );
}

test("108: 보류 중에 온 메시지는 기록만 한다", async (t) => {
  const app = await startApp(t);
  holdForDailyLimitUntilMidnight(app);

  await app.user("안녕");
  await app.advance({ hours: 1 });

  assert.deepEqual(app.rows("SELECT content, triage FROM messages"), [
    { content: "안녕", triage: "pending" },
  ]);
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan"]);
});

test("109: 일일 상한 보류는 로컬 자정에 풀리고 재개 뒤 밀린 것을 처리한다", async (t) => {
  const app = await startApp(t);
  holdForDailyLimitUntilMidnight(app);
  await app.user("안녕");

  await app.advanceTo("2026-10-31 00:01");
  assert.equal(app.row("SELECT hold_reason FROM harness_state").hold_reason, null);

  await app.advanceTo("08:01");
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-31 00:00 plan", "10-31 08:00 turn:user"]);
});

test("111: 보류 중에도 블랙아웃 시작에 흐름을 닫고, 정리·날 넘김·계획은 해제 뒤에 돈다", async (t) => {
  const llm = new ScriptedLlm().onTurn(async (turn) => {
    await turn.createGoal({ title: "산책" });
    return turn.say("응", { continueAfter: { hours: 2 } });
  });
  const app = await startApp(t, {
    at: "2026-10-30 22:00",
    llm,
    config: { blackout: "23:00-07:00" },
  });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  holdForDailyLimitUntilMidnight(app);

  await app.advanceTo("23:30");
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
    config: { blackout: "23:00-07:00" },
  });
  await app.user("오늘 뭐 하지");
  await app.advanceTo("21:30");
  holdForDailyLimitUntilMidnight(app);

  await app.advanceTo("23:05");
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
  const app = await startApp(t, { at: "2026-10-30 22:00", config: { blackout: "23:00-07:00" } });
  holdForDailyLimitUntilMidnight(app);
  await app.advanceTo("23:30");

  await app.user("자기 전에");
  await app.advanceTo("2026-10-31 06:59");
  assert.deepEqual(app.rows("SELECT flow_id, triage FROM messages"), [
    { flow_id: null, triage: "pending" },
  ]);

  await app.advanceTo("07:01");
  assert.deepEqual(app.llmTasks, ["10-30 22:00 plan", "10-31 00:00 plan", "10-31 07:00 turn:user"]);
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
