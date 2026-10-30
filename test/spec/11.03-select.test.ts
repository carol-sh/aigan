import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "../../src/ports.ts";
import { Gate } from "../fakes/gate.ts";
import { ScriptedLlm } from "../fakes/scripted-llm.ts";
import { type TestApp, startApp } from "../rig.ts";

const ONE_DAY_SEC = "86400";

function wakeUpsDuring(app: TestApp, run: () => Promise<void>): Promise<number> {
  const before = app.harness.loop.stats.wakeUps;
  return run().then(() => app.harness.loop.stats.wakeUps - before);
}

function sleepingUntil(app: TestApp): string | undefined {
  return app.harness.loop.stats.sleepingUntil?.setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss");
}

test("13: 밀린 개시 예약과 디바운스가 지난 판정 대기가 함께 있으면 개시 턴 하나만 돈다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "08:00" }] }))
    .onTurn((turn) => turn.say("아침이야", { continueAfter: { hours: 1 } }));
  const app = await startApp(t, { at: "2026-10-30 07:00", llm });
  await app.user("밤에 할 말");

  await app.advanceTo("08:30");

  assert.deepEqual(app.llmTasks, ["10-30 07:00 plan", "10-30 08:00 turn:open#1"]);
  assert.deepEqual(app.rows("SELECT flow_id, triage FROM messages WHERE role = 'user'"), [
    { flow_id: 1, triage: "accepted" },
  ]);
});

test("13, 31: 개시 턴의 io 중에 온 메시지를 지우지 못하면 흡수돼도 본 적 없는 것이라 디바운스 뒤 답장 턴이 받는다", async (t) => {
  const gate = new Gate();
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(async (turn) => {
      await gate.wait();
      return turn.say("산책 가자", { continueAfter: { hours: 1 } });
    });
  const app = await startApp(t, { llm });
  await app.advanceTo("10:30");
  app.telegram.failNextDeletes(new TelegramError(400, "message can't be deleted"));
  await app.user("지금 바빠");

  gate.open();
  await app.advance({ seconds: 20 });

  assert.deepEqual(app.rows("SELECT flow_id, triage FROM messages WHERE role = 'user'"), [
    { flow_id: 1, triage: "accepted" },
  ]);
  assert.deepEqual(app.llmTasks.slice(1), ["10-30 10:30 turn:open#1", "10-30 10:30 turn:reply"]);
});

test("14: 판정 대기가 디바운스 중이면 밀린 개시 예약도 만료까지 기다린다 (L3)", async (t) => {
  const llm = new ScriptedLlm().onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }));
  const app = await startApp(t, { llm });
  await app.advanceTo("10:29");
  await app.advance({ seconds: 55 });
  await app.user("지금 막 쓰는 중");

  await app.advance({ seconds: 30 });

  const openingTurn = app.llm.log.find(({ task }) => task.kind === "turn");
  assert.equal(openingTurn?.startedAt.toMillis(), app.at("10:30").plus({ seconds: 15 }).toMillis());
});

test("15: 밀린 개시 예약 셋은 at, id 순으로 하나씩, 앞 흐름이 닫히고 정리가 끝난 뒤 돈다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) =>
      plan.finishPlan({ openings: [{ at: "08:30" }, { at: "08:00" }, { at: "08:00" }] }),
    )
    .onTurn(
      (turn) => turn.say("첫째", { continueAfter: { hours: 1 } }),
      (turn) => turn.end("끝"),
      (turn) => turn.say("둘째", { continueAfter: { minutes: 30 } }),
      (turn) => turn.end("끝"),
      (turn) => turn.say("셋째", { continueAfter: { minutes: 30 } }),
    );
  const app = await startApp(t, { at: "2026-10-30 07:00", llm });

  await app.advanceTo("09:40");

  assert.deepEqual(app.llmTasks, [
    "10-30 07:00 plan",
    "10-30 08:00 turn:open#2",
    "10-30 09:00 turn:continue",
    "10-30 09:00 cleanup",
    "10-30 09:00 turn:open#3",
    "10-30 09:30 turn:continue",
    "10-30 09:30 cleanup",
    "10-30 09:30 turn:open#1",
  ]);
});

test("16: 정리가 밀린 개시·판정보다 먼저고, 정리 재시도를 기다리는 동안 어떤 턴도 돌지 않는다. 말 없는 개시 턴 뒤에 판정이 돈다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:20" }] }))
    .onTurn(
      (turn) => turn.say("그래", { continueAfter: { minutes: 30 } }),
      (turn) => turn.end("그럼 이만"),
    )
    .onCleanup((cleanup) => cleanup.fail());
  const app = await startApp(t, { llm });
  await app.user("얘기 좀 하자");
  await app.advanceTo("10:30");
  await app.advance({ seconds: 25 });
  await app.user("하나 더");

  await app.advance({ minutes: 2 });

  const tasksAfterFlow = app.llm.log
    .slice(2)
    .map(({ task, startedAt }) => [
      task.kind === "turn" ? `turn:${task.trigger}` : task.kind,
      startedAt.diff(app.at("10:30")).as("seconds"),
    ]);
  assert.deepEqual(tasksAfterFlow, [
    ["turn:continue", 20],
    ["cleanup", 20],
    ["cleanup", 50],
    ["turn:open", 50],
    ["turn:user", 50],
  ]);
});

test("17: 계획이 밀려도 판정 대기가 디바운스 중이면 계획도 기다린다", async (t) => {
  const llm = new ScriptedLlm().onPlan((plan) => plan.failPlan());
  const app = await startApp(t, { llm });
  await app.advanceTo("10:09");
  await app.advance({ seconds: 50 });
  await app.user("잠깐만");

  await app.advance({ minutes: 1 });

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 10:10 turn:user", "10-30 10:10 plan"]);
});

