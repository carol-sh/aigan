import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolResult } from "../../src/worker/tools/tool-box.ts";
import { type CleanupScript, ScriptedLlm, inputSection } from "../fakes/scripted-llm.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type StartOptions, type TestApp, startApp } from "../rig.ts";

const neverFinishes = () => new Promise<never>(() => {});

/** 판정 턴이 한 줄 말하고 바로 끝내서, 닫힌 흐름의 정리가 각본대로 돈다. */
async function startWithClosedFlow(
  t: Parameters<typeof startApp>[0],
  cleanups: CleanupScript[],
  options: StartOptions = {},
): Promise<TestApp> {
  const llm = (options.llm ?? new ScriptedLlm())
    .onTurn(async (turn) => turn.end("그래"))
    .onCleanup(...cleanups);
  const app = await startApp(t, { ...options, llm });
  await app.user("오늘 끝");
  await app.advance({ seconds: 20 });
  return app;
}

function memory(app: TestApp) {
  return {
    state: app.row<{ content: string }>("SELECT content FROM memory_state").content,
    sections: app.rows("SELECT title, content FROM memory_sections ORDER BY created_at, title"),
  };
}

function cleanupStartedSeconds(app: TestApp): number[] {
  const cleanups = app.llm.log.filter(({ task }) => task.kind === "cleanup");
  const first = cleanups[0]?.startedAt;
  return cleanups.map(({ startedAt }) => startedAt.diff(first!).as("seconds"));
}

function assertRejected(result: ToolResult | undefined, reason: RegExp): void {
  assert.equal(result?.ok, false, `거부돼야 한다: ${JSON.stringify(result)}`);
  if (result && !result.ok) assert.match(result.reason, reason);
}

test("83, 90d: 정리가 성공하면 기억 쓰기와 done이 함께 커밋된다", async (t) => {
  const app = await startWithClosedFlow(t, [
    async (cleanup) => {
      await cleanup.use("state_write", { content: "오늘 일찍 마무리함" });
      await cleanup.use("memory_write", { title: "  습관  ", content: "저녁에 대화를 끝낸다" });
    },
  ]);

  assert.equal(app.row("SELECT cleanup_status FROM flows").cleanup_status, "done");
  assert.deepEqual(memory(app), {
    state: "오늘 일찍 마무리함",
    sections: [{ title: "습관", content: "저녁에 대화를 끝낸다" }],
  });
  assert.deepEqual(app.row("SELECT updated_by_flow_id FROM memory_state"), {
    updated_by_flow_id: 1,
  });
});

test("84, 85: 정리 실패는 30초부터 두 배씩 300초까지 미루고, cleanup_max_attempts에 닿으면 failed로 두고 알린 뒤 다음 작업으로 간다", async (t) => {
  const fail: CleanupScript = async (cleanup) => cleanup.fail();
  const app = await startWithClosedFlow(t, Array(6).fill(fail), {
    config: { cleanup_max_attempts: "6" },
  });
  await app.user("정리 기다리는 동안 한 말");

  await app.advance({ minutes: 13 });

  assert.deepEqual(cleanupStartedSeconds(app), [0, 30, 90, 210, 450, 750]);
  assert.equal(app.row("SELECT cleanup_status FROM flows").cleanup_status, "failed");
  assert.deepEqual(app.telegram.alerts, [
    "흐름 1의 정리를 포기했다(6번 실패). 이 흐름의 기억 정리는 빠진다.",
  ]);
  assert.equal(app.llmTasks.at(-1), "10-30 10:12 turn:user");
});

test("85a: 마지막 정리 시도의 io 중에 죽으면 재시작 뒤 호출 없이 failed로 두고 알린다", async (t) => {
  const app = await startWithClosedFlow(t, [neverFinishes], {
    config: { cleanup_max_attempts: "1" },
  });

  await app.restart({ downFor: { minutes: 1 } });

  assert.equal(cleanupStartedSeconds(app).length, 1);
  assert.equal(app.row("SELECT cleanup_status FROM flows").cleanup_status, "failed");
  assert.equal(app.telegram.alerts.length, 1);
});

test("90: 정리에는 턴 도구를 주지 않는다", async (t) => {
  const results: ToolResult[] = [];
  await startWithClosedFlow(t, [
    async (cleanup) => {
      results.push(
        await cleanup.use("goal_create", { job_id: "sample", title: "x", done_criteria: "" }),
      );
      results.push(await cleanup.use("open_reserve", { at: "2026-10-30 15:00", intent: "x" }));
    },
  ]);

  for (const result of results) assertRejected(result, /쓸 수 없는 도구/);
});

