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

export type ConfigOverrides = Record<string, string>;

export function testConfigText(overrides: ConfigOverrides = {}): string {
  return Object.entries({ ...requiredSettings, ...overrides })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function testConfig(overrides: ConfigOverrides = {}): Config {
  return parseConfig(testConfigText(overrides));
}
