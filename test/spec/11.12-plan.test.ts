import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DateTime } from "luxon";
import type { ToolResult } from "../../src/worker/tools/tool-box.ts";
import { ScriptedLlm, inputSection } from "../fakes/scripted-llm.ts";
import { type TestApp, startApp } from "../rig.ts";

/** 개시 예약을 `id 로컬시각 source [목표]`로. */
function openings(app: TestApp): string[] {
  return app
    .rows<{ id: number; at: string; source: string }>(
      "SELECT id, at, source FROM reservations WHERE kind = 'open' ORDER BY id",
    )
    .map(({ id, at, source }) => {
      const goalIds = app
        .rows<{ goal_id: number }>(
          "SELECT goal_id FROM reservation_goals WHERE reservation_id = ?",
          id,
        )
        .map(({ goal_id }) => goal_id);
      const time = DateTime.fromISO(at).setZone("Asia/Seoul").toFormat("MM-dd HH:mm");
      return [`#${id}`, time, source, goalIds.length > 0 && `[${goalIds.join(", ")}]`]
        .filter(Boolean)
        .join(" ");
    });
}

function planLogs(app: TestApp): string[] {
  return app.logger.lines.filter((line) => line.startsWith("info 계획 예약"));
}

function lastPlanDate(app: TestApp): unknown {
  return app.row("SELECT last_plan_date FROM harness_state").last_plan_date;
}

test("91: 00:00-08:00이면 계획일마다 한 번, 블랙아웃 시작에 돈다", async (t) => {
  const app = await startApp(t);

  await app.advanceTo("2026-10-31 10:00");

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-31 00:00 plan"]);
  assert.deepEqual(app.rows("SELECT plan_date FROM plans ORDER BY plan_date"), [
    { plan_date: "2026-10-30" },
    { plan_date: "2026-10-31" },
  ]);
  assert.equal(lastPlanDate(app), "2026-10-31");
});

test("92, 93: 23:00-07:00이면 D+1 01:00에 재시작해도 다시 돌지 않고, D+1 23:00 진입에 계획일 D+2로 돈다", async (t) => {
  const app = await startApp(t, { at: "2026-10-30 22:00", config: { blackout: "23:00-07:00" } });
  await app.advanceTo("23:30");
  assert.equal(lastPlanDate(app), "2026-10-31");

  await app.restart({ downFor: { minutes: 90 } });
  await app.advanceTo("22:59");
  assert.deepEqual(app.llmTasks, ["10-30 22:00 plan", "10-30 23:00 plan"]);

  await app.advanceTo("23:01");
  assert.deepEqual(app.llmTasks.slice(2), ["10-31 23:00 plan"]);
  assert.equal(lastPlanDate(app), "2026-11-01");
});

test("94: 계획이 실패하면 경고를 남기고 failure_backoff로 다시 하며, 그 사이 턴은 돈다", async (t) => {
  const llm = new ScriptedLlm().onPlan(
    (plan) => plan.failPlan(),
    (plan) => plan.failPlan(),
    (plan) => plan.finishPlan(),
  );
  const app = await startApp(t, { llm });
  assert.deepEqual(app.row("SELECT plan_attempts, plan_retry_at FROM harness_state"), {
    plan_attempts: 1,
    plan_retry_at: app.at("10:10").toISO(),
  });
  await app.advanceTo("10:05");
  await app.user("안녕");

  await app.advanceTo("10:31");

  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:05 turn:user",
    "10-30 10:10 plan",
    "10-30 10:30 plan",
  ]);
  assert.deepEqual(
    app.logger.lines.filter((line) => line.startsWith("warn 계획일")),
    [
      "warn 계획일 2026-10-30의 계획이 실패했다(1번째): Error: api: 각본이 계획을 실패시켰다",
      "warn 계획일 2026-10-30의 계획이 실패했다(2번째): Error: api: 각본이 계획을 실패시켰다",
    ],
  );
  assert.deepEqual(
    app.row("SELECT plan_attempts, plan_retry_at, last_plan_date FROM harness_state"),
    {
      plan_attempts: 0,
      plan_retry_at: null,
      last_plan_date: "2026-10-30",
    },
  );
});

test("계획이 읽을 수 없는 답을 내면 한 번 더 묻고, 또 못 읽으면 실패로 백오프한다", async (t) => {
  const fixed = await startApp(t, {
    llm: new ScriptedLlm().onPlan((plan) =>
      plan.malformed({ onRetry: plan.finishPlan({ body: "고친 계획" }) }),
    ),
  });
  assert.deepEqual(fixed.rows("SELECT body FROM plans"), [{ body: "고친 계획" }]);
  assert.deepEqual(fixed.rows("SELECT kind, flow_id, success FROM llm_calls ORDER BY id"), [
    { kind: "plan", flow_id: null, success: 0 },
    { kind: "plan", flow_id: null, success: 1 },
  ]);
  assert.equal(fixed.llm.requestsOf("plan")[1]?.tool_choice, "none");

  const broken = await startApp(t, {
    llm: new ScriptedLlm().onPlan((plan) => plan.malformed()),
  });
  assert.deepEqual(broken.rows("SELECT body FROM plans"), []);
  assert.deepEqual(broken.row("SELECT plan_attempts, plan_retry_at FROM harness_state"), {
    plan_attempts: 1,
    plan_retry_at: broken.at("10:10").toISO(),
  });
});

