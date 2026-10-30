import assert from "node:assert/strict";
import { test } from "node:test";
import { Gate } from "../fakes/gate.ts";
import { ScriptedLlm, type ScriptedTurn, type TurnScript } from "../fakes/scripted-llm.ts";
import { type StartOptions, type TestApp, startApp } from "../rig.ts";

/** 사용자가 연 흐름의 첫 턴이 각본대로 목표를 만들고 끝낸다. 되묻기 각본은 따로 준다. */
async function startWithEndingTurn(
  t: Parameters<typeof startApp>[0],
  firstTurn: TurnScript,
  options: StartOptions & { reconsider?: TurnScript } = {},
): Promise<TestApp> {
  const llm = (options.llm ?? new ScriptedLlm()).onTurn(firstTurn);
  if (options.reconsider) llm.onReconsider(options.reconsider);
  const app = await startApp(t, { ...options, llm });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });
  return app;
}

function createGoalAndEnd(goal: { title: string; dueAt?: string } = { title: "물" }) {
  return async (turn: ScriptedTurn) => {
    await turn.createGoal(goal);
    return turn.end("이따 봐");
  };
}

function harnessReservations(app: TestApp) {
  return app.rows<{ at: string; intent: string }>(
    "SELECT at, intent FROM reservations WHERE source = 'harness' ORDER BY id",
  );
}

test("62, 62c: 끝내는 턴이 다음 확인 없는 목표를 남기면 한 번 되묻고, 두 번째 출력이 예약하거나 닫으면 그대로 커밋한다 (L8)", async (t) => {
  const answers: Record<string, TurnScript> = {
    open_reserve: async (turn) => {
      await turn.reserveOpening({ at: "15:00", goalIds: [1] });
      return turn.end("3시에 볼게");
    },
    goal_close: async (turn) => {
      await turn.use("goal_close", { goal_id: 1, result: "dropped", reason: "오늘은 됐다" });
      return turn.end("그건 빼자");
    },
  };
  for (const [name, reconsider] of Object.entries(answers)) {
    await t.test(name, async (t) => {
      const app = await startWithEndingTurn(t, createGoalAndEnd(), { reconsider });

      assert.deepEqual(app.llmTasks.slice(1, 3), [
        "10-30 10:00 turn:user",
        "10-30 10:00 turn:user:reconsider",
      ]);
      assert.deepEqual(harnessReservations(app), []);
      assert.deepEqual(app.row("SELECT end_reason FROM flows"), { end_reason: "agent" });
      assert.equal(app.row("SELECT failure_count FROM harness_state").failure_count, 0);
    });
  }
});

test("62a: 되묻기에도 빠뜨리면 커밋한 뒤 orphan_goal_delay_sec 뒤로 후속 확인을 잡고 로그를 남긴다", async (t) => {
  const app = await startWithEndingTurn(t, createGoalAndEnd(), {
    reconsider: (turn) => turn.end("이따 봐"),
  });

  assert.deepEqual(harnessReservations(app), [
    { at: app.at("11:00").plus({ seconds: 20 }).toISO(), intent: "후속 확인" },
  ]);
  assert.ok(app.logger.lines.some((line) => line.includes("후속 확인을 잡았다")));
});

test("62b: 이어가는 출력은 다음 확인 없는 목표가 있어도 되묻지 않는다", async (t) => {
  const app = await startWithEndingTurn(t, async (turn) => {
    await turn.createGoal({ title: "물" });
    return turn.say("마시고 와", { continueAfter: { minutes: 30 } });
  });

  assert.ok(!app.llmTasks.some((task) => task.endsWith(":reconsider")));
  assert.deepEqual(harnessReservations(app), []);
});

test("62d: 첫 출력이 만든 목표를 되묻기 출력이 예약하면 두 효과가 모두 커밋된다", async (t) => {
  const app = await startWithEndingTurn(t, createGoalAndEnd(), {
    reconsider: async (turn) => {
      await turn.reserveOpening({ at: "15:00", intent: "물 확인", goalIds: [1] });
      return turn.end("3시에 확인할게");
    },
  });

  assert.equal(app.row("SELECT state FROM goals WHERE id = 1").state, "active");
  assert.deepEqual(app.rows("SELECT source, intent FROM reservations"), [
    { source: "turn", intent: "물 확인" },
  ]);
  assert.deepEqual(app.rows("SELECT reservation_id, goal_id FROM reservation_goals"), [
    { reservation_id: 1, goal_id: 1 },
  ]);
  assert.deepEqual(app.telegram.sent, ["3시에 확인할게"]);
});

