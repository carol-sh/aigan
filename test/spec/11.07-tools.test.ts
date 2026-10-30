import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { ToolResult } from "../../src/worker/tools/tool-box.ts";
import { ScriptedLlm, type ScriptedTurn } from "../fakes/scripted-llm.ts";
import { type StartOptions, type TestApp, startApp } from "../rig.ts";

/** 사용자가 연 첫 턴에서 각본대로 도구를 쓰고 한 줄 말한 뒤 1시간 뒤로 이어간다. */
async function startWithUserTurn(
  t: TestContext,
  useTools: (turn: ScriptedTurn) => unknown,
  options: StartOptions = {},
): Promise<TestApp> {
  const llm = (options.llm ?? new ScriptedLlm()).onTurn(async (turn) => {
    await useTools(turn);
    return turn.say("응", { continueAfter: { hours: 1 } });
  });
  const app = await startApp(t, { ...options, llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  return app;
}

function assertRejected(result: ToolResult | undefined, reason?: RegExp): void {
  assert.equal(result?.ok, false, `거부돼야 한다: ${JSON.stringify(result)}`);
  if (reason && result && !result.ok) assert.match(result.reason, reason);
}

function goalArgs(title: string, extra: Record<string, unknown> = {}) {
  return { job_id: "sample", title, done_criteria: "끝", ...extra };
}

test("49: 활성 목표가 goal_max_active개면 goal_create는 거부되고 턴은 계속된다", async (t) => {
  const results: ToolResult[] = [];
  const app = await startWithUserTurn(
    t,
    async (turn) => {
      for (const title of ["물", "책", "산책"])
        results.push(await turn.use("goal_create", goalArgs(title)));
    },
    { config: { goal_max_active: "2" } },
  );

  assert.deepEqual(results.slice(0, 2), [
    { ok: true, goal_id: 1 },
    { ok: true, goal_id: 2 },
  ]);
  assertRejected(results[2], /2개/);
  assert.deepEqual(app.telegram.sent, ["응"]);
  assert.equal(app.rows("SELECT id FROM goals").length, 2);
});

test("50, 50a: 없는 방침 id는 goal_create와 job_read 모두 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) => {
    results.push(await turn.use("goal_create", goalArgs("물", { job_id: "nope" })));
    results.push(await turn.use("job_read", { job_id: "nope" }));
    results.push(await turn.use("job_read", { job_id: "sample" }));
  });

  assertRejected(results[0], /nope/);
  assertRejected(results[1], /nope/);
  assert.equal(results[2]?.ok, true);
});

test("51: goal_create는 방침 본문을 job_snapshot으로 복사하고 흐름에 목표를 붙인다", async (t) => {
  const app = await startWithUserTurn(
    t,
    async (turn) => await turn.createGoal({ title: "물 2리터" }),
  );

  const job = app.harness.ctx.prompts.jobPolicies.find(({ id }) => id === "sample");
  assert.deepEqual(app.row("SELECT job_id, job_snapshot, plan_date, state FROM goals"), {
    job_id: "sample",
    job_snapshot: job?.prompt,
    plan_date: "2026-10-30",
    state: "active",
  });
  assert.deepEqual(app.rows("SELECT flow_id, goal_id FROM flow_goals"), [
    { flow_id: 1, goal_id: 1 },
  ]);
});

test("52: 활성이 아닌 목표의 goal_update·goal_close는 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) => {
    const goalId = await turn.createGoal({ title: "물" });
    await turn.use("goal_close", { goal_id: goalId, result: "done", reason: "다 마심" });
    results.push(await turn.use("goal_update", { goal_id: goalId, progress: "반" }));
    results.push(
      await turn.use("goal_close", { goal_id: goalId, result: "failed", reason: "다시" }),
    );
    results.push(await turn.use("goal_update", { goal_id: 99, progress: "반" }));
  });

  for (const result of results) assertRejected(result, /활성 목표가 아니다/);
});

test("53: goal_close는 걸린 예약을 남기고, 발화 때 사전 검사가 턴 없이 지운다", async (t) => {
  const llm = new ScriptedLlm().onTurn(async (turn) => {
    const goalId = await turn.createGoal({ title: "물" });
    await turn.reserveOpening({ at: "10:30", goalIds: [goalId] });
    await turn.use("goal_close", { goal_id: goalId, result: "dropped", reason: "필요 없어짐" });
    return turn.end("그럼 됐어");
  });
  const app = await startApp(t, { llm });
  await app.user("물 안 마실래");
  await app.advance({ seconds: 20 });
  assert.deepEqual(app.rows("SELECT kind FROM reservations"), [{ kind: "open" }]);

  await app.advanceTo("10:31");

  assert.deepEqual(app.rows("SELECT kind FROM reservations"), []);
  assert.ok(!app.llmTasks.some((task) => task.includes("turn:open")));
});