test("95: 계획 입력은 plan-rules만 system에 두고, 방침·기억·지난 recent_goal_days일 종료 목표·계획일을 보여 준다", async (t) => {
  const llm = new ScriptedLlm()
    .onTurn(
      async (turn) => {
        const old = await turn.createGoal({ title: "옛 목표" });
        await turn.use("goal_close", { goal_id: old, result: "done", reason: "끝냄" });
        return turn.end("좋아");
      },
      async (turn) => {
        const book = await turn.createGoal({ title: "책" });
        await turn.use("goal_update", { goal_id: book, progress: "50쪽" });
        await turn.reserveOpening({ at: "15:00", goalIds: [book] });
        return turn.end("3시에 볼게");
      },
      async (turn) => {
        const water = await turn.createGoal({ title: "물" });
        await turn.use("goal_update", { goal_id: water, progress: "1리터" });
        await turn.reserveOpening({ at: "15:00", goalIds: [water] });
        return turn.end("3시에 볼게");
      },
    )
    .onCleanup(async (cleanup) => {
      await cleanup.use("state_write", { content: "아침형" });
      await cleanup.use("memory_write", { title: "습관", content: "저녁에 끝낸다" });
    });
  const app = await startApp(t, {
    at: "2026-10-22 10:00",
    llm,
    preparePrompts: (dir) => writeFileSync(join(dir, "persona.md"), "까칠한 코치"),
  });
  await app.user("옛 일");
  await app.advance({ seconds: 20 });
  await app.restart({ downFor: { days: 1 } });
  await app.user("책 읽을래");
  await app.advance({ seconds: 20 });
  // 10-29 아침에 부팅하면 날 넘김이 책을 닫는다(계획일 10-23, 직전 계획일 아님).
  await app.restart({ downFor: { days: 6 } });
  await app.user("물 마실래");
  await app.advance({ seconds: 20 });

  // 10-30 00:01에 부팅하면 날 넘김이 물을 닫고(계획일 10-29 = 직전 계획일) 계획이 돈다.
  await app.advanceTo("2026-10-29 10:01");
  await app.restart({ downFor: { hours: 14 } });

  const input = app.llm.lastInput("plan");
  assert.deepEqual(inputSection(input, "방침"), [
    "- sample: 한 줄 설명. 계획과 턴의 방침 목록에 이 줄이 보인다",
  ]);
  assert.deepEqual(inputSection(input, "기억"), [
    "아침형",
    "칸: 습관",
    "[칸 습관]",
    "  저녁에 끝낸다",
  ]);
  assert.deepEqual(inputSection(input, "활성 목표"), ["(없음)"]);
  assert.deepEqual(inputSection(input, "최근 종료 목표"), [
    "- #2 책 (sample) [expired] 날 넘김 — 10-29 10:00 종료",
    "- #3 물 (sample) [expired] 날 넘김 — 00:01 종료",
    "  진행 메모: 1리터",
  ]);
  assert.deepEqual(inputSection(input, "남아 있는 개시 예약"), ["(없음)"]);
  assert.deepEqual(inputSection(input, "계획일"), [
    "계획일: 2026-10-30",
    "깨어 있는 구간: 2026-10-30 08:00 – 2026-10-31 00:00",
    "지금: 2026-10-30 00:01",
  ]);
  const request = app.llm.requestsOf("plan").at(-1)!;
  assert.equal(
    request.messages[0]?.content,
    readFileSync(join(app.dataDir, "prompts", "plan-rules.md"), "utf8"),
  );
  assert.deepEqual(
    request.tools?.map((tool) => (tool.type === "function" ? tool.function.name : "")),
    ["memory_read"],
  );
});

test("90: 계획에는 memory_read만 주고 턴·정리 도구는 거부한다", async (t) => {
  const results: ToolResult[] = [];
  const llm = new ScriptedLlm()
    .onPlan(
      (plan) => plan.failPlan(),
      async (plan) => {
        results.push(await plan.use("memory_read", { title: "습관" }));
        results.push(
          await plan.use("goal_create", { job_id: "sample", title: "x", done_criteria: "" }),
        );
        results.push(await plan.use("state_write", { content: "x" }));
        return plan.finishPlan();
      },
    )
    .onTurn((turn) => turn.end("그래"))
    .onCleanup(async (cleanup) => {
      await cleanup.use("memory_write", { title: "습관", content: "아침형" });
    });
  const app = await startApp(t, { llm });
  await app.user("안녕");
  await app.advance({ seconds: 20 });

  await app.advanceTo("10:10");

  assert.deepEqual(results[0], { ok: true, content: "아침형" });
  for (const result of results.slice(1)) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /쓸 수 없는 도구/);
  }
  assert.equal(lastPlanDate(app), "2026-10-30");
});

