import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ConfigError, parseConfig } from "../../src/config.ts";
import { testConfig, testConfigText } from "../fakes/config.ts";

test("비운 키는 기본값을 쓴다", () => {
  const config = parseConfig(testConfigText({ message_debounce_sec: "" }));
  assert.equal(config.message_debounce_sec, 20);
  assert.deepEqual(config.blackout, { start: { hour: 0, minute: 0 }, end: { hour: 8, minute: 0 } });
  assert.equal(config.reasoning_effort, undefined);
});

test("examples/config.example은 필수 키만 채우면 그대로 쓸 수 있다", () => {
  const example = readFileSync("examples/config.example", "utf8");
  const filled = example
    .replace(/^model=$/m, "model=gpt-4o")
    .replace(/^api_key=$/m, "api_key=k")
    .replace(/^bot_token=$/m, "bot_token=t")
    .replace(/^owner_chat_id=$/m, "owner_chat_id=1")
    .replace(/^daily_call_limit=$/m, "daily_call_limit=300");
  const config = parseConfig(filled);
  assert.equal(config.timer_max_sleep_sec, 60);
  assert.equal(config.memory_max_sections, 10);
});

test("blackout은 HH:MM-HH:MM이고 자정을 넘길 수 있다", () => {
  assert.deepEqual(testConfig({ blackout: "23:30-07:00" }).blackout, {
    start: { hour: 23, minute: 30 },
    end: { hour: 7, minute: 0 },
  });
});

test("blackout이 형식에 어긋나거나 길이가 0이면 거부한다", () => {
  for (const blackout of ["0:00-08:00", "25:00-08:00", "08:00-08:00", "anytime"]) {
    assert.throws(() => testConfig({ blackout }), ConfigError, blackout);
  }
});

test("필수 키가 비어 있으면 거부한다", () => {
  assert.throws(() => testConfig({ bot_token: "" }), ConfigError);
  assert.throws(() => testConfig({ daily_call_limit: "" }), ConfigError);
});

test("deepseek은 잔액 설정이 필요하다", () => {
  assert.throws(() => testConfig({ provider: "deepseek" }), ConfigError);
  const config = testConfig({
    provider: "deepseek",
    balance_threshold: "1",
    balance_retry_sec: "600",
  });
  assert.equal(config.balance_threshold, 1);
});

test("모르는 시간대는 거부한다", () => {
  assert.throws(() => testConfig({ timezone: "Mars/Olympus" }), ConfigError);
});

test("llm_base_url과 telegram_api_root는 비우면 공식 주소를 쓰고, URL이 아니면 거부한다", () => {
  assert.equal(testConfig().llm_base_url, undefined);
  assert.equal(
    testConfig({ telegram_api_root: "http://127.0.0.1:8081" }).telegram_api_root,
    "http://127.0.0.1:8081",
  );
  for (const key of ["llm_base_url", "telegram_api_root"]) {
    assert.throws(() => testConfig({ [key]: "api.example" }), ConfigError, key);
  }
});
