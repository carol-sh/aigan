import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedLlm, inputSection } from "../fakes/scripted-llm.ts";
import { startApp } from "../rig.ts";

// docs/prompting/harness-scenario-agent-owner-shortcuts.md의 F3·F4. 꼼수를 잡는 근거가 입력의 어디에 있는지 본다.

test("시나리오 F3→F4: 회의 핑계로 닫은 흐름 뒤의 잡담을 판정할 때, 그 핑계가 직전 흐름 꼬리에 있다 (C3)", async (t) => {
  const llm = new ScriptedLlm()
    .onPlan((plan) => plan.finishPlan({ openings: [{ at: "15:00", intent: "첫 문장 다듬기" }] }))
    .onTurn(
      async (turn) => {
        await turn.createGoal({ title: "첫 문장 3버전", dueAt: "16:30" });
        return turn.say('첫 문장 3버전. 각 40자 이하. "망원시장 빵집은 오전에 가야 한다."', {
          continueAfter: { minutes: 5 },
        });
      },
      (turn) => turn.say("질문 돌리지 마. 3버전.", { continueAfter: { minutes: 5 } }),
      async (turn) => {
        await turn.reserveOpening({ at: "16:00", intent: "3버전 받기", goalIds: [1] });
        return turn.end("4시에 다시 온다. 그때 3개.");
      },
      (turn) =>
        turn.say("회의 중이라며. 고양이 볼 시간이면 3버전 쓸 시간이다. 지금.", {
          continueAfter: { minutes: 5 },
        }),
    );
  const app = await startApp(t, { at: "2026-10-30 14:50", llm });
  await app.advanceTo("15:03");
  await app.user("근데 너는 빵 좋아해?");
  await app.advanceTo("15:06");
  await app.user("5분만. 회의 들어가야 돼");
  await app.advanceTo("15:20");

  await app.user("ㅋㅋㅋㅋ 고양이가 식빵 자세로 자는 거 봤음?");
  await app.advance({ seconds: 20 });

  const judgingTurn = app.llm.lastInput("turn");
  assert.deepEqual(inputSection(judgingTurn, "직전 흐름"), [
    "15:06 종료",
    '[15:00] 나: 첫 문장 3버전. 각 40자 이하. "망원시장 빵집은 오전에 가야 한다."',
    "[15:03] 사용자: 근데 너는 빵 좋아해?",
    "[15:03] 나: 질문 돌리지 마. 3버전.",
    "[15:06] 사용자: 5분만. 회의 들어가야 돼",
    "[15:06] 나: 4시에 다시 온다. 그때 3개.",
  ]);
  assert.deepEqual(inputSection(judgingTurn, "흐름 밖 메시지"), [
    "[15:20] 사용자: ㅋㅋㅋㅋ 고양이가 식빵 자세로 자는 거 봤음?",
  ]);
  assert.deepEqual(
    inputSection(judgingTurn, "지금 활성 목표")[0],
    "- #1 첫 문장 3버전 (sample, 마감 2026-10-30 16:30, 개시 예약 #2)",
  );
  assert.deepEqual(inputSection(judgingTurn, "지금 개시 예약"), [
    "- #2 2026-10-30 16:00 3버전 받기 [목표 1] (turn)",
  ]);
  assert.equal(inputSection(judgingTurn, "이벤트")[0], "계기: 사용자 메시지(흐름 없음)");
  assert.equal(
    app.telegram.sent.at(-1),
    "회의 중이라며. 고양이 볼 시간이면 3버전 쓸 시간이다. 지금.",
  );
});
