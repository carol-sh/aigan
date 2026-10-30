import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedLlm, type TurnScript } from "../fakes/scripted-llm.ts";
import { startApp } from "../rig.ts";

/** 사용자 흐름에서 목표를 만들고 그 목표를 겨냥한 개시 예약을 잡은 뒤 흐름을 닫는다. */
function goalsCheckedAt(checkAt: string, titles: string[]): TurnScript {
  return async (turn) => {
    const goalIds: number[] = [];
    for (const title of titles) goalIds.push(await turn.createGoal({ title }));
    await turn.reserveOpening({ at: checkAt, intent: "진행 확인", goalIds });
    return turn.end("이따 볼게");
  };
}

test("23: 흐름이 없을 때 개시 예약이 발화하면 AI가 연 흐름이 되고 예약의 목표가 흐름에 붙는다", async (t) => {
  const llm = new ScriptedLlm().onTurn(goalsCheckedAt("11:00", ["물 2리터"]), (turn) =>
    turn.say("물 얼마나 마셨어?", { continueAfter: { minutes: 30 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("오늘 할 일");
  await app.advance({ seconds: 20 });

  await app.advanceTo("11:01");

  assert.deepEqual(
    app.row(
      "SELECT opener, opened_by_reservation_id, opened_intent, plan_date FROM flows WHERE id = 2",
    ),
    {
      opener: "ai",
      opened_by_reservation_id: 1,
      opened_intent: "진행 확인",
      plan_date: "2026-10-30",
    },
  );
  assert.deepEqual(app.rows("SELECT flow_id, goal_id FROM flow_goals WHERE flow_id = 2"), [
    { flow_id: 2, goal_id: 1 },
  ]);
  assert.deepEqual(app.rows("SELECT kind, flow_id FROM reservations"), [
    { kind: "continue", flow_id: 2 },
  ]);
});

test("24: 개시 턴이 말이 없으면 이어가든 끝내든 흐름을 열지 않고 예약을 지운다 (L6)", async (t) => {
  for (const silentOutput of ["silent", "silentEnd"] as const) {
    await t.test(silentOutput, async (t) => {
      const llm = new ScriptedLlm()
        .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
        .onTurn(async (turn) => turn[silentOutput]());
      const app = await startApp(t, { llm });

      await app.advanceTo("10:31");

      assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 10:30 turn:open#1"]);
      assert.deepEqual(app.rows("SELECT id FROM flows"), []);
      assert.deepEqual(app.rows("SELECT id FROM reservations"), []);
    });
  }
});

test("25: 말 없는 개시 턴이 목표의 유일한 예약을 쓰면 한 번 되묻고, 또 말이 없으면 후속 확인을 잡는다", async (t) => {
  const reconsideredGoals: string[] = [];
  const llm = new ScriptedLlm()
    .onTurn(goalsCheckedAt("11:00", ["물 2리터"]), async (turn) => turn.silent())
    .onReconsider(async (turn) => {
      reconsideredGoals.push(...turn.goalsWithoutNextCheck.map((goal) => goal.title));
      return turn.silent();
    });
  const app = await startApp(t, { llm });
  await app.user("오늘 할 일");
  await app.advance({ seconds: 20 });

  await app.advanceTo("11:01");

  assert.deepEqual(app.llmTasks.slice(3), [
    "10-30 11:00 turn:open#1",
    "10-30 11:00 turn:open#1:reconsider",
  ]);
  assert.deepEqual(reconsideredGoals, ["물 2리터"]);
  assert.deepEqual(app.row("SELECT at, source, intent FROM reservations"), {
    at: app.at("12:00").toISO(),
    source: "harness",
    intent: "후속 확인",
  });
});

test("26: 말 없는 개시 턴의 도구 효과는 모두 버리고 로그에 남긴다 (L6)", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(async (turn) => {
      const goalId = await turn.createGoal({ title: "산책" });
      await turn.reserveOpening({ at: "15:00", goalIds: [goalId] });
      return turn.silent();
    });
  const app = await startApp(t, { llm });

  await app.advanceTo("10:31");

  assert.deepEqual(app.rows("SELECT id FROM goals"), []);
  assert.deepEqual(app.rows("SELECT id FROM reservations"), []);
  assert.ok(app.logger.lines.some((line) => line.includes("도구 효과를 버렸다")));
});

test("27: 겨냥한 목표가 모두 닫힌 개시 예약은 턴 없이 지운다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    async (turn) => {
      const goalId = await turn.createGoal({ title: "물 2리터" });
      await turn.reserveOpening({ at: "11:00", goalIds: [goalId] });
      return turn.say("물 마셔", { continueAfter: { minutes: 10 } });
    },
    async (turn) => {
      await turn.use("goal_close", { goal_id: 1, result: "done", reason: "다 마심" });
      return turn.end("잘했어");
    },
  );
  const app = await startApp(t, { llm });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });

  await app.advanceTo("11:01");

  assert.ok(!app.llmTasks.some((task) => task.includes("turn:open")));
  assert.deepEqual(app.rows("SELECT id FROM reservations"), []);
});

test("28: 겨냥한 목표 중 일부만 닫혔으면 개시한다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    async (turn) => {
      const goalIds = [
        await turn.createGoal({ title: "물" }),
        await turn.createGoal({ title: "책" }),
      ];
      await turn.reserveOpening({ at: "11:00", goalIds });
      return turn.say("둘 다 해", { continueAfter: { minutes: 10 } });
    },
    async (turn) => {
      await turn.use("goal_close", { goal_id: 1, result: "done", reason: "다 마심" });
      return turn.end("책은 이따 보자");
    },
    (turn) => turn.say("책 읽었어?", { continueAfter: { minutes: 30 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });

  await app.advanceTo("11:01");

  assert.ok(app.llmTasks.includes("10-30 11:00 turn:open#1"));
});

test("30: 흐름 중 밀린 개시 예약을 open_cancel로 합치면 지워지고 개시 턴이 돌지 않는다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30", intent: "산책 권유" }] }))
    .onTurn(
      (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
      async (turn) => {
        await turn.use("open_cancel", { reservation_id: 1 });
        return turn.end("산책 얘기도 했으니 됐어");
      },
    );
  const app = await startApp(t, { llm });
  await app.user("심심해");
  await app.advanceTo("10:40");
  await app.user("산책 갈까");

  await app.advanceTo("11:00");

  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:00 turn:user",
    "10-30 10:40 turn:reply",
    "10-30 10:40 cleanup",
  ]);
  assert.deepEqual(app.rows("SELECT id FROM reservations"), []);
});

test("32: 흐름이 닫힌 직후 밀린 개시 예약은 최소 간격 없이 정리 뒤 바로 개시한다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(
      (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
      (turn) => turn.end("그래 이만"),
      (turn) => turn.say("산책 가자", { continueAfter: { hours: 1 } }),
    );
  const app = await startApp(t, { llm });
  await app.user("심심해");
  await app.advanceTo("10:40");
  await app.user("이제 갈게");

  await app.advance({ minutes: 1 });

  assert.deepEqual(app.llmTasks.slice(2), [
    "10-30 10:40 turn:reply",
    "10-30 10:40 cleanup",
    "10-30 10:40 turn:open#1",
  ]);
});