test("54: open_reserve의 goal_ids에 활성이 아닌 목표가 있으면 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) => {
    const goalId = await turn.createGoal({ title: "물" });
    await turn.use("goal_close", { goal_id: goalId, result: "done", reason: "다 마심" });
    results.push(
      await turn.use("open_reserve", {
        at: turn.time("15:00"),
        intent: "확인",
        goal_ids: [goalId],
      }),
    );
    results.push(
      await turn.use("open_reserve", { at: turn.time("15:00"), intent: "확인", goal_ids: [42] }),
    );
  });

  assertRejected(results[0], /활성 목표가 아니다/);
  assertRejected(results[1], /42/);
});

test("55: open_reserve는 scheduled와 fired 개시 예약을 상한에 넣는다", async (t) => {
  const results: ToolResult[] = [];
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }, { at: "15:00" }] }))
    .onTurn(
      async (turn) => turn.say("응", { continueAfter: { hours: 2 } }),
      async (turn) => {
        results.push(await turn.use("open_reserve", { at: turn.time("16:00"), intent: "하나" }));
        results.push(await turn.use("open_reserve", { at: turn.time("17:00"), intent: "둘" }));
        return turn.say("알았어", { continueAfter: { hours: 1 } });
      },
    );
  const app = await startApp(t, { llm, config: { open_max_pending: "3" } });
  await app.user("시작");
  await app.advanceTo("10:40");
  await app.user("나중에 다시 와");
  await app.advance({ seconds: 20 });

  assert.equal(results[0]?.ok, true);
  assertRejected(results[1], /3개/);
});

test("55: 하네스 후속 확인 예약은 open_reserve 상한에 넣지 않는다", async (t) => {
  const results: ToolResult[] = [];
  const llm = new ScriptedLlm().onTurn(
    async (turn) => {
      await turn.createGoal({ title: "물" });
      await turn.createGoal({ title: "책" });
      return turn.end("이따 봐");
    },
    async (turn) => {
      results.push(await turn.use("open_reserve", { at: turn.time("16:00"), intent: "하나" }));
      results.push(await turn.use("open_reserve", { at: turn.time("17:00"), intent: "둘" }));
      return turn.say("알았어", { continueAfter: { hours: 1 } });
    },
  );
  const app = await startApp(t, { llm, config: { open_max_pending: "1" } });
  await app.user("시작");
  await app.advanceTo("10:05");
  await app.user("또 왔어");
  await app.advance({ seconds: 20 });

  assert.equal(app.rows("SELECT id FROM reservations WHERE source = 'harness'").length, 2);
  assert.equal(results[0]?.ok, true);
  assertRejected(results[1], /1개/);
});

test("56, 58c: AI 개시 턴의 자기 예약은 상한 집계에서 빠지고 고치거나 취소할 수 없다 (L5)", async (t) => {
  const results: ToolResult[] = [];
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(async (turn) => {
      results.push(await turn.use("open_reserve", { at: turn.time("15:00"), intent: "다음" }));
      results.push(await turn.use("open_cancel", { reservation_id: 1 }));
      results.push(await turn.use("open_update", { reservation_id: 1, intent: "바꿈" }));
      return turn.say("산책 가자", { continueAfter: { hours: 1 } });
    });
  await startApp(t, { llm, config: { open_max_pending: "1" } }).then((app) =>
    app.advanceTo("10:31"),
  );

  assert.equal(results[0]?.ok, true);
  assertRejected(results[1], /개시 예약이 아니다/);
  assertRejected(results[2], /개시 예약이 아니다/);
});

test("57: 그날 끝 이후(다음 블랙아웃 안 포함)의 open_reserve는 이유에 그날 끝 시각을 담아 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) => {
    for (const at of ["2026-10-31 00:00", "2026-10-31 03:00", "2026-10-31 09:00"]) {
      results.push(await turn.use("open_reserve", { at, intent: "내일" }));
    }
  });

  for (const result of results) assertRejected(result, /2026-10-31 00:00/);
});

test("57a: 지난 시각의 open_reserve는 now + min_lead로 당긴다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) => {
    results.push(await turn.use("open_reserve", { at: turn.time("09:00"), intent: "아까" }));
  });

  assert.deepEqual(results[0], { ok: true, reservation_id: 1, at: "2026-10-30 10:01" });
});

test("57b: 그날 끝 이후의 마감은 goal_create·goal_update 모두 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) => {
    results.push(await turn.use("goal_create", goalArgs("물", { due_at: "2026-10-31 09:00" })));
    const goalId = await turn.createGoal({ title: "책", dueAt: "18:00" });
    results.push(await turn.use("goal_update", { goal_id: goalId, due_at: "2026-10-31 00:00" }));
  });

  for (const result of results) assertRejected(result, /깨어 있는 구간/);
});

