import assert from "node:assert/strict";
import { test } from "node:test";
import { Gate } from "../fakes/gate.ts";
import { ScriptedLlm } from "../fakes/scripted-llm.ts";
import { startApp } from "../rig.ts";

test("33: 말한 판정 턴은 사용자가 연 흐름을 만들고 흐름 밖 메시지를 모두 옮긴다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.silent(),
    (turn) => turn.say("응 말해", { continueAfter: { hours: 1 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("심심하다");
  await app.advance({ seconds: 20 });
  await app.advanceTo("10:05");
  await app.user("할 일 좀 줘");

  await app.advance({ seconds: 20 });

  assert.deepEqual(app.row("SELECT opener, plan_date FROM flows"), {
    opener: "user",
    plan_date: "2026-10-30",
  });
  assert.deepEqual(app.rows("SELECT content, flow_id, triage FROM messages WHERE role = 'user'"), [
    { content: "심심하다", flow_id: 1, triage: "ignored" },
    { content: "할 일 좀 줘", flow_id: 1, triage: "accepted" },
  ]);
});

test("34, 37: 말 없는 판정 턴은 이어가든 끝내든 본 메시지만 무시하고, 도구 효과를 버리고, 실패 상태를 지운다", async (t) => {
  for (const silentOutput of ["silent", "silentEnd"] as const) {
    await t.test(silentOutput, async (t) => {
      const gate = new Gate();
      const llm = new ScriptedLlm().onTurn(async (turn) => {
        await turn.createGoal({ title: "산책" });
        await gate.wait();
        return turn[silentOutput]();
      });
      const app = await startApp(t, { llm });
      app.plant("UPDATE harness_state SET failure_count = 2, output_fail_count = 1");
      await app.user("음");
      await app.advance({ seconds: 20 });
      await app.user("턴 도중에 온 말");

      gate.open();
      await app.advance({ seconds: 1 });

      assert.deepEqual(app.rows("SELECT content, triage FROM messages WHERE role = 'user'"), [
        { content: "음", triage: "ignored" },
        { content: "턴 도중에 온 말", triage: "pending" },
      ]);
      assert.deepEqual(app.rows("SELECT id FROM flows"), []);
      assert.deepEqual(app.rows("SELECT id FROM goals"), []);
      assert.deepEqual(app.row("SELECT failure_count, output_fail_count FROM harness_state"), {
        failure_count: 0,
        output_fail_count: 0,
      });
    });
  }
});

test("36: 무시한 메시지는 뒤이은 AI 개시 흐름에 ignored 그대로 들어간다", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "10:30" }] }))
    .onTurn(
      (turn) => turn.silent(),
      (turn) => turn.say("산책 가자", { continueAfter: { hours: 1 } }),
    );
  const app = await startApp(t, { llm });
  await app.user("ㅎㅇ");
  await app.advance({ seconds: 20 });

  await app.advanceTo("10:31");

  assert.deepEqual(app.rows("SELECT flow_id, triage FROM messages WHERE role = 'user'"), [
    { flow_id: 1, triage: "ignored" },
  ]);
});

test("39: 한 줄 말하고 끝내는 판정 턴은 흐름을 열고 바로 닫아 정리한다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) => turn.end("지금은 아니야"));
  const app = await startApp(t, { llm });
  await app.user("놀자");

  await app.advance({ seconds: 21 });

  assert.deepEqual(app.row("SELECT opener, end_reason, cleanup_status FROM flows"), {
    opener: "user",
    end_reason: "agent",
    cleanup_status: "done",
  });
  assert.deepEqual(app.llmTasks, [
    "10-30 10:00 plan",
    "10-30 10:00 turn:user",
    "10-30 10:00 cleanup",
  ]);
  assert.deepEqual(app.telegram.sent, ["지금은 아니야"]);
});

test("흐름을 열 때 흐름 밖 메시지가 outside_messages_max개를 넘으면 오래된 것은 trimmed로 옮긴다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) => turn.say("응", { continueAfter: { hours: 1 } }));
  const app = await startApp(t, { llm, config: { outside_messages_max: "2" } });
  await app.user("하나");
  await app.user("둘");
  await app.user("셋");

  await app.advance({ seconds: 20 });

  assert.deepEqual(
    app.rows("SELECT content, flow_id, void_reason FROM messages WHERE role = 'user'"),
    [
      { content: "하나", flow_id: 1, void_reason: "trimmed" },
      { content: "둘", flow_id: 1, void_reason: null },
      { content: "셋", flow_id: 1, void_reason: null },
    ],
  );
});