test("90e: 정리 응답 뒤 커밋 전에 죽으면 기억은 그대로고, 재시작 뒤 cleanup_next_at에 다시 돌아 한 번만 반영한다", async (t) => {
  const app = await startWithClosedFlow(t, [
    async (cleanup) => {
      await cleanup.use("memory_write", { title: "습관", content: "첫 시도" });
      await neverFinishes();
    },
    async (cleanup) => {
      await cleanup.use("memory_write", { title: "습관", content: "두 번째 시도" });
    },
  ]);

  await app.restart({ downFor: { seconds: 10 } });
  assert.deepEqual(memory(app), { state: "", sections: [] });
  assert.equal(app.row("SELECT cleanup_status FROM flows").cleanup_status, "pending");
  await app.advance({ seconds: 30 });

  assert.deepEqual(cleanupStartedSeconds(app), [0, 30]);
  assert.deepEqual(memory(app).sections, [{ title: "습관", content: "두 번째 시도" }]);
});

test("90f: 정리가 실패하면 그 시도의 기억 쓰기를 버린다", async (t) => {
  const app = await startWithClosedFlow(t, [
    async (cleanup) => {
      await cleanup.use("state_write", { content: "반영되면 안 됨" });
      cleanup.fail();
    },
  ]);

  assert.deepEqual(memory(app), { state: "", sections: [] });
  assert.equal(app.row("SELECT cleanup_attempts FROM flows").cleanup_attempts, 1);
});

test("90g: 상한을 넘거나 비었거나 제목이 잘못된 기억 쓰기는 이유를 담아 거부하고 정리는 계속된다", async (t) => {
  const results: ToolResult[] = [];
  const app = await startWithClosedFlow(
    t,
    [
      async (cleanup) => {
        results.push(await cleanup.use("state_write", { content: "가".repeat(11) }));
        results.push(
          await cleanup.use("memory_write", { title: "약점", content: "나".repeat(21) }),
        );
        results.push(await cleanup.use("memory_write", { title: "약점", content: "  " }));
        results.push(await cleanup.use("memory_write", { title: "   ", content: "본문" }));
        results.push(
          await cleanup.use("memory_write", { title: "x".repeat(101), content: "본문" }),
        );
      },
    ],
    { config: { state_max_chars: "10", memory_section_max_chars: "20" } },
  );

  assertRejected(results[0], /10자까지다. 지금 11자/);
  assertRejected(results[1], /20자까지다. 지금 21자/);
  assertRejected(results[2], /비었다/);
  assertRejected(results[3], /1–100자/);
  assertRejected(results[4], /1–100자/);
  assert.equal(app.row("SELECT cleanup_status FROM flows").cleanup_status, "done");
});

