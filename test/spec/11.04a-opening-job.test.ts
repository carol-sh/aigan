import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResult } from "../../src/worker/tools/tool-box.ts";
import { ScriptedLlm, inputSection } from "../fakes/scripted-llm.ts";
import { type StartOptions, type TestApp, startApp } from "../rig.ts";

const UNSETTLED = "(이 흐름의 방침이 아직 없다. 목표를 만들면 그 방침으로 정해진다)";

/** 방침이 둘이어야 "모든 방침"과 "정해진 방침"이 구분된다. */
const withSecondJob: StartOptions = {
  preparePrompts: (dir) =>
    writeFileSync(
      join(dir, "jobs", "second.md"),
      "---\ndescription: 둘째 일\n---\n## 둘째 본문\n둘째 기준",
    ),
};

function flowJobSection(input: string): string[] {
  return inputSection(input, "이번 흐름 방침");
}

function jobLines(app: TestApp, jobId: string): string[] {
  const job = app.harness.ctx.prompts.jobPolicies.find((policy) => policy.id === jobId)!;
  return [
    `${jobId}: ${job.description}`,
    ...job.prompt
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => `  ${line}`),
  ];
}

function allJobLines(app: TestApp): string[] {
  return [UNSETTLED, ...jobLines(app, "sample"), ...jobLines(app, "second")];
}

test("계획 예약에 단 방침이 개시 턴과 그 흐름의 이후 턴 입력에 본문째 같은 모양으로 보인다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) =>
      plan.finishPlan({
        openings: [{ at: "10:30", intent: "문제 가져오게 하기", jobId: "sample" }],
      }),
    )
    .onTurn(
      (turn) => turn.say("문제 가져와", { continueAfter: { minutes: 10 } }),
      (turn) => turn.end("됐다"),
    );
  const app = await startApp(t, { llm });
  assert.equal(app.row("SELECT job_id FROM reservations WHERE kind = 'open'").job_id, "sample");

  await app.advanceTo("10:30");
  await app.user("가져왔어");
  await app.advance({ seconds: 20 });

  const [openTurn, replyTurn] = llm.inputs("turn");
  assert.deepEqual(inputSection(openTurn!, "이벤트")[0], "계기: AI 개시(개시 예약 #1)");
  assert.deepEqual(flowJobSection(openTurn!), jobLines(app, "sample"));
  assert.deepEqual(flowJobSection(replyTurn!), jobLines(app, "sample"));
  assert.equal(app.row("SELECT job_id FROM flows WHERE id = 1").job_id, "sample");
});

test("방침 없는 계획 예약이 연 흐름과 판정 턴에서는 이번 흐름 방침에 모든 방침 본문이 보인다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30", intent: "안부" }] }))
    .onTurn(
      (turn) => turn.end("응"),
      (turn) => turn.end("왔어"),
    );
  const app = await startApp(t, { ...withSecondJob, llm });
  await app.user("심심해");
  await app.advance({ seconds: 20 });
  await app.advanceTo("10:30");

  const [userTurn, openTurn] = llm.inputs("turn");
  assert.deepEqual(flowJobSection(userTurn!), allJobLines(app));
  assert.deepEqual(flowJobSection(openTurn!), allJobLines(app));
});

test("방침이 정해지지 않은 흐름은 턴마다 같은 글이고, 목표를 처음 만든 턴의 방침으로 정해진 뒤에는 바뀌지 않는다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("뭘 할지 보자", { continueAfter: { minutes: 10 } }),
    (turn) => turn.say("아직이야", { continueAfter: { minutes: 10 } }),
    async (turn) => {
      await turn.createGoal({ title: "둘째 일 하나", jobId: "second" });
      return turn.say("이거 해", { continueAfter: { minutes: 10 } });
    },
    async (turn) => {
      await turn.createGoal({ title: "다른 일", jobId: "sample" });
      return turn.say("이것도", { continueAfter: { minutes: 10 } });
    },
    (turn) => turn.say("계속", { continueAfter: { minutes: 10 } }),
  );
  const app = await startApp(t, { ...withSecondJob, llm });
  for (const text of ["안녕", "뭐 해?", "시켜 봐", "또?", "응"]) {
    await app.user(text);
    await app.advance({ seconds: 20 });
  }

  const sections = llm.inputs("turn").map(flowJobSection);
  assert.deepEqual(sections.slice(0, 3), [allJobLines(app), allJobLines(app), allJobLines(app)]);
  assert.deepEqual(sections.slice(3), [jobLines(app, "second"), jobLines(app, "second")]);
  assert.equal(app.row("SELECT job_id FROM flows WHERE id = 1").job_id, "second");
});

