import { type Config, parseConfig } from "../../src/config.ts";

export const OWNER_CHAT_ID = 1001;

const requiredSettings = {
  provider: "openai",
  model: "test-model",
  api_key: "test-key",
  bot_token: "test-token",
  owner_chat_id: String(OWNER_CHAT_ID),
  daily_call_limit: "500",
};

/** 각본 모델은 도구를 한 라운드에 하나씩 부르므로 라운드 상한을 넉넉히 둔다. 상한을 보는 테스트만 낮춘다. */
const scriptFriendlySettings = {
  max_tool_rounds: "20",
  max_cleanup_tool_rounds: "20",
};

export type ConfigOverrides = Record<string, string>;

export function testConfigText(overrides: ConfigOverrides = {}): string {
  return Object.entries({ ...requiredSettings, ...scriptFriendlySettings, ...overrides })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function testConfig(overrides: ConfigOverrides = {}): Config {
  return parseConfig(testConfigText(overrides));
}
