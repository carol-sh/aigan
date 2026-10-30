import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurationLike } from "luxon";
import { Gate } from "../fakes/gate.ts";
import { ScriptedLlm } from "../fakes/llm-tasks.ts";
import { type TestApp, startApp } from "../rig.ts";

function continueReservation(app: TestApp) {
  return app.rows<{ at: string; state: string }>(
    "SELECT at, state FROM reservations WHERE kind = 'continue'",
  );
}

test("43: 말한 턴의 io 중에 이어가기가 발화해도 커밋이 이어가기를 새로 잡는다", async (t) => {
  const gate = new Gate();
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("응", { continueAfter: { minutes: 10 } }),
    async (turn) => {
      await gate.wait();
      return turn.say("그렇구나", { continueAfter: { hours: 1 } });
    },
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advanceTo("10:09");
  await app.user("하나 더");
  await app.advance({ seconds: 20 });
  await app.advanceTo("10:15");

  gate.open();
  await app.advance({ seconds: 1 });

  assert.deepEqual(continueReservation(app), [
    { at: app.at("10:15").plus({ hours: 1 }).toISO(), state: "scheduled" },
  ]);
  assert.ok(!app.llmTasks.some((task) => task.endsWith("turn:continue")));
});

test("45: end를 낸 흐름 안 턴은 흐름을 agent로 닫는다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
    (turn) => turn.end("잘 자"),
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  await app.user("잘게");

  await app.advance({ seconds: 20 });

  assert.equal(app.row("SELECT end_reason FROM flows").end_reason, "agent");
  assert.deepEqual(continueReservation(app), []);
});

test("46: 이어가기 시각이 빠지거나 지났으면 continue_default_sec 뒤로 메우고 로그를 남기고, 너무 가까우면 min_lead로 당긴다", async (t) => {
  const cases: [string, DurationLike | undefined, DurationLike, boolean][] = [
    ["빠짐", undefined, { minutes: 10 }, true],
    ["지남", { minutes: -5 }, { minutes: 10 }, true],
    ["30초 뒤", { seconds: 30 }, { minutes: 1 }, false],
  ];
  for (const [name, continueAfter, expectedDelay, isLogged] of cases) {
    await t.test(name, async (t) => {
      const llm = new ScriptedLlm().onTurn((turn) => turn.say("응", { continueAfter }));
      const app = await startApp(t, { llm });
      await app.user("시작");

      await app.advance({ seconds: 20 });

      const turnAt = app.at("10:00").plus({ seconds: 20 });
      assert.deepEqual(continueReservation(app), [
        { at: turnAt.plus(expectedDelay).toISO(), state: "scheduled" },
      ]);
      assert.equal(
        app.logger.lines.some((line) => line.includes("메웠다")),
        isLogged,
      );
    });
  }
});

test("47, 47a: 그날 끝 이후의 이어가기는 그날 끝으로 당기고, 그 시각에 블랙아웃으로 닫힌다", async (t) => {
  const llm = new ScriptedLlm().onTurn((turn) =>
    turn.say("내일 아침에 보자", { continueAfter: { hours: 9, minutes: 10 } }),
  );
  const app = await startApp(t, { at: "2026-10-30 22:50", llm });
  await app.user("잘게");
  await app.advance({ seconds: 20 });

  assert.deepEqual(continueReservation(app), [
    { at: app.at("2026-10-31 00:00").toISO(), state: "scheduled" },
  ]);
  await app.advanceTo("2026-10-31 00:01");
  assert.equal(app.row("SELECT end_reason FROM flows").end_reason, "blackout");
  assert.ok(!app.llmTasks.some((task) => task.endsWith("turn:continue")));
});

test("47b: 흐름 안 턴의 io가 블랙아웃 시작을 넘기면 커밋하고 보낸 뒤 블랙아웃으로 닫는다", async (t) => {
  const gate = new Gate();
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
    async (turn) => {
      await gate.wait();
      return turn.say("내일 보자", { continueAfter: { hours: 1 } });
    },
  );
  const app = await startApp(t, { at: "2026-10-30 23:30", llm });
  await app.user("시작");
  await app.advanceTo("23:59");
  await app.user("늦었다");
  await app.advance({ seconds: 20 });
  await app.advanceTo("2026-10-31 00:02");

  gate.open();
  await app.advance({ seconds: 1 });

  assert.deepEqual(app.telegram.sent, ["응", "내일 보자"]);
  assert.deepEqual(app.row("SELECT end_reason, ended_at FROM flows"), {
    end_reason: "blackout",
    ended_at: app.at("2026-10-31 00:02").toISO(),
  });
});

test("48: 말 없이 끝내는 흐름 안 턴은 흐름을 닫고 도구 효과를 버리되 본 메시지는 답한 것으로 둔다 (L6)", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
    (turn) => {
      turn.createGoal({ title: "산책" });
      return turn.silentEnd();
    },
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  await app.user("ㅇㅋ");

  await app.advance({ seconds: 20 });

  assert.deepEqual(app.row("SELECT end_reason, answered_upto_id FROM flows"), {
    end_reason: "agent",
    answered_upto_id: app.row<{ id: number }>(
      "SELECT MAX(id) AS id FROM messages WHERE role = 'user'",
    ).id,
  });
  assert.deepEqual(app.rows("SELECT id FROM goals"), []);
  assert.deepEqual(app.telegram.sent, ["응"]);
});

test("48i: 말 없이 이어가는 답장 턴은 이어가기를 그대로 두고, 도구 효과를 버리고, 본 메시지는 답한 것으로 둔다", async (t) => {
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("응", { continueAfter: { hours: 1 } }),
    (turn) => {
      turn.createGoal({ title: "산책" });
      return turn.say([], { continueAfter: { minutes: 5 } });
    },
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advance({ seconds: 20 });
  await app.user("ㅇㅋ");

  await app.advance({ seconds: 20 });

  assert.deepEqual(continueReservation(app), [
    { at: app.at("11:00").plus({ seconds: 20 }).toISO(), state: "scheduled" },
  ]);
  assert.deepEqual(app.rows("SELECT id FROM goals"), []);
  const flow = app.row<{ answered_upto_id: number; ended_at: string | null }>(
    "SELECT answered_upto_id, ended_at FROM flows",
  );
  assert.deepEqual(flow, { answered_upto_id: 3, ended_at: null });
});

test("48j: 조용히 기다린 답장 턴의 io 중에 이어가기가 발화했으면 다음에 이어가기 턴이 돈다", async (t) => {
  const gate = new Gate();
  const llm = new ScriptedLlm().onTurn(
    (turn) => turn.say("응", { continueAfter: { minutes: 10 } }),
    async (turn) => {
      await gate.wait();
      return turn.silent();
    },
    (turn) => turn.say("어때?", { continueAfter: { hours: 1 } }),
  );
  const app = await startApp(t, { llm });
  await app.user("시작");
  await app.advanceTo("10:09");
  await app.user("ㅇㅋ");
  await app.advance({ seconds: 20 });
  await app.advanceTo("10:15");

  gate.open();
  await app.advance({ seconds: 1 });

  assert.deepEqual(app.llmTasks.slice(1), [
    "10-30 10:00 turn:user",
    "10-30 10:09 turn:reply",
    "10-30 10:15 turn:continue",
  ]);
});
