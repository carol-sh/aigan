import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "../../src/ports.ts";
import { Gate } from "../fakes/gate.ts";
import {
  type CompactScript,
  ScriptedLlm,
  type TurnScript,
  inputSection,
} from "../fakes/scripted-llm.ts";
import { type StartOptions, type TestApp, startApp } from "../rig.ts";

const TWENTY = (char: string) => char.repeat(20);

interface LongFlowOptions extends StartOptions {
  compacts?: CompactScript[];
  laterTurns?: TurnScript[];
}

/**
 * 사용자 20자(#1) → 나 20자(#2) → 사용자 20자(#3) → 나 20자(#4). 합 80자가 임계 60을 넘어,
 * 남은 구간이 30자 이하가 되는 #3까지 압축한다(#3은 answered_upto_id 이하).
 */
async function startWithLongFlow(t: Parameters<typeof startApp>[0], options: LongFlowOptions = {}) {
  const { compacts = [], laterTurns = [], config, ...startOptions } = options;
  const llm = new ScriptedLlm()
    .onTurn(
      (turn) => turn.say(TWENTY("나"), { continueAfter: { hours: 1 } }),
      (turn) => turn.say(TWENTY("라"), { continueAfter: { hours: 1 } }),
      ...laterTurns,
    )
    .onCompact(...compacts);
  const app = await startApp(t, {
    compactRules: true,
    ...startOptions,
    llm,
    config: { flow_compact_chars: "60", ...config },
  });
  await app.user(TWENTY("가"));
  await app.advance({ seconds: 20 });
  await app.advanceTo("10:01");
  await app.user(TWENTY("다"));
  await app.advance({ seconds: 20 });
  return app;
}

function compaction(app: TestApp) {
  return app.row("SELECT summary, compacted_until_id, answered_upto_id FROM flows");
}

function compactTasks(app: TestApp): string[] {
  return app.llmTasks.filter((task) => task.endsWith("compact"));
}

test("88: 비압축 구간이 임계를 넘으면 오래된 것부터 남은 구간이 절반 이하가 될 때까지 기존 요약과 합쳐 줄이고, 다음 턴은 요약과 나머지 원문을 본다", async (t) => {
  const app = await startWithLongFlow(t, {
    compacts: [
      (compact) => compact.summarize("첫 요약"),
      (compact) => compact.summarize("둘째 요약"),
    ],
    laterTurns: [(turn) => turn.say("바".repeat(30), { continueAfter: { hours: 1 } })],
  });
  assert.deepEqual(compaction(app), {
    summary: "첫 요약",
    compacted_until_id: 3,
    answered_upto_id: 3,
  });
  const firstInput = app.llm.inputs("compact")[0]!;
  assert.deepEqual(inputSection(firstInput, "기존 요약"), ["(없음)"]);
  assert.deepEqual(inputSection(firstInput, "줄일 대화"), [
    `[10:00] 사용자: ${TWENTY("가")}`,
    `[10:00] 나: ${TWENTY("나")}`,
    `[10:01] 사용자: ${TWENTY("다")}`,
  ]);

  await app.user(TWENTY("마"));
  await app.advance({ seconds: 20 });

  assert.deepEqual(inputSection(app.llm.lastInput("turn"), "흐름 대화"), [
    "[요약] 첫 요약",
    `[10:01] 나: ${TWENTY("라")}`,
    `[10:01] 사용자: ${TWENTY("마")}`,
  ]);
  const secondInput = app.llm.lastInput("compact");
  assert.deepEqual(inputSection(secondInput, "기존 요약"), ["첫 요약"]);
  assert.deepEqual(inputSection(secondInput, "줄일 대화"), [
    `[10:01] 나: ${TWENTY("라")}`,
    `[10:01] 사용자: ${TWENTY("마")}`,
  ]);
  assert.deepEqual(compaction(app), {
    summary: "둘째 요약",
    compacted_until_id: 5,
    answered_upto_id: 5,
  });
});

