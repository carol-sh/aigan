import assert from "node:assert/strict";
import { test } from "node:test";
import { Gate } from "../fakes/gate.ts";
import { ScriptedLlm } from "../fakes/scripted-llm.ts";
import { createTwoGoalsCheckedAt } from "../fakes/scenarios.ts";
import { startApp } from "../rig.ts";

test("75a: 흐름 없이 블랙아웃을 지나면 전날 목표는 expired, 전날 개시 예약은 모두 지우고 LLM 없이 계획으로 간다", async (t) => {
  const llm = new ScriptedLlm().onTurn(createTwoGoalsCheckedAt("23:30"));
  const app = await startApp(t, { at: "2026-10-30 21:00", llm });
  await app.user("오늘 뭐 하지");
  await app.advanceTo("22:00");
  app.suspend({ hours: 2 });

  await app.advance({ seconds: 60 });

  assert.deepEqual(app.rows("SELECT state, end_reason FROM goals"), [
    { state: "expired", end_reason: "날 넘김" },
    { state: "expired", end_reason: "날 넘김" },
  ]);
  assert.deepEqual(app.rows("SELECT id FROM reservations"), []);
  assert.deepEqual(app.llmTasks.slice(2), ["10-30 21:00 cleanup", "10-31 00:00 plan"]);
});

test("75d: 날 넘김은 플래그 없이 데이터로 판정해서, 다시 돌아도 결과가 같다", async (t) => {
  const llm = new ScriptedLlm().onTurn(createTwoGoalsCheckedAt("23:30"));
  const app = await startApp(t, { at: "2026-10-30 21:00", llm });
  await app.user("오늘 뭐 하지");
  await app.advance({ seconds: 20 });
  app.suspend({ hours: 3 });
  await app.advance({ seconds: 60 });
  const goalsAfterRollover = app.rows("SELECT * FROM goals");

  await app.restart();
  await app.advance({ minutes: 5 });

  assert.deepEqual(app.rows("SELECT * FROM goals"), goalsAfterRollover);
  assert.equal(app.llmTasks.length, 4);
});

test("75e: 턴 백오프 중에 계획일 경계를 지나도 날 넘김은 돌고, 계획은 백오프 뒤에 돈다", async (t) => {
  const llm = new ScriptedLlm().onTurn(createTwoGoalsCheckedAt("23:30"));
  const app = await startApp(t, { at: "2026-10-30 21:00", llm });
  await app.user("오늘 뭐 하지");
  await app.advance({ seconds: 20 });
  app.plant(
    "UPDATE harness_state SET turn_retry_at = ?, failure_count = 2",
    app.at("2026-10-31 00:30").toISO(),
  );

  await app.advanceTo("2026-10-31 00:40");

  assert.deepEqual(app.rows("SELECT closed_at FROM goals"), [
    { closed_at: app.at("2026-10-31 00:00").toISO() },
    { closed_at: app.at("2026-10-31 00:00").toISO() },
  ]);
  assert.deepEqual(app.llmTasks.slice(3), ["10-31 00:30 plan"]);
});

test("75f: 사흘 다운 뒤 낮에 재시작하면 날 넘김 → 판정 대기 메시지 → 계획 순이고 어제 개입은 돌지 않는다", async (t) => {
  const llm = new ScriptedLlm().onTurn(createTwoGoalsCheckedAt("23:00"), (turn) => turn.silent());
  const app = await startApp(t, { at: "2026-10-30 21:00", llm });
  await app.user("오늘 뭐 하지");
  await app.advance({ seconds: 20 });
  await app.user("내일 일찍 운동할게");

  await app.restart({ downFor: { days: 3, hours: 13 } });
  await app.advance({ minutes: 1 });

  assert.deepEqual(app.rows("SELECT state FROM goals"), [
    { state: "expired" },
    { state: "expired" },
  ]);
  assert.deepEqual(app.llmTasks.slice(3), ["11-03 10:00 turn:user", "11-03 10:00 plan"]);
});

test("75b: 턴의 io가 계획일 경계를 넘겨도 만든 목표는 턴이 시작할 때의 계획일 것이다", async (t) => {
  const gate = new Gate();
  const llm = new ScriptedLlm().onTurn(async (turn) => {
    await gate.wait();
    await turn.createGoal({ title: "물 한 잔" });
    return turn.say("물 마시고 자", { continueAfter: { hours: 1 } });
  });
  const app = await startApp(t, { at: "2026-10-30 23:59", llm });
  await app.user("잘게");
  await app.advance({ seconds: 20 });
  await app.advanceTo("2026-10-31 00:01");

  gate.open();
  await app.advance({ seconds: 1 });

  assert.deepEqual(app.row("SELECT plan_date, state FROM goals"), {
    plan_date: "2026-10-30",
    state: "expired",
  });
});
