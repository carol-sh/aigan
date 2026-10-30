import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedLlm } from "../fakes/llm-tasks.ts";
import { startApp } from "../rig.ts";

const neverFinishes = () => new Promise<never>(() => {});

test("113: 디바운스 대기 중에 재시작하면, 기한이 지났으면 바로 턴을 돈다", async (t) => {
  const app = await startApp(t);
  await app.user("안녕");
  await app.advance({ seconds: 10 });

  await app.restart({ downFor: { seconds: 30 } });

  const userTurn = app.llm.log.find(({ task }) => task.kind === "turn");
  assert.equal(userTurn?.startedAt.toMillis(), app.at("10:00").plus({ seconds: 40 }).toMillis());
});

test("114: 턴 io 중에 죽으면 커밋 전이라 아무것도 바뀌지 않고 같은 작업을 다시 돈다", async (t) => {
  const llm = new ScriptedLlm().onTurn(neverFinishes, (turn) => turn.say("응"));
  const app = await startApp(t, { llm });
  await app.user("안녕");
  await app.advance({ seconds: 20 });
  assert.deepEqual(app.rows("SELECT triage FROM messages WHERE role = 'user'"), [
    { triage: "pending" },
  ]);

  await app.restart({ downFor: { minutes: 1 } });

  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:00 turn:user",
    "10-30 10:01 turn:user",
  ]);
  assert.deepEqual(app.rows("SELECT triage FROM messages WHERE role = 'user'"), [
    { triage: "accepted" },
  ]);
});

test("115: 열린 흐름에 이어가기 예약이 없으면 복구 예약을 넣고 실패 횟수는 그대로다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) => turn.say("응", { continueAfter: { hours: 1 } }));
  const app = await startApp(t, { llm });
  await app.user("안녕");
  await app.advance({ seconds: 20 });
  app.plant("DELETE FROM reservations WHERE kind = 'continue'");

  await app.restart({ downFor: { minutes: 5 } });

  assert.deepEqual(app.row("SELECT kind, at, source FROM reservations"), {
    kind: "continue",
    at: app.at("10:06").plus({ seconds: 20 }).toISO(),
    source: "harness",
  });
  assert.equal(app.row("SELECT failure_count FROM harness_state").failure_count, 0);
});

test("116: 이어가기 예약이 낡았으면 흐름을 stale로 닫고, 미응답은 판정 대기로, 목표에는 후속 확인을 잡는다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) => {
    turn.createGoal({ title: "물 한 잔" });
    return turn.say("물 마셔", { continueAfter: { minutes: 30 } });
  });
  const app = await startApp(t, { llm });
  await app.user("안녕");
  await app.advanceTo("10:30");
  await app.user("잠깐만");

  await app.restart({ downFor: { hours: 1 } });
  await app.advance({ seconds: 1 });

  assert.equal(app.row("SELECT end_reason FROM flows").end_reason, "stale");
  assert.deepEqual(
    app.rows("SELECT content, flow_id, triage FROM messages WHERE content = '잠깐만'"),
    [{ content: "잠깐만", flow_id: null, triage: "ignored" }],
  );
  assert.deepEqual(app.row("SELECT kind, source, intent FROM reservations"), {
    kind: "open",
    source: "harness",
    intent: "후속 확인",
  });
  assert.deepEqual(app.llmTasks.slice(2), ["10-30 11:30 cleanup", "10-30 11:30 turn:user"]);
});

test("118: 정리 대기로 재시작하면 cleanup_next_at에 다시 시도한다", async (t) => {
  const llm = new ScriptedLlm()
    .onTurn(
      (turn) => turn.say("응", { continueAfter: { minutes: 1 } }),
      (turn) => turn.end("끝"),
    )
    .onCleanup((cleanup) => cleanup.fail());
  const app = await startApp(t, { llm });
  await app.user("안녕");
  await app.advanceTo("10:01");
  await app.advance({ seconds: 30 });

  await app.restart({ downFor: { seconds: 10 } });
  await app.advance({ seconds: 30 });

  const cleanupTimes = app.llm.log
    .filter(({ task }) => task.kind === "cleanup")
    .map(({ startedAt }) => startedAt.diff(app.at("10:01")).as("seconds"));
  assert.deepEqual(cleanupTimes, [20, 50]);
});

test("119: 며칠 다운 뒤에는 지난 개시 예약을 지우고 지난 목표를 닫은 다음 계획이 오늘 것을 새로 잡는다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan(
      (plan) => plan.finishPlan({ openings: [{ at: "15:00" }, { at: "16:00" }] }),
      (plan) => plan.finishPlan({ openings: [{ at: "15:00" }] }),
    )
    .onTurn((turn) => {
      turn.createGoal({ title: "운동" });
      return turn.end("목표");
    });
  const app = await startApp(t, { llm });
  await app.user("운동할래");
  await app.advance({ seconds: 20 });

  await app.restart({ downFor: { days: 3 } });

  assert.deepEqual(app.rows("SELECT plan_date, at FROM reservations"), [
    { plan_date: "2026-11-02", at: app.at("15:00").toISO() },
  ]);
  assert.equal(app.row("SELECT state FROM goals").state, "expired");
});

test("120: 계획 io 중에 죽으면 재시작 뒤 다시 계획을 돈다", async (t) => {
  const llm = new ScriptedLlm().onPlan(neverFinishes);
  const app = await startApp(t, { llm });

  await app.restart({ downFor: { minutes: 1 } });

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 10:01 plan"]);
  assert.equal(app.row("SELECT last_plan_date FROM harness_state").last_plan_date, "2026-10-30");
});
