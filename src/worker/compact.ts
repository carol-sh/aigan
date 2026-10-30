import type { Config } from "../config.ts";
import type { Flow } from "../db/repositories/flows.ts";
import type { Message } from "../db/repositories/messages.ts";
import { inTransaction } from "../db/transaction.ts";
import type { ConversationView } from "../llm/input/transcript.ts";
import { holdIfOutOfBudget } from "./budget-gate.ts";
import type { HarnessContext } from "./context.ts";

export interface CompactRequest {
  flowId: number;
  previousSummary: string | undefined;
  messages: Message[];
}

/** 흐름 대화의 앞부분을 기존 요약과 합쳐 새 요약 하나로 줄이는 쪽. 던지면 실패다. */
export interface CompactDecider {
  decide(request: CompactRequest): Promise<string>;
}

/** 턴이 커밋하고 보낸 뒤에 부른다. 사용자가 압축 호출을 기다리지 않게 하려고 전송 뒤에 둔다. */
export async function compactOpenFlowIfLong(
  ctx: HarnessContext,
  decider: CompactDecider,
): Promise<void> {
  if (ctx.prompts.compactRules === undefined) return;
  const flow = ctx.flows.findOpen();
  if (flow === undefined) return;
  // 전송 중 403으로 막 차단 보류에 들어갔을 수 있다. 게이트는 기존 보류를 보지 않아 보류를 겹쳐 넣는다.
  if (ctx.harnessState.get().hold_reason !== null) return;
  const targets = chooseMessagesToCompact(flow, findUncompactedMessages(ctx, flow), ctx.config);
  if (targets.length === 0) return;
  if (await holdIfOutOfBudget(ctx)) return;

  let summary: string;
  try {
    summary = await decider.decide({
      flowId: flow.id,
      previousSummary: flow.summary ?? undefined,
      messages: targets,
    });
  } catch (error) {
    ctx.logger.warn(`흐름 ${flow.id}의 압축이 실패했다. 다음 턴 뒤 다시 한다`, error);
    return;
  }
  inTransaction(ctx.db, () => ctx.flows.saveSummary(flow.id, summary, targets.at(-1)!.id));
}

export function findUncompactedMessages(ctx: HarnessContext, flow: Flow): Message[] {
  return viewCompactedConversation(flow, ctx.messages.findShownInFlow(flow.id)).messages;
}

export function viewCompactedConversation(flow: Flow, shownMessages: Message[]): ConversationView {
  const compactedUntilId = flow.compacted_until_id ?? 0;
  return {
    summary: flow.summary ?? undefined,
    messages: shownMessages.filter((message) => message.id > compactedUntilId),
  };
}

/**
 * 오래된 것부터 남은 구간이 임계의 절반 이하가 될 때까지 덮는다. 단 `answered_upto_id`에서 멈춘다.
 * 턴은 원문으로 본 user 메시지까지만 답한 것으로 커밋하므로, 미응답을 요약에 넣으면 성공한 턴이
 * 그것을 지우지 못하고 같은 답장 턴이 백오프 없이 계속 골라진다.
 */
export function chooseMessagesToCompact(
  flow: Flow,
  messages: Message[],
  config: Config,
): Message[] {
  let remainingChars = countChars(messages);
  if (remainingChars <= config.flow_compact_chars) return [];
  const targets: Message[] = [];
  for (const message of messages) {
    if (message.id > flow.answered_upto_id) break;
    targets.push(message);
    remainingChars -= message.content.length;
    if (remainingChars <= config.flow_compact_chars / 2) break;
  }
  return targets;
}

export function countChars(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}