test("57d: 블랙아웃 안의 마감은 깨어 있는 구간을 이유에 담아 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(
    t,
    async (turn) =>
      results.push(await turn.use("goal_create", goalArgs("물", { due_at: turn.time("23:30") }))),
    { at: "2026-10-30 22:30", config: { blackout: "23:00-07:00" } },
  );

  assertRejected(results[0], /2026-10-30 07:00 ~ 2026-10-30 23:00/);
});

test("57c: 그날 끝까지 min_lead도 남지 않으면 open_reserve는 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(
    t,
    async (turn) =>
      results.push(await turn.use("open_reserve", { at: turn.time("23:59"), intent: "막차" })),
    { at: "2026-10-30 23:59" },
  );

  assertRejected(results[0], /남지 않았다/);
});

test("58: 하네스 후속 확인 예약도 open_cancel로 취소할 수 있다", async (t) => {
  const results: ToolResult[] = [];
  const llm = new ScriptedLlm().onTurn(
    async (turn) => {
      await turn.createGoal({ title: "물" });
      return turn.end("이따 봐");
    },
    async (turn) => {
      results.push(await turn.use("open_cancel", { reservation_id: 1 }));
      return turn.say("확인은 지금 하자", { continueAfter: { hours: 1 } });
    },
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advanceTo("10:05");
  await app.user("또 왔어");
  await app.advance({ seconds: 20 });

  assert.deepEqual(results, [{ ok: true }]);
  assert.deepEqual(app.rows("SELECT kind FROM reservations"), [{ kind: "continue" }]);
});

test("58b: 계획 예약에 open_update로 새 목표를 붙이고 끝내면 되묻지 않고 상한 집계도 그대로다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "15:00", intent: "오후 확인" }] }))
    .onTurn(async (turn) => {
      const goalId = await turn.createGoal({ title: "물" });
      await turn.use("open_update", { reservation_id: 1, goal_ids: [goalId] });
      return turn.end("3시에 볼게");
    });
  const app = await startApp(t, { llm, config: { open_max_pending: "1" } });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });

  assert.deepEqual(app.rows("SELECT reservation_id, goal_id FROM reservation_goals"), [
    { reservation_id: 1, goal_id: 1 },
  ]);
  assert.deepEqual(app.rows("SELECT source FROM reservations"), [{ source: "plan" }]);
  assert.ok(!app.llmTasks.some((task) => task.endsWith(":reconsider")));
});

test("58c: 없는 예약, 이어가기 예약, 바꿀 필드 없는 open_update는 거부한다", async (t) => {
  const results: ToolResult[] = [];
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "15:00" }] }))
    .onTurn(
      async (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
      async (turn) => {
        results.push(await turn.use("open_update", { reservation_id: 99, intent: "x" }));
        results.push(await turn.use("open_update", { reservation_id: 2, intent: "x" }));
        results.push(await turn.use("open_update", { reservation_id: 1 }));
        return turn.say("응", { continueAfter: { hours: 1 } });
      },
    );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  await app.user("또");
  await app.advance({ seconds: 20 });

  assert.equal(app.row("SELECT kind FROM reservations WHERE id = 2").kind, "continue");
  assertRejected(results[0], /개시 예약이 아니다/);
  assertRejected(results[1], /개시 예약이 아니다/);
  assertRejected(results[2], /바꿀 필드가 없다/);
});

test("58d: open_update의 goal_ids에 활성이 아닌 목표가 있거나 at이 그날 끝 이후면 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(
    t,
    async (turn) => {
      results.push(await turn.use("open_update", { reservation_id: 1, goal_ids: [7] }));
      results.push(await turn.use("open_update", { reservation_id: 1, at: "2026-10-31 09:00" }));
    },
    { llm: new ScriptedLlm().onPlan((plan) => plan.finishPlan({ openings: [{ at: "15:00" }] })) },
  );

  assertRejected(results[0], /활성 목표가 아니다/);
  assertRejected(results[1], /그날 끝/);
});

test("58e: 흐름 중 밀린 개시 예약의 at을 바꾸면 scheduled로 돌아가고, 그 시각에도 흐름이 열려 있으면 다시 밀린다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(
      async (turn) => turn.say("응", { continueAfter: { hours: 2 } }),
      async (turn) => {
        await turn.use("open_update", { reservation_id: 1, at: turn.time("11:00") });
        return turn.say("산책은 11시에", { continueAfter: { hours: 2 } });
      },
    );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advanceTo("10:40");
  await app.user("지금은 바빠");
  await app.advance({ seconds: 20 });

  assert.deepEqual(app.row("SELECT at, state FROM reservations WHERE id = 1"), {
    at: app.at("11:00").toISO(),
    state: "scheduled",
  });
  await app.advanceTo("11:01");
  assert.equal(app.row("SELECT state FROM reservations WHERE id = 1").state, "fired");
  assert.ok(!app.llmTasks.some((task) => task.includes("turn:open")));
});

