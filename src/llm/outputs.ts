import { z } from "zod";
import { parseLocalTime } from "../worker/reservation-times.ts";
import type { PlanOutput } from "../worker/plan.ts";
import type { TurnTask } from "../worker/tasks.ts";
import type { TurnOutput } from "../worker/turn.ts";

export type ParsedOutput<T> = { ok: true; value: T } | { ok: false; error: string };

export type OutputParser<T> = (text: string) => ParsedOutput<T>;

const turnOutputSchema = z.object({
  messages: z.array(z.string().trim().min(1, "빈 메시지는 보낼 수 없다")),
  next: z.enum(["continue", "end"]),
  continue_at: z.string().nullish(),
});

export function turnOutputParser(
  trigger: TurnTask["trigger"],
  timezone: string,
): OutputParser<TurnOutput> {
  return (text) => {
    const parsed = parseJsonObject(text, turnOutputSchema);
    if (!parsed.ok) return parsed;
    const { messages, next, continue_at: continueAt } = parsed.value;

    if (next === "end") {
      if (continueAt != null) return failed("continue_at은 next가 continue일 때만 쓴다");
      return { ok: true, value: { messages, next: { kind: "end" } } };
    }
    if (trigger === "continue" && messages.length === 0) {
      return failed(
        "이어가기 턴은 말 없이 이어갈 수 없다. 기다리려면 한 줄이라도 말하거나 end한다",
      );
    }
    if (continueAt == null) return { ok: true, value: { messages, next: { kind: "continue" } } };
    const at = parseLocalTime(continueAt, timezone);
    if (at === undefined) {
      return failed(`continue_at ${continueAt}는 YYYY-MM-DD HH:mm 형식이 아니다`);
    }
    return { ok: true, value: { messages, next: { kind: "continue", at } } };
  };
}

/** 정리의 결과는 도구 효과가 전부라, 최종 답은 JSON 객체이기만 하면 된다. */
export const parseCleanupOutput: OutputParser<void> = (text) => {
  const parsed = parseJsonObject(text, z.object({}));
  return parsed.ok ? { ok: true, value: undefined } : parsed;
};

const planOutputSchema = z.object({
  body: z.string().trim().min(1, "계획 본문이 비었다"),
  openings: z.array(
    z.object({
      at: z.string(),
      intent: z.string().trim().min(1, "intent가 비었다"),
      goal_ids: z.array(z.number().int()).optional(),
    }),
  ),
});

export function planOutputParser(timezone: string): OutputParser<PlanOutput> {
  return (text) => {
    const parsed = parseJsonObject(text, planOutputSchema);
    if (!parsed.ok) return parsed;
    const openings: PlanOutput["openings"] = [];
    for (const opening of parsed.value.openings) {
      const at = parseLocalTime(opening.at, timezone);
      if (at === undefined) return failed(`at ${opening.at}는 YYYY-MM-DD HH:mm 형식이 아니다`);
      openings.push({ at, intent: opening.intent, goalIds: opening.goal_ids ?? [] });
    }
    return { ok: true, value: { body: parsed.value.body, openings } };
  };
}

function parseJsonObject<T>(text: string, schema: z.ZodType<T>): ParsedOutput<T> {
  let json: unknown;
  try {
    json = JSON.parse(withoutCodeFence(text));
  } catch {
    return failed("JSON 객체가 아니다");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return failed("JSON 객체가 아니다");
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, value: result.data } : failed(z.prettifyError(result.error));
}

function withoutCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

function failed(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