test("96: 예약이 open_max_pending을 넘으면 at이 이른 순으로 상한까지 넣고 나머지는 로그에 남긴다", async (t) => {
  const llm = new ScriptedLlm().onPlan((plan) =>
    plan.finishPlan({
      openings: ["15:00", "11:00", "23:00", "13:00", "12:00"].map((at) => ({ at, intent: at })),
    }),
  );
  const app = await startApp(t, { llm, config: { open_max_pending: "3" } });

  assert.deepEqual(openings(app), [
    "#1 10-30 11:00 plan",
    "#2 10-30 12:00 plan",
    "#3 10-30 13:00 plan",
  ]);
  assert.deepEqual(planLogs(app), [
    "info 계획 예약을 버렸다(개시 예약 상한(3개)): 2026-10-30 15:00 15:00",
    "info 계획 예약을 버렸다(개시 예약 상한(3개)): 2026-10-30 23:00 23:00",
  ]);
});

test("97, 계획 goal_ids: 같은 날 다시 돈 계획은 활성 목표와 남은 예약을 보고, 그 예약을 그대로 둔 채 더하며 활성 목표가 아닌 id는 뺀다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan(
      (plan) => plan.failPlan(),
      (plan) =>
        plan.finishPlan({ openings: [{ at: "16:00", intent: "물 확인", goalIds: [1, 9] }] }),
    )
    .onTurn(async (turn) => {
      const water = await turn.createGoal({ title: "물", dueAt: "18:00" });
      await turn.reserveOpening({ at: "15:00", intent: "중간 확인", goalIds: [water] });
      return turn.end("물 마셔");
    });
  const app = await startApp(t, { llm });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });

  await app.advanceTo("10:10");

  const input = app.llm.lastInput("plan");
  assert.deepEqual(inputSection(input, "활성 목표"), [
    "- #1 물 (sample, 마감 2026-10-30 18:00)",
    "  완료 조건: 물 끝",
    "  진행 메모: (없음)",
  ]);
  assert.deepEqual(inputSection(input, "남아 있는 개시 예약"), [
    "- #1 2026-10-30 15:00 중간 확인 [목표 1] (turn)",
  ]);
  assert.deepEqual(openings(app), ["#1 10-30 15:00 turn [1]", "#2 10-30 16:00 plan [1]"]);
  assert.deepEqual(planLogs(app), [
    "info 계획 예약에서 활성 목표가 아닌 것을 뺐다(#9): 2026-10-30 16:00 물 확인",
  ]);
});

test("98: 기존 예약으로 상한에 가까우면 계획의 새 예약만 잘리고, 기존 예약과 목표 확인은 그대로다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan(
      (plan) => plan.failPlan(),
      (plan) => plan.finishPlan({ openings: [{ at: "12:00" }, { at: "11:00" }] }),
    )
    .onTurn(async (turn) => {
      const water = await turn.createGoal({ title: "물" });
      await turn.reserveOpening({ at: "15:00", goalIds: [water] });
      await turn.reserveOpening({ at: "14:00" });
      return turn.end("이따 봐");
    });
  const app = await startApp(t, { llm, config: { open_max_pending: "3" } });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });

  await app.advanceTo("10:10");

  assert.deepEqual(openings(app), [
    "#1 10-30 15:00 turn [1]",
    "#2 10-30 14:00 turn",
    "#3 10-30 11:00 plan",
  ]);
  assert.deepEqual(planLogs(app), [
    "info 계획 예약을 버렸다(개시 예약 상한(3개)): 2026-10-30 12:00 개입",
  ]);
});

test("99: 계획 예약이 그날 끝 이후면 버리고, 과거면 now+min_lead로, 블랙아웃 안이면 블랙아웃 끝으로 당긴다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan(
      (plan) =>
        plan.finishPlan({
          openings: [
            { at: "09:00", intent: "지난 시각" },
            { at: "2026-10-31 09:00", intent: "내일" },
          ],
        }),
      (plan) => plan.finishPlan({ openings: [{ at: "07:00", intent: "새벽" }] }),
    )
    .onTurn((turn) => turn.silent());
  const app = await startApp(t, { llm });
  assert.deepEqual(openings(app), ["#1 10-30 10:01 plan"]);
  assert.deepEqual(planLogs(app), [
    "info 계획 예약을 버렸다(그날 끝(2026-10-31 00:00) 이후로는 예약할 수 없다): 2026-10-31 09:00 내일",
  ]);

  await app.advanceTo("2026-10-31 00:01");

  assert.deepEqual(openings(app), ["#1 10-31 08:00 plan"]);
});
