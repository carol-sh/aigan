import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedLlm, inputSection } from "../fakes/scripted-llm.ts";
import { type StartOptions, startApp } from "../rig.ts";

/** 첫 흐름의 정리가 칸 둘을 쓰고, 다음 사용자 흐름의 턴 입력을 본다. */
async function turnMemoryAfterCleanup(t: Parameters<typeof startApp>[0], options: StartOptions) {
  const llm = new ScriptedLlm()
    .onTurn(
      (turn) => turn.end("그래"),
      (turn) => turn.end("또 왔네"),
    )
    .onCleanup(async (cleanup) => {
      await cleanup.use("state_write", { content: "register: baseline" });
      await cleanup.use("memory_write", { title: "전략", content: "- 10-30 | 핑계 | 반려" });
      await cleanup.use("memory_write", { title: "흐름", content: "- 10-30 | 짧게 끝남" });
    });
  const app = await startApp(t, { ...options, llm });
  await app.user("오늘 끝");
  await app.advance({ seconds: 20 });
  await app.user("다시 왔어");
  await app.advance({ seconds: 20 });
  return inputSection(llm.lastInput("turn"), "기억");
}

test("턴 입력의 기억은 기본으로 칸 제목만 보여 준다", async (t) => {
  assert.deepEqual(await turnMemoryAfterCleanup(t, {}), ["register: baseline", "칸: 전략, 흐름"]);
});

test("turn_memory_sections에 적은 칸만 턴 입력에 본문까지 보이고, 없는 칸 이름은 건너뛴다", async (t) => {
  const memory = await turnMemoryAfterCleanup(t, {
    config: { turn_memory_sections: "전략, 관계" },
  });

  assert.deepEqual(memory, [
    "register: baseline",
    "칸: 전략, 흐름",
    "[칸 전략]",
    "  - 10-30 | 핑계 | 반려",
  ]);
});