test("62e: 되묻기 호출이 실패하면 첫 출력으로 커밋하고 후속 확인을 잡으며 출력 실패로 세지 않는다", async (t) => {
  const app = await startWithEndingTurn(t, createGoalAndEnd(), {
    reconsider: (turn) => turn.malformed(),
  });

  assert.deepEqual(app.telegram.sent, ["이따 봐"]);
  assert.equal(harnessReservations(app).length, 1);
  assert.equal(app.row("SELECT output_fail_count FROM harness_state").output_fail_count, 0);
  assert.ok(app.logger.lines.some((line) => line.includes("되묻기가 실패")));
});

test("63: 마감이 미래면 후속 확인은 마감 시각이다", async (t) => {
  const app = await startWithEndingTurn(t, createGoalAndEnd({ title: "보고서", dueAt: "18:00" }));

  assert.deepEqual(harnessReservations(app), [
    { at: app.at("18:00").toISO(), intent: "후속 확인" },
  ]);
});

test("64: 마감이 지났으면 후속 확인은 now + orphan_goal_delay_sec다 (L7)", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    async (turn) => {
      await turn.createGoal({ title: "보고서", dueAt: "10:30" });
      return turn.say("10시 반까지", { continueAfter: { hours: 1 } });
    },
    (turn) => turn.end("알았어"),
  );
  const app = await startApp(t, { llm });
  await app.user("할 일 줘");
  await app.advanceTo("10:40");
  await app.user("못 했어");
  await app.advance({ seconds: 20 });

  assert.deepEqual(harnessReservations(app), [
    { at: app.at("11:40").plus({ seconds: 20 }).toISO(), intent: "후속 확인" },
  ]);
});

test("65: 그날 끝까지 orphan_goal_delay보다 짧게 남으면 후속 확인은 그날 끝 - min_lead다", async (t) => {
  const app = await startWithEndingTurn(t, createGoalAndEnd(), { at: "2026-10-30 23:30" });

  assert.deepEqual(harnessReservations(app), [
    { at: app.at("23:59").toISO(), intent: "후속 확인" },
  ]);
});

test("65a: 그날 끝까지 시간이 거의 없으면 되묻지도 보정하지도 않고 날 넘김이 expired로 닫는다", async (t) => {
  const app = await startWithEndingTurn(t, createGoalAndEnd(), { at: "2026-10-30 23:59" });

  assert.ok(!app.llmTasks.some((task) => task.endsWith(":reconsider")));
  assert.deepEqual(harnessReservations(app), []);
  await app.advanceTo("2026-10-31 00:01");
  assert.equal(app.row("SELECT state FROM goals").state, "expired");
});

test("66: 후속 확인 예약은 여러 개여도 개시 예약 상한에 걸리지 않는다", async (t) => {
  const app = await startWithEndingTurn(
    t,
    async (turn) => {
      for (const title of ["물", "책", "산책"]) await turn.createGoal({ title });
      return turn.end("이따 봐");
    },
    { config: { open_max_pending: "1" } },
  );

  assert.equal(harnessReservations(app).length, 3);
});

test("67: 닫히는 턴의 io 중에 온 메시지는 흐름 밖 판정 대기가 되어 판정 턴이 받는다", async (t) => {
  const gate = new Gate();
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
    async (turn) => {
      await gate.wait();
      return turn.end("잘 가");
    },
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  await app.user("갈게");
  await app.advance({ seconds: 20 });
  await app.user("아 하나만 더");

  gate.open();
  await app.advance({ seconds: 21 });

  assert.deepEqual(
    app.rows("SELECT flow_id, triage FROM messages WHERE content = '아 하나만 더'"),
    [{ flow_id: null, triage: "ignored" }],
  );
  assert.deepEqual(app.llmTasks.slice(3), ["10-30 10:00 cleanup", "10-30 10:01 turn:user"]);
});

test("68: 사용자가 끝내 답하지 않은 흐름도 정리한다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(
      (turn) => turn.say("산책 갔어?", { continueAfter: { minutes: 30 } }),
      (turn) => turn.end("답이 없네, 이따 다시 볼게"),
    );
  const app = await startApp(t, { llm });

  await app.advanceTo("11:01");

  assert.deepEqual(app.llmTasks.slice(1), [
    "10-30 10:30 turn:open#1",
    "10-30 11:00 turn:continue",
    "10-30 11:00 cleanup",
  ]);
  assert.equal(app.row("SELECT cleanup_status FROM flows").cleanup_status, "done");
});

test("69: 정리 규칙 파일이 없으면 정리는 skipped고 정리 작업이 돌지 않는다", async (t) => {
  const app = await startWithEndingTurn(t, (turn) => turn.end("그래"), { cleanupRules: false });

  assert.equal(app.row("SELECT cleanup_status FROM flows").cleanup_status, "skipped");
  assert.ok(!app.llmTasks.some((task) => task.endsWith("cleanup")));
});