test("90h: 칸이 memory_max_sections개면 새 칸은 거부하고, 기존 칸 쓰기와 지운 뒤 새 칸은 허용한다", async (t) => {
  const results: ToolResult[] = [];
  const app = await startWithClosedFlow(
    t,
    [
      async (cleanup) => {
        await cleanup.use("memory_write", { title: "약점", content: "1" });
        await cleanup.use("memory_write", { title: "습관", content: "2" });
        results.push(await cleanup.use("memory_write", { title: "성향", content: "3" }));
        results.push(await cleanup.use("memory_write", { title: "약점", content: "1 고침" }));
        results.push(await cleanup.use("memory_delete", { title: "습관" }));
        results.push(await cleanup.use("memory_write", { title: "성향", content: "3" }));
      },
    ],
    { config: { memory_max_sections: "2" } },
  );

  assertRejected(results[0], /2개까지다/);
  assert.deepEqual(results.slice(1), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(memory(app).sections, [
    { title: "성향", content: "3" },
    { title: "약점", content: "1 고침" },
  ]);
});

test("90i: 같은 정리 안에서 쓴 칸은 memory_read로 바로 읽힌다", async (t) => {
  const results: ToolResult[] = [];
  await startWithClosedFlow(t, [
    async (cleanup) => {
      await cleanup.use("memory_write", { title: "습관", content: "아침형" });
      results.push(await cleanup.use("memory_read", { title: "습관" }));
      await cleanup.use("memory_delete", { title: "습관" });
      results.push(await cleanup.use("memory_read", { title: "습관" }));
    },
  ]);

  assert.deepEqual(results[0], { ok: true, content: "아침형" });
  assertRejected(results[1], /습관/);
});

test("90a, 90c, 90k: 정리 입력은 규칙만 system에 두고, 흐름 정보·목표·대화 원문을 보여 준다", async (t) => {
  const llm = new ScriptedLlm()
    .onTurn(
      (turn) => turn.silent(),
      async (turn) => {
        const water = await turn.createGoal({ title: "물" });
        await turn.createGoal({ title: "책" });
        await turn.use("goal_close", { goal_id: 2, result: "done", reason: "다 읽음" });
        await turn.reserveOpening({ at: "13:00", intent: "중간 확인", goalIds: [water] });
        return turn.end("13시에 볼게");
      },
      (turn) => turn.say("물 얼마나 마셨어?", { continueAfter: { minutes: 30 } }),
      (turn) => turn.end(["반이면 됐다", "저녁까지 다 마셔"]),
    )
    .onReconsider(async (turn) => {
      await turn.reserveOpening({ at: "18:00", intent: "최종 확인", goalIds: [1] });
      return turn.end(["반이면 됐다", "6시에 다시 볼게"]);
    });
  const app = await startApp(t, {
    llm,
    preparePrompts: (dir) => writeFileSync(join(dir, "persona.md"), "까칠한 코치"),
  });
  await app.user("심심해");
  await app.advance({ seconds: 20 });
  await app.advanceTo("10:05");
  await app.user("할 일 줘");
  await app.advance({ seconds: 20 });
  await app.advanceTo("13:01");
  await app.user("반 마심");
  await app.advance({ seconds: 21 });

  const [userFlowCleanup, aiFlowCleanup] = app.llm.inputs("cleanup");
  assert.deepEqual(inputSection(userFlowCleanup!, "대화"), [
    "[10:00] 사용자: 심심해 (무시됨)",
    "[10:05] 사용자: 할 일 줘",
    "[10:05] 나: 13시에 볼게",
  ]);
  assert.deepEqual(inputSection(aiFlowCleanup!, "흐름"), [
    "개시: AI(개시 의도: 중간 확인)",
    "시작: 2026-10-30 13:00 / 종료: 2026-10-30 13:01 (agent)",
  ]);
  assert.deepEqual(inputSection(aiFlowCleanup!, "목표 (계획일 2026-10-30)"), [
    "- #1 물 (sample) [active] — 이 흐름에서 다룸",
    "  완료 조건: 물 끝",
    "  진행 메모: (없음)",
    "- #2 책 (sample) [done] 다 읽음",
    "  완료 조건: 책 끝",
    "  진행 메모: (없음)",
  ]);
  assert.deepEqual(inputSection(aiFlowCleanup!, "대화"), [
    "[13:00] 나: 물 얼마나 마셨어?",
    "[13:01] 사용자: 반 마심",
    "[13:01] 나: 반이면 됐다",
    "[13:01] 나: 6시에 다시 볼게",
  ]);
  assert.deepEqual(inputSection(aiFlowCleanup!, "지금"), ["2026-10-30 13:01"]);
  for (const request of app.llm.requestsOf("cleanup")) {
    assert.equal(request.messages[0]?.content, "기억에 남길 것을 정리한다.");
  }
  assert.ok(String(app.llm.requestsOf("turn")[0]?.messages[0]?.content).startsWith("까칠한 코치"));
});

test("정리 입력의 기억은 칸 본문까지 들여써서 모두 보여 준다. 쓰기가 통째 교체라 읽지 않고 쓰면 기록이 사라져서다", async (t) => {
  const llm = new ScriptedLlm()
    .onTurn(
      (turn) => turn.end("그래"),
      (turn) => turn.end("또 왔네"),
    )
    .onCleanup(
      async (cleanup) => {
        await cleanup.use("memory_write", {
          title: "전략",
          content: "## 장부\n- 10-30 | 핑계 | 반려",
        });
        await cleanup.use("memory_write", { title: "관계", content: "register: elevated" });
      },
      async () => {},
    );
  const app = await startApp(t, { llm });
  await app.user("오늘 끝");
  await app.advance({ seconds: 20 });
  await app.user("다시 왔어");
  await app.advance({ seconds: 20 });

  assert.deepEqual(inputSection(app.llm.inputs("cleanup")[1]!, "기억"), [
    "state: (비어 있음)",
    "칸: 관계, 전략",
    "[칸 관계]",
    "  register: elevated",
    "[칸 전략]",
    "  ## 장부",
    "  - 10-30 | 핑계 | 반려",
  ]);
});