test("판정 턴이 흐름을 열며 목표를 만들면 그 커밋에서 흐름의 방침이 정해진다", async (t) => {
  const llm = new ScriptedLlm().onTurn(async (turn) => {
    await turn.createGoal({ title: "둘째 일 하나", jobId: "second" });
    return turn.say("이거 해", { continueAfter: { minutes: 10 } });
  });
  const app = await startApp(t, { ...withSecondJob, llm });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });

  assert.equal(app.row("SELECT job_id FROM flows WHERE id = 1").job_id, "second");
});

test("계획이 없는 방침을 달면 예약은 남기고 방침만 비운 뒤 로그에 남긴다", async (t) => {
  const llm = new ScriptedLlm().onPlan((plan) =>
    plan.finishPlan({ openings: [{ at: "10:30", intent: "유령 일", jobId: "ghost" }] }),
  );
  const app = await startApp(t, { llm });

  assert.deepEqual(app.rows("SELECT intent, job_id FROM reservations WHERE kind = 'open'"), [
    { intent: "유령 일", job_id: null },
  ]);
  assert.ok(
    app.logger.lines.includes(
      "info 계획 예약에서 없는 방침을 뺐다(ghost): 2026-10-30 10:30 유령 일",
    ),
    app.logger.lines.join("\n"),
  );
});

test("계획 출력의 예약에 job_id 키가 없으면 형식 위반으로 한 번 더 묻는다", async (t) => {
  const llm = new ScriptedLlm().onPlan((plan) => ({
    content: JSON.stringify({
      body: "계획",
      openings: [{ at: "2026-10-30 10:30", intent: "개입" }],
    }),
    retry: plan.finishPlan({ openings: [{ at: "10:30", jobId: "sample" }] }),
  }));
  const app = await startApp(t, { llm });

  const planRequests = llm.requestsOf("plan");
  assert.equal(planRequests.length, 2);
  assert.match(String(planRequests[1]!.messages.at(-1)!.content), /job_id/);
  assert.equal(app.row("SELECT job_id FROM reservations WHERE kind = 'open'").job_id, "sample");
});

test("open_reserve·open_update는 방침을 달고 바꾸고 떼며, 없는 방침은 있는 방침 목록과 함께 거부한다", async (t) => {
  const results: ToolResult[] = [];
  const llm = new ScriptedLlm().onTurn(async (turn) => {
    const first = await turn.reserveOpening({ at: "11:00", intent: "첫째", jobId: "sample" });
    const second = await turn.reserveOpening({ at: "12:00", intent: "둘째" });
    results.push(
      await turn.use("open_reserve", { at: turn.time("13:00"), intent: "셋째", job_id: "ghost" }),
    );
    results.push(await turn.use("open_update", { reservation_id: second, job_id: "ghost" }));
    await turn.use("open_update", { reservation_id: second, job_id: "sample" });
    await turn.use("open_update", { reservation_id: first, job_id: null });
    return turn.end("11시, 12시에 본다");
  });
  const app = await startApp(t, { llm });
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });

  assert.deepEqual(results, [
    { ok: false, reason: "방침 ghost가 없다. 있는 방침: sample" },
    { ok: false, reason: "방침 ghost가 없다. 있는 방침: sample" },
  ]);
  assert.deepEqual(
    app.rows("SELECT intent, job_id FROM reservations WHERE kind = 'open' ORDER BY at"),
    [
      { intent: "첫째", job_id: null },
      { intent: "둘째", job_id: "sample" },
    ],
  );
});

test("개시 예약 줄에 방침이 붙는다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) =>
      plan.finishPlan({
        openings: [{ at: "10:30", intent: "문제 가져오게 하기", jobId: "sample" }],
      }),
    )
    .onTurn((turn) => turn.end("응"));
  const app = await startApp(t, { llm });
  await app.user("뭐 해?");
  await app.advance({ seconds: 20 });

  assert.deepEqual(inputSection(llm.lastInput("turn"), "지금 개시 예약"), [
    "- #1 2026-10-30 10:30 문제 가져오게 하기 [방침 sample] (plan)",
  ]);
});
