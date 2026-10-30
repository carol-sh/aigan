import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ParsedOutput, parseCleanupOutput, turnOutputParser } from "../../src/llm/outputs.ts";
import type { TurnOutput } from "../../src/worker/turn.ts";

const parseReply = turnOutputParser("reply", "Asia/Seoul");
const parseContinue = turnOutputParser("continue", "Asia/Seoul");

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** 시각을 비교하기 쉽게 로컬 문자열로 바꾼다. */
function shown(parsed: ParsedOutput<TurnOutput>) {
  if (!parsed.ok) return parsed;
  const { messages, next } = parsed.value;
  const at =
    next.kind === "continue"
      ? next.at?.setZone("Asia/Seoul").toFormat("yyyy-MM-dd HH:mm")
      : undefined;
  return { messages, next: next.kind, at };
}

function assertFails(parsed: ParsedOutput<unknown>, error: RegExp): void {
  assert.equal(parsed.ok, false, `실패해야 한다: ${JSON.stringify(parsed)}`);
  if (!parsed.ok) assert.match(parsed.error, error);
}

describe("턴 출력", () => {
  test("continue와 로컬 시각을 읽는다", () => {
    const text = json({ messages: ["가자"], next: "continue", continue_at: "2026-10-30 15:00" });
    assert.deepEqual(shown(parseReply(text)), {
      messages: ["가자"],
      next: "continue",
      at: "2026-10-30 15:00",
    });
  });

  test("continue_at이 빠지거나 null이면 시각 없이 읽는다. 메우기는 커밋이 한다", () => {
    for (const continueAt of [undefined, null]) {
      const text = json({ messages: ["응"], next: "continue", continue_at: continueAt });
      assert.deepEqual(shown(parseReply(text)), {
        messages: ["응"],
        next: "continue",
        at: undefined,
      });
    }
  });

  test("end를 읽는다. 메시지 0개도 된다", () => {
    assert.deepEqual(shown(parseReply(json({ messages: [], next: "end" }))), {
      messages: [],
      next: "end",
      at: undefined,
    });
  });

  test("end와 continue_at을 함께 쓰면 실패다", () => {
    const text = json({ messages: [], next: "end", continue_at: "2026-10-30 15:00" });
    assertFails(parseReply(text), /next가 continue일 때만/);
  });

  test("틀린 시각 형식은 실패다", () => {
    for (const continueAt of ["아침", "", "2026-10-30T15:00:00+09:00"]) {
      const text = json({ messages: ["응"], next: "continue", continue_at: continueAt });
      assertFails(parseReply(text), /YYYY-MM-DD HH:mm/);
    }
  });

  test("next가 빠지거나 모르는 값이면 실패다", () => {
    assertFails(parseReply(json({ messages: ["응"] })), /next/);
    assertFails(parseReply(json({ messages: ["응"], next: "wait" })), /next/);
  });

  test("메시지가 문자열 배열이 아니거나 빈 문자열이면 실패다", () => {
    assertFails(parseReply(json({ messages: "응", next: "end" })), /messages/);
    assertFails(parseReply(json({ messages: [1], next: "end" })), /messages/);
    assertFails(parseReply(json({ messages: ["  "], next: "end" })), /빈 메시지/);
  });

  test("말 없이 이어가기는 이어가기 턴에서만 실패고, 답장 턴에서는 조용히 기다림이다", () => {
    const text = json({ messages: [], next: "continue" });
    assertFails(parseContinue(text), /이어가기 턴은 말 없이 이어갈 수 없다/);
    assert.equal(parseReply(text).ok, true);
  });

  test("JSON 객체가 아니면 실패다", () => {
    for (const text of ["", "응 알았어", "[]", "null", '"end"']) {
      assertFails(parseReply(text), /JSON 객체가 아니다/);
    }
  });

  test("코드 펜스로 감싼 JSON은 펜스를 벗겨 읽는다", () => {
    const text = "```json\n" + json({ messages: ["응"], next: "end" }) + "\n```";
    assert.equal(parseReply(text).ok, true);
  });
});

describe("정리 출력", () => {
  test("JSON 객체면 무엇이든 받는다", () => {
    assert.deepEqual(parseCleanupOutput("{}"), { ok: true, value: undefined });
    assert.deepEqual(parseCleanupOutput(json({ done: true })), { ok: true, value: undefined });
  });

  test("JSON 객체가 아니면 실패다", () => {
    assertFails(parseCleanupOutput("다 했다"), /JSON 객체가 아니다/);
  });
});
