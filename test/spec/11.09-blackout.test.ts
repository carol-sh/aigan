import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedLlm } from "../fakes/llm-tasks.ts";
import { startApp } from "../rig.ts";

test("70: 블랙아웃 시작에 미응답 없는 흐름은 LLM 없이 닫히고, 지난 계획일의 목표에는 후속 확인을 잡지 않는다", async (t) => {
  const llm = new ScriptedLlm().onTurn((c) => {
    c.openFlow({ say: "물 마셔", continueAfter: { hours: 2 } });
    c.createGoal({ title: "물 한 잔" });
  });
  const app = await startApp(t, { at: "2026-10-30 23:00", llm });
  await app.user("응");
  await app.advance({ seconds: 20 });

  await app.advanceTo("2026-10-31 00:05");

  assert.deepEqual(app.row("SELECT end_reason, ended_at FROM flows"), {
    end_reason: "blackout",
    ended_at: app.at("2026-10-31 00:00").toISO(),
  });
  assert.deepEqual(app.llmTasks, [
    "10-30 23:00 plan",
    "10-30 23:00 turn:user",
    "10-31 00:00 cleanup",
    "10-31 00:00 plan",
  ]);
  assert.deepEqual(app.rows("SELECT kind FROM reservations"), []);
});

test("71: 미응답이 디바운스 중이어도 흐름을 닫고, 그 메시지는 판정 대기로 남아 블랙아웃이 끝나면 판정된다", async (t) => {
  const llm = new ScriptedLlm().onTurn((c) =>
    c.openFlow({ say: "응", continueAfter: { hours: 2 } }),
  );
  const app = await startApp(t, { at: "2026-10-30 23:00", llm });
  await app.user("시작");
  await app.advanceTo("23:59");
  await app.advance({ seconds: 50 });
  await app.user("자기 전에 하나만");

  await app.advanceTo("2026-10-31 08:05");

  assert.deepEqual(app.row("SELECT end_reason FROM flows"), { end_reason: "blackout" });
  assert.deepEqual(
    app.rows("SELECT content, flow_id FROM messages WHERE role = 'user' AND triage = 'ignored'"),
    [{ content: "자기 전에 하나만", flow_id: null }],
  );
  assert.deepEqual(app.llmTasks.slice(2), [
    "10-31 00:00 cleanup",
    "10-31 00:00 plan",
    "10-31 08:00 turn:user",
  ]);
});

test("72, 117: 블랙아웃 중 재시작에서 발화한 개시 예약은 지난 계획일 것이라 날 넘김이 지우고 턴은 없다", async (t) => {
  const llm = new ScriptedLlm().onPlan((c) => c.finishPlan({ openings: [{ at: "23:50" }] }));
  const app = await startApp(t, { llm });
  await app.advanceTo("23:40");

  await app.restart({ downFor: { hours: 1, minutes: 20 } });

  assert.deepEqual(app.rows("SELECT id FROM reservations"), []);
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-31 01:00 plan"]);
});

test("72a: 흐름이 열린 채 밤새 절전했다 깨어나면 이어가기 없이 흐름을 닫고 정리 → 날 넘김 → 계획", async (t) => {
  const llm = new ScriptedLlm().onTurn((c) => {
    c.openFlow({ say: "응", continueAfter: { minutes: 30 } });
    c.createGoal({ title: "스트레칭" });
  });
  const app = await startApp(t, { at: "2026-10-30 22:00", llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });

  app.suspend({ hours: 11 });
  await app.advance({ seconds: 60 });

  assert.deepEqual(app.row("SELECT end_reason FROM flows"), { end_reason: "blackout" });
  assert.deepEqual(app.row("SELECT state, end_reason FROM goals"), {
    state: "expired",
    end_reason: "날 넘김",
  });
  assert.deepEqual(app.llmTasks, [
    "10-30 22:00 plan",
    "10-30 22:00 turn:user",
    "10-31 09:01 cleanup",
    "10-31 09:01 plan",
  ]);
});

test("74: 블랙아웃 진입 시 흐름이 열려 있으면 닫기 → 정리 → 날 넘김 → 계획 순으로 돈다", async (t) => {
  const goalStatesSeenByPlan: unknown[] = [];
  const llm = new ScriptedLlm()
    .onPlan(
      (c) => c.finishPlan(),
      (c) => {
        goalStatesSeenByPlan.push(...app.rows("SELECT state FROM goals"));
        c.finishPlan();
      },
    )
    .onTurn((c) => {
      c.openFlow({ say: "책 읽자", continueAfter: { hours: 3 } });
      c.createGoal({ title: "책 30쪽" });
    });
  const app = await startApp(t, { at: "2026-10-30 22:00", llm });
  await app.user("응");
  await app.advance({ seconds: 20 });

  await app.advanceTo("2026-10-31 00:05");

  assert.deepEqual(app.llmTasks.slice(2), ["10-31 00:00 cleanup", "10-31 00:00 plan"]);
  assert.deepEqual(goalStatesSeenByPlan, [{ state: "expired" }]);
});