test("90: 압축 요청은 compact-rules만 system에 두고 도구도 tool_choice도 없으며, llm_calls에 흐름과 함께 남는다", async (t) => {
  const app = await startWithLongFlow(t);

  const [request] = app.llm.requestsOf("compact");
  assert.equal(request?.messages[0]?.content, "긴 대화를 요약한다.");
  assert.equal(request?.tools, undefined);
  assert.equal(request?.tool_choice, undefined);
  assert.deepEqual(app.rows("SELECT flow_id, success FROM llm_calls WHERE kind = 'compact'"), [
    { flow_id: 1, success: 1 },
  ]);
});

test("89: 압축이 실패하면 경고만 남기고 그 턴은 그대로 보내며, 다음 턴 뒤 다시 압축한다", async (t) => {
  const app = await startWithLongFlow(t, {
    compacts: [(compact) => compact.fail(), (compact) => compact.summarize("다시 한 요약")],
    laterTurns: [(turn) => turn.say("응", { continueAfter: { hours: 1 } })],
  });
  assert.deepEqual(compaction(app), {
    summary: null,
    compacted_until_id: null,
    answered_upto_id: 3,
  });
  assert.deepEqual(app.telegram.sent, [TWENTY("나"), TWENTY("라")]);
  assert.ok(app.logger.lines.some((line) => line.startsWith("warn 흐름 1의 압축이 실패했다")));

  await app.user("그리고");
  await app.advance({ seconds: 20 });

  assert.deepEqual(compactTasks(app), ["10-30 10:01 compact", "10-30 10:01 compact"]);
  assert.equal(compaction(app).summary, "다시 한 요약");
});

