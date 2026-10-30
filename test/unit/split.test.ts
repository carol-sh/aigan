import assert from "node:assert/strict";
import { test } from "node:test";
import { splitForTelegram } from "../../src/worker/send.ts";

test("한도 안이면 그대로 한 덩어리다", () => {
  assert.deepEqual(splitForTelegram("안녕\n잘 지내?", 10), ["안녕\n잘 지내?"]);
});

test("줄바꿈 경계에서 나눈다", () => {
  assert.deepEqual(splitForTelegram("aaaa\nbbbb\ncccc", 9), ["aaaa\nbbbb", "cccc"]);
});

test("한 줄이 한도보다 길면 그 줄을 한도 단위로 자른다", () => {
  assert.deepEqual(splitForTelegram("ab\ncdefghij\nk", 4), ["ab", "cdef", "ghij", "k"]);
});

test("빈 메시지도 한 덩어리다", () => {
  assert.deepEqual(splitForTelegram(""), [""]);
});