test("58f: open_update가 goal_ids만 바꾸면 밀린 예약의 state와 at은 그대로다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(
      async (turn) => turn.say("응", { continueAfter: { hours: 2 } }),
      async (turn) => {
        const goalId = await turn.createGoal({ title: "산책" });
        await turn.use("open_update", { reservation_id: 1, goal_ids: [goalId] });
        return turn.say("산책 목표로 할게", { continueAfter: { hours: 2 } });
      },
    );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advanceTo("10:40");
  await app.user("산책 갈까");
  await app.advance({ seconds: 20 });

  assert.deepEqual(app.row("SELECT at, state FROM reservations WHERE id = 1"), {
    at: app.at("10:30").toISO(),
    state: "fired",
  });
});

test("59, 61c: 목록 밖 도구와 정리 전용 기억 쓰기 도구는 턴에서 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) => {
    for (const name of ["web_search", "state_write", "memory_write", "memory_delete"]) {
      results.push(await turn.use(name, { content: "x", title: "x" }));
    }
  });

  for (const result of results) assertRejected(result, /쓸 수 없는 도구/);
});

test("60: 도구 효과는 다음 라운드가 읽는 상태에 바로 반영된다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) => {
    const goalId = await turn.createGoal({ title: "물" });
    results.push(await turn.use("goal_update", { goal_id: goalId, progress: "1리터" }));
    const reservationId = await turn.reserveOpening({ at: "15:00", goalIds: [goalId] });
    results.push(await turn.use("open_cancel", { reservation_id: reservationId }));
    results.push(
      await turn.use("goal_close", { goal_id: goalId, result: "done", reason: "다 마심" }),
    );
    results.push(await turn.use("goal_update", { goal_id: goalId, progress: "2리터" }));
  });

  assert.deepEqual(results.slice(0, 3), [{ ok: true }, { ok: true }, { ok: true }]);
  assertRejected(results[3], /활성 목표가 아니다/);
});

test("61b: 없는 기억 칸의 memory_read는 거부한다", async (t) => {
  const results: ToolResult[] = [];
  await startWithUserTurn(t, async (turn) =>
    results.push(await turn.use("memory_read", { title: "약점" })),
  );

  assertRejected(results[0], /약점/);
});

test("도구 라운드가 max_tool_rounds에 닿으면 도구 목록은 둔 채 tool_choice none으로 최종 답을 받는다", async (t) => {
  const results: ToolResult[] = [];
  const app = await startWithUserTurn(
    t,
    async (turn) => {
      for (const title of ["물", "책", "산책"]) {
        results.push(await turn.use("goal_create", goalArgs(title)));
      }
    },
    { config: { max_tool_rounds: "2" } },
  );

  const requests = app.llm.requestsOf("turn");
  assert.deepEqual(
    requests.map((request) => request.tool_choice ?? "auto"),
    ["auto", "auto", "none"],
  );
  assert.deepEqual(
    requests.map((request) => request.tools?.length),
    [8, 8, 8],
  );
  assertRejected(results[2], /도구를 쓸 수 없는 호출/);
  assert.deepEqual(app.rows("SELECT title FROM goals"), [{ title: "물" }, { title: "책" }]);
  assert.equal(app.rows("SELECT id FROM llm_calls").length, 3);
  assert.deepEqual(app.telegram.sent, ["응"]);
});

test("한 답에서 부른 도구 여러 개는 순서대로 실행되고 각자 결과를 받는다", async (t) => {
  let results: ToolResult[] = [];
  const app = await startWithUserTurn(t, async (turn) => {
    results = await turn.useAll([
      { name: "goal_create", args: goalArgs("물") },
      { name: "goal_update", args: { goal_id: 1, progress: "한 잔" } },
    ]);
  });

  assert.deepEqual(results, [{ ok: true, goal_id: 1 }, { ok: true }]);
  assert.equal(app.llm.requestsOf("turn").length, 2);
  assert.equal(app.row("SELECT progress FROM goals").progress, "한 잔");
});

test("도구 인자가 JSON이 아니면 거부 결과를 돌려주고 턴은 계속된다", async (t) => {
  const results: ToolResult[] = [];
  const app = await startWithUserTurn(t, async (turn) => {
    results.push(await turn.use("goal_create", '{"job_id": "sample", "title": '));
  });

  assertRejected(results[0], /도구 인자가 JSON이 아니다/);
  assert.deepEqual(app.telegram.sent, ["응"]);
});
