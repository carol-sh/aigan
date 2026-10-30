import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError } from "../../src/config.ts";
import { InstanceLockedError } from "../../src/db/lock.ts";
import { PromptsError } from "../../src/prompts.ts";
import { startApp } from "../rig.ts";

describe("3: 시작 실패", () => {
  const cases = [
    {
      name: "turn-rules.md 없음",
      prepare: (dir: string) => rmSync(join(dir, "turn-rules.md")),
      error: PromptsError,
    },
    {
      name: "plan-rules.md 없음",
      prepare: (dir: string) => rmSync(join(dir, "plan-rules.md")),
      error: PromptsError,
    },
    {
      name: "jobs/가 비었음",
      prepare: (dir: string) => rmSync(join(dir, "jobs", "sample.md")),
      error: PromptsError,
    },
    {
      name: "방침 파일에 description 없음",
      prepare: (dir: string) =>
        writeFileSync(join(dir, "jobs", "sample.md"), "---\ntitle: x\n---\n본문"),
      error: PromptsError,
    },
    {
      name: "방침 파일명이 id 형식이 아님",
      prepare: (dir: string) =>
        writeFileSync(join(dir, "jobs", "물 마시기.md"), "---\ndescription: x\n---\n"),
      error: PromptsError,
    },
  ];

  for (const { name, prepare, error } of cases) {
    test(name, async (t) => {
      await assert.rejects(startApp(t, { preparePrompts: prepare }), error);
    });
  }

  test("blackout 설정이 비었음", async (t) => {
    await assert.rejects(startApp(t, { config: { blackout: "" } }), ConfigError);
  });
});

test("3a: 방침 파일을 추가하고 재시작하면 방침 목록에 바로 나온다", async (t) => {
  const app = await startApp(t);
  writeFileSync(
    join(app.dataDir, "prompts", "jobs", "water.md"),
    "---\ndescription: 물 마시기\n---\n하루 2리터",
  );

  await app.restart();

  assert.deepEqual(
    app.harness.ctx.prompts.jobPolicies.map((policy) => [policy.id, policy.description]),
    [
      ["sample", "한 줄 설명. 계획과 턴의 방침 목록에 이 줄이 보인다"],
      ["water", "물 마시기"],
    ],
  );
});

test("4: 두 번째 인스턴스는 잠금에서 거부된다", async (t) => {
  const first = await startApp(t);

  await assert.rejects(first.bootAndStart(), InstanceLockedError);
});

test("첫 실행은 계획 밀림이라 곧바로 계획을 돌린다", async (t) => {
  const app = await startApp(t, { at: "2026-10-30 10:00" });

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan"]);
  assert.equal(
    app.row<{ last_plan_date: string }>("SELECT last_plan_date FROM harness_state").last_plan_date,
    "2026-10-30",
  );
});

test("할 일이 없으면 timer_max_sleep_sec마다 깨어나 고르기만 하고 LLM 작업은 없다", async (t) => {
  const app = await startApp(t);
  const wakeUpsBefore = app.harness.loop.stats.wakeUps;

  await app.advance({ minutes: 10 });

  assert.equal(app.harness.loop.stats.wakeUps - wakeUpsBefore, 10);
  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan"]);
});
