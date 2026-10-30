import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { CompactRequest } from "../../worker/compact.ts";
import { NONE, type TimeView, renderMessages, renderSection } from "./transcript.ts";

export function renderCompactInput(
  { previousSummary, messages }: CompactRequest,
  compactRules: string,
  view: TimeView,
): ChatCompletionMessageParam[] {
  const document = [
    renderSection("기존 요약", [previousSummary ?? NONE]),
    renderSection("줄일 대화", renderMessages(messages, view)),
  ].join("\n\n");

  return [
    { role: "system", content: compactRules },
    { role: "user", content: document },
  ];
}
