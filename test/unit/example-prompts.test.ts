import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../../src/config.ts";
import {
  parseCleanupOutput,
  parseCompactOutput,
  planOutputParser,
  turnOutputParser,
} from "../../src/llm/outputs.ts";
import { loadPrompts } from "../../src/prompts.ts";
import type { HarnessContext } from "../../src/worker/context.ts";
import { createCleanupTools } from "../../src/worker/tools/cleanup-tools.ts";
import type { MemoryChanges } from "../../src/worker/tools/memory-changes.ts";
import { createPlanTools } from "../../src/worker/tools/plan-tools.ts";
import { type TurnToolScope, createTurnTools } from "../../src/worker/tools/turn-tools.ts";
import { ScriptedLlm, inputSection } from "../fakes/scripted-llm.ts";
import { startApp } from "../rig.ts";

const EXAMPLE_PROMPTS_DIR = "examples/prompts";
const TIMEZONE = "Asia/Seoul";

// 이름만 읽으므로 도구가 실제로 쓰는 의존은 비워 둔다.
const turnToolNames = createTurnTools({} as TurnToolScope).names;
const planToolNames = createPlanTools({} as HarnessContext).names;
const cleanupToolNames = createCleanupTools({} as Config, {} as MemoryChanges).names;

function readExample(fileName: string): string {
  return readFileSync(join(EXAMPLE_PROMPTS_DIR, fileName), "utf8");
}

function jsonExamples(text: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
}

function assertMentionsAll(text: string, words: string[]): void {
  const missing = words.filter((word) => !text.includes(word));
  assert.deepEqual(missing, [], `빠진 것: ${missing.join(", ")}`);
}

/** 예시가 쓰는 시각은 모델이 그대로 따라 쓰므로 도구·출력이 받는 형식이어야 한다. */
function assertLocalTimesWellFormed(example: string): void {
  for (const [time] of example.matchAll(/\d{4}-\d{2}-\d{2}[^"]*/g)) {
    assert.match(time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  }
}

test("예시 프롬프트 세트는 그대로 로드되고 선택 파일까지 모두 있다", () => {
  const prompts = loadPrompts(EXAMPLE_PROMPTS_DIR);

  assert.ok(prompts.persona);
  assert.ok(prompts.cleanupRules);
  assert.ok(prompts.compactRules);
  assert.deepEqual(
    prompts.jobPolicies.map((job) => job.id),
    ["algorithm-notes"],
  );
  assert.match(prompts.jobPolicies[0]!.description, /평일 저녁/);
});

test("턴 규칙은 턴 도구 전부와 출력 필드, 계기 네 가지, 되묻기 문구를 말한다", () => {
  assertMentionsAll(readExample("turn-rules.md"), [
    ...turnToolNames,
    "messages",
    "next",
    "continue_at",
    '"continue"',
    '"end"',
    "YYYY-MM-DD HH:mm",
    "계기: AI 개시",
    "계기: 사용자 메시지(흐름 없음)",
    "계기: 사용자 답장",
    "계기: 이어가기",
    "다음 확인이 없다",
  ]);
});

test("계획·정리·압축 규칙은 각자의 도구와 출력 필드를 말한다", () => {
  assertMentionsAll(readExample("plan-rules.md"), [
    ...planToolNames,
    "body",
    "openings",
    "at",
    "intent",
    "goal_ids",
    "YYYY-MM-DD HH:mm",
  ]);
  assertMentionsAll(readExample("cleanup-rules.md"), cleanupToolNames);
  assertMentionsAll(readExample("compact-rules.md"), ["summary"]);
});

test("규칙 파일의 출력 예시는 실제 출력 파서를 통과한다", () => {
  const cases = [
    { file: "turn-rules.md", parse: turnOutputParser("reply", TIMEZONE) },
    { file: "plan-rules.md", parse: planOutputParser(TIMEZONE) },
    { file: "cleanup-rules.md", parse: parseCleanupOutput },
    { file: "compact-rules.md", parse: parseCompactOutput },
  ];
  for (const { file, parse } of cases) {
    const examples = jsonExamples(readExample(file));
    assert.ok(examples.length > 0, `${file}에 출력 예시가 없다`);
    for (const example of examples) {
      const parsed = parse(example);
      assert.ok(
        parsed.ok,
        `${file}의 예시가 파서를 통과하지 못한다: ${!parsed.ok && parsed.error}`,
      );
      assertLocalTimesWellFormed(example);
    }
  }
});

test("예시 세트로 부팅하면 계획·턴·정리 요청의 system이 그 파일들이고 방침 목록에 예시 방침이 나온다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) =>
      plan.finishPlan({ openings: [{ at: "10:30", intent: "알고리즘 노트: 문제 가져오게 하기" }] }),
    )
    .onTurn(async (turn) => {
      await turn.use("job_read", { job_id: "algorithm-notes" });
      return turn.end("노트북 켜. 9시에 문제 하나.");
    })
    .onCleanup(async (cleanup) => {
      await cleanup.use("state_write", { content: "알고리즘 노트 0문제" });
    });
  const app = await startApp(t, { llm, promptsDir: EXAMPLE_PROMPTS_DIR });
  await app.advanceTo("10:31");

  const prompts = loadPrompts(EXAMPLE_PROMPTS_DIR);
  const systemOf = (kind: "plan" | "turn" | "cleanup") =>
    llm.requestsOf(kind)[0]?.messages[0]?.content;
  assert.equal(systemOf("plan"), prompts.planRules);
  assert.equal(systemOf("turn"), `${prompts.persona}\n\n${prompts.turnRules}`);
  assert.equal(systemOf("cleanup"), prompts.cleanupRules);
  assert.deepEqual(inputSection(llm.lastInput("turn"), "방침"), [
    `- algorithm-notes: ${prompts.jobPolicies[0]!.description}`,
  ]);
  assert.equal(app.row("SELECT content FROM memory_state")?.content, "알고리즘 노트 0문제");
});