test("89a: 턴 io 중에 와서 지우지 못한 미응답 앞에서 압축이 멈추고, 다음 답장 턴은 그 메시지를 원문으로 본다", async (t) => {
  const gate = new Gate();
  const llm = new ScriptedLlm()
    .onTurn(
      (turn) => turn.say(TWENTY("나"), { continueAfter: { hours: 1 } }),
      async (turn) => {
        await gate.wait();
        return turn.say(TWENTY("라"), { continueAfter: { hours: 1 } });
      },
      (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
    )
    .onCompact((compact) => compact.summarize("요약"));
  const app = await startApp(t, { llm, compactRules: true, config: { flow_compact_chars: "60" } });
  await app.user(TWENTY("가"));
  await app.advance({ seconds: 20 });
  await app.advanceTo("10:01");
  await app.user(TWENTY("다"));
  await app.advance({ seconds: 20 });
  app.telegram.failNextDeletes(new TelegramError(400, "message can't be deleted"));
  await app.user(TWENTY("사"));

  gate.open();
  await app.advance({ seconds: 1 });
  assert.deepEqual(compaction(app), {
    summary: "요약",
    compacted_until_id: 3,
    answered_upto_id: 3,
  });

  await app.advance({ seconds: 20 });
  assert.deepEqual(inputSection(app.llm.lastInput("turn"), "흐름 대화"), [
    "[요약] 요약",
    `[10:01] 사용자: ${TWENTY("사")}`,
    `[10:01] 나: ${TWENTY("라")}`,
  ]);
  assert.equal(compaction(app).answered_upto_id, 4);
});

test("89b: 압축이 흐름의 user 메시지를 모두 덮은 뒤의 이어가기 턴은 원문에 user 줄이 없고, answered_upto_id가 그대로라 답장 턴이 골라지지 않는다", async (t) => {
  const llm = new ScriptedLlm()
    .onTurn(
      (turn) => turn.say(TWENTY("나"), { continueAfter: { hours: 1 } }),
      (turn) => turn.say("라".repeat(50), { continueAfter: { minutes: 10 } }),
      (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
    )
    .onCompact((compact) => compact.summarize("요약"));
  const app = await startApp(t, { llm, compactRules: true, config: { flow_compact_chars: "60" } });
  await app.user(TWENTY("가"));
  await app.advance({ seconds: 20 });
  await app.advanceTo("10:01");
  await app.user(TWENTY("다"));
  await app.advance({ seconds: 20 });
  assert.equal(compaction(app).compacted_until_id, 3);

  await app.advanceTo("10:20");

  assert.deepEqual(inputSection(app.llm.lastInput("turn"), "흐름 대화"), [
    "[요약] 요약",
    `[10:01] 나: ${"라".repeat(50)}`,
  ]);
  assert.equal(compaction(app).answered_upto_id, 3);
  assert.deepEqual(app.llmTasks.slice(-2), ["10-30 10:01 compact", "10-30 10:11 turn:continue"]);
});

test("89c: 임계를 넘어도 answered_upto_id 이하에 덮을 메시지가 없으면 압축을 부르지 않는다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn((turn) => turn.say("가".repeat(70), { continueAfter: { hours: 1 } }));
  const app = await startApp(t, { llm, compactRules: true, config: { flow_compact_chars: "60" } });

  await app.advanceTo("10:31");

  assert.deepEqual(app.llmTasks, ["10-30 10:00 plan", "10-30 10:30 turn:open#1"]);
  assert.deepEqual(app.rows("SELECT id FROM llm_calls WHERE kind = 'compact'"), []);
});

test("90b: 정리는 원문이 cleanup_raw_max_chars 이하면 압축된 구간까지 원문으로, 넘으면 요약과 나머지 원문으로 본다", async (t) => {
  const endFlow: TurnScript = (turn) => turn.end("끝");
  const raw = await startWithLongFlow(t, { laterTurns: [endFlow] });
  await raw.user("그만");
  await raw.advance({ seconds: 20 });
  assert.deepEqual(inputSection(raw.llm.lastInput("cleanup"), "대화"), [
    `[10:00] 사용자: ${TWENTY("가")}`,
    `[10:00] 나: ${TWENTY("나")}`,
    `[10:01] 사용자: ${TWENTY("다")}`,
    `[10:01] 나: ${TWENTY("라")}`,
    "[10:01] 사용자: 그만",
    "[10:01] 나: 끝",
  ]);

  const compacted = await startWithLongFlow(t, {
    laterTurns: [endFlow],
    config: { cleanup_raw_max_chars: "50" },
  });
  await compacted.user("그만");
  await compacted.advance({ seconds: 20 });
  assert.deepEqual(inputSection(compacted.llm.lastInput("cleanup"), "대화"), [
    "[요약] 요약",
    `[10:01] 나: ${TWENTY("라")}`,
    "[10:01] 사용자: 그만",
    "[10:01] 나: 끝",
  ]);
});

test("12c: 압축 io 중에 온 메시지는 지우지 않고 흐름의 미응답으로 들어가 디바운스 뒤 답장 턴이 받는다", async (t) => {
  const gate = new Gate();
  const app = await startWithLongFlow(t, {
    compacts: [
      async (compact) => {
        await gate.wait();
        return compact.summarize("요약");
      },
    ],
    laterTurns: [(turn) => turn.say("응", { continueAfter: { hours: 1 } })],
  });
  await app.user("압축 중에 한 말");

  gate.open();
  await app.advance({ seconds: 20 });

  assert.deepEqual(app.telegram.deleted, []);
  assert.deepEqual(app.row("SELECT flow_id, void_reason FROM messages WHERE id = 5"), {
    flow_id: 1,
    void_reason: null,
  });
  assert.equal(app.llmTasks.at(-1), "10-30 10:01 turn:reply");
  assert.ok(app.llm.lastInput("turn").includes("[10:01] 사용자: 압축 중에 한 말"));
});

test("압축도 게이트를 거쳐, 턴이 일일 상한을 다 쓴 뒤라면 보류에 들어가고 압축은 부르지 않는다", async (t) => {
  // 계획·판정 턴·답장 턴이 한 건씩 써 3건이 된다.
  const app = await startWithLongFlow(t, { config: { daily_call_limit: "3" } });

  assert.deepEqual(compactTasks(app), []);
  assert.equal(app.row("SELECT hold_reason FROM harness_state").hold_reason, "daily_limit");
  assert.equal(app.telegram.alerts.length, 1);
  assert.deepEqual(app.telegram.sent.slice(0, 2), [TWENTY("나"), TWENTY("라")]);
});

test("compact-rules.md가 없으면 임계를 넘어도 압축하지 않는다", async (t) => {
  const app = await startWithLongFlow(t, { compactRules: false });

  assert.deepEqual(compactTasks(app), []);
  assert.equal(compaction(app).summary, null);
});
