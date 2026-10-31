import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { z } from "zod";

export interface ClockTime {
  hour: number;
  minute: number;
}

export interface BlackoutWindow {
  start: ClockTime;
  end: ClockTime;
}

const seconds = (defaultValue: number) =>
  z.coerce.number().int().nonnegative().default(defaultValue);
const positiveSeconds = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);
const milliseconds = seconds;
const positiveCount = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);
const nonNegativeCount = seconds;

const blackoutWindow = z
  .string()
  .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "HH:MM-HH:MM 형식이어야 한다")
  .transform(parseBlackoutWindow)
  .refine(
    (window) => isValidClockTime(window.start) && isValidClockTime(window.end),
    "없는 시각이다",
  )
  .refine(
    (window) => window.start.hour !== window.end.hour || window.start.minute !== window.end.minute,
    "시작과 끝이 같다",
  );

const configSchema = z
  .object({
    provider: z.enum(["openai", "deepseek"]),
    model: z.string(),
    reasoning_effort: z.string().optional(),
    api_key: z.string(),
    llm_base_url: z.url().optional(),
    bot_token: z.string(),
    telegram_api_root: z.url().optional(),
    owner_chat_id: z.coerce.number().int(),
    daily_call_limit: z.coerce.number().int().positive(),
    balance_threshold: z.coerce.number().optional(),
    balance_retry_sec: z.coerce.number().int().positive().optional(),

    timezone: z.string().default("Asia/Seoul"),
    blackout: z.string().default("00:00-08:00").pipe(blackoutWindow),
    message_debounce_sec: seconds(20),
    min_lead_sec: seconds(60),
    continue_default_sec: seconds(600),
    orphan_goal_delay_sec: seconds(3600),
    stale_after_sec: seconds(1800),
    send_interval_ms: milliseconds(800),
    timer_max_sleep_sec: positiveSeconds(60),

    failure_backoff_first_sec: positiveSeconds(600),
    failure_backoff_cap_sec: positiveSeconds(7200),
    failure_alert_after: positiveCount(3),
    turn_max_attempts: positiveCount(3),
    cleanup_max_attempts: positiveCount(5),
    cleanup_backoff_first_sec: positiveSeconds(30),
    cleanup_backoff_cap_sec: positiveSeconds(300),
    max_tool_rounds: positiveCount(4),
    max_cleanup_tool_rounds: positiveCount(5),

    goal_max_active: positiveCount(8),
    open_max_pending: positiveCount(6),
    outside_messages_max: positiveCount(20),
    prev_flow_tail_messages: nonNegativeCount(6),
    prev_flow_tail_max_age_sec: seconds(10800),
    recent_goal_days: positiveCount(7),
    flow_compact_chars: positiveCount(24000),
    cleanup_raw_max_chars: positiveCount(60000),
    state_max_chars: positiveCount(1000),
    memory_section_max_chars: positiveCount(8000),
    memory_max_sections: positiveCount(10),
    turn_memory_sections: z
      .string()
      .default("")
      .transform((text) =>
        text
          .split(",")
          .map((title) => title.trim())
          .filter((title) => title !== ""),
      ),
  })
  .refine((config) => isKnownTimezone(config.timezone), {
    path: ["timezone"],
    message: "IANA 시간대가 아니다",
  })
  .refine(
    (config) =>
      config.provider !== "deepseek" ||
      (config.balance_threshold !== undefined && config.balance_retry_sec !== undefined),
    {
      path: ["balance_threshold"],
      message: "provider=deepseek면 balance_threshold와 balance_retry_sec가 필요하다",
    },
  );

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, "utf8"));
}

export function parseConfig(text: string): Config {
  const entries = parseEnv(text);
  if (entries.blackout !== undefined && entries.blackout.trim() === "") {
    throw new ConfigError("blackout은 비울 수 없다. 블랙아웃이 없으면 계획일이 넘어가지 않는다");
  }
  const result = configSchema.safeParse(withoutBlankValues(entries));
  if (!result.success) {
    throw new ConfigError(`설정이 잘못됐다\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function withoutBlankValues(entries: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value.trim() !== "") kept[key] = value.trim();
  }
  return kept;
}

function parseBlackoutWindow(text: string): BlackoutWindow {
  const [start = "", end = ""] = text.split("-");
  return { start: parseClockTime(start), end: parseClockTime(end) };
}

function parseClockTime(text: string): ClockTime {
  const [hour = Number.NaN, minute = Number.NaN] = text.split(":").map(Number);
  return { hour, minute };
}

function isValidClockTime({ hour, minute }: ClockTime): boolean {
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
}

function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