test("18: 흐름이 열린 동안 밀린 계획은 흐름이 닫히고 정리가 끝난 뒤 돌고, 그동안 바쁜 루프가 없다 (L1)", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.failPlan())
    .onTurn(
      (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
      (turn) => turn.end("이만"),
    );
  const app = await startApp(t, { llm, config: { timer_max_sleep_sec: ONE_DAY_SEC } });
  await app.user("시작");
  // 계획 재시도 시각(10:10)에는 한 번 깨어난다. 그 시각이 지난 뒤로는 조준하지 않아야 한다.
  await app.advanceTo("10:11");

  const wakeUps = await wakeUpsDuring(app, () => app.advanceTo("10:59"));

  assert.equal(wakeUps, 0);
  await app.advanceTo("11:05");
  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:00 turn:user",
    "10-30 11:00 turn:continue",
    "10-30 11:00 cleanup",
    "10-30 11:00 plan",
  ]);
});

test("18a: 이어가기가 블랙아웃 시작 뒤까지 턴 백오프에 막혀도 블랙아웃 시작에 흐름을 닫는다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.failPlan())
    .onTurn((turn) => turn.say("응", { continueAfter: { hours: 1 } }));
  const app = await startApp(t, {
    at: "2026-10-30 22:00",
    llm,
    config: { timer_max_sleep_sec: ONE_DAY_SEC },
  });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  app.plant(
    "UPDATE harness_state SET turn_retry_at = ?, failure_count = 1",
    app.at("2026-10-31 01:30").toISO(),
  );

  await app.advanceTo("2026-10-31 00:10");

  const flow = app.row<{ end_reason: string; ended_at: string }>(
    "SELECT end_reason, ended_at FROM flows",
  );
  assert.deepEqual(flow, { end_reason: "blackout", ended_at: app.at("2026-10-31 00:00").toISO() });
  assert.ok(!app.llmTasks.some((task) => task.endsWith("turn:continue")));
});

test("19: 턴 백오프 중이면 디바운스가 지난 판정 대기가 있어도 백오프가 끝날 때까지 깨어나지 않는다 (L1)", async (t) => {
  const app = await startApp(t, { config: { timer_max_sleep_sec: ONE_DAY_SEC } });
  app.plant(
    "UPDATE harness_state SET turn_retry_at = ?, failure_count = 1",
    app.at("11:00").toISO(),
  );
  await app.advanceTo("10:05");
  await app.user("안녕");
  await app.advance({ seconds: 20 });

  const wakeUps = await wakeUpsDuring(app, () => app.advanceTo("10:59"));

  assert.equal(wakeUps, 0);
  assert.equal(sleepingUntil(app), "10-30 11:00:00");
  await app.advanceTo("11:01");
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 11:00 turn:user"]);
});

test("20: 보류 중이면 디바운스가 지난 메시지가 있어도 다음 기한은 hold_until이다 (L1)", async (t) => {
  const app = await startApp(t, { config: { timer_max_sleep_sec: ONE_DAY_SEC } });
  app.plant(
    "UPDATE harness_state SET hold_reason = 'daily_limit', hold_since = ?, hold_until = ?, daily_calls_date = '2026-10-30'",
    app.at("10:00").toISO(),
    app.at("2026-10-30 23:30").toISO(),
  );
  await app.user("안녕");
  await app.advance({ seconds: 20 });

  const wakeUps = await wakeUpsDuring(app, () => app.advanceTo("23:00"));

  assert.equal(wakeUps, 0);
  assert.equal(sleepingUntil(app), "10-30 23:30:00");
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan"]);
});

test("21: 작업 중 wake()는 무시되고, 작업이 끝나면 그동안 와서 지우지 못한 메시지를 다음 작업으로 고른다", async (t) => {
  let finishTurn = () => {};
  const turnMayFinish = new Promise<void>((resolve) => (finishTurn = resolve));
  const llm = new ScriptedLlm().onTurn(async (turn) => {
    await turnMayFinish;
    return turn.say("응", { continueAfter: { hours: 1 } });
  });
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });

  app.telegram.failNextDeletes(new TelegramError(400, "message can't be deleted"));
  const wakeUps = await wakeUpsDuring(app, () => app.user("턴 도중에 온 말"));
  finishTurn();
  await app.advance({ seconds: 20 });

  assert.equal(wakeUps, 0);
  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:00 turn:user",
    "10-30 10:00 turn:reply",
  ]);
});

test("22: 기한 후보가 없는 blocked 보류에서는 timer_max_sleep_sec마다 깨어나 고르기만 한다", async (t) => {
  const app = await startApp(t);
  app.plant(
    "UPDATE harness_state SET hold_reason = 'blocked', hold_since = ?",
    app.at("10:00").toISO(),
  );
  await app.advance({ minutes: 1 });

  const wakeUps = await wakeUpsDuring(app, () => app.advance({ minutes: 10 }));

  assert.equal(wakeUps, 10);
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan"]);
});

test("22a: 기한까지 깨어 있는 동안 기기가 절전해도 깨어난 뒤 timer_max_sleep_sec 안에 기한이 지난 작업을 한다", async (t) => {
  const llm = new ScriptedLlm().onPlan((plan) => plan.finishPlan({ openings: [{ at: "13:00" }] }));
  const app = await startApp(t, { llm });
  await app.advanceTo("11:00");

  app.suspend({ hours: 2 });
  await app.advance({ seconds: 60 });

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 13:01 turn:open#1"]);
});
