import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { DateTime } from "luxon";
import type { LlmCallKind } from "../db/repositories/llm-calls.ts";
import type { HarnessContext } from "../worker/context.ts";
import { type ToolBox, type ToolResult, rejected } from "../worker/tools/tool-box.ts";
import { toFunctionTools } from "./function-tools.ts";
import type { OutputParser } from "./outputs.ts";

export interface ConversationSetup {
  kind: LlmCallKind;
  flowId: number | null;
  messages: ChatCompletionMessageParam[];
  tools: ToolBox;
  maxToolRounds: number;
}

/** 요청이 실패했거나(`api`), 재시도까지 답을 읽을 수 없었다(`output`). */
export class LlmCallError extends Error {
  readonly isOutputFailure: boolean;

  constructor(message: string, options: { isOutputFailure: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.isOutputFailure = options.isOutputFailure;
  }
}

/**
 * 모델과의 대화 하나. 도구를 부르면 실행해 결과를 잇고, 최종 답을 읽는다. 읽지 못하면 한 번 더 묻는다.
 * 대화는 쌓이므로 `askAgain`은 앞의 도구 호출과 답을 모델이 그대로 본 채로 잇는다.
 */
export class LlmConversation {
  readonly #ctx: HarnessContext;
  readonly #setup: ConversationSetup;
  readonly #messages: ChatCompletionMessageParam[];

  constructor(ctx: HarnessContext, setup: ConversationSetup) {
    this.#ctx = ctx;
    this.#setup = setup;
    this.#messages = [...setup.messages];
  }

  async ask<T>(parse: OutputParser<T>): Promise<T> {
    for (let round = 0; ; round++) {
      const isForced = round >= this.#setup.maxToolRounds;
      const reply = await this.#send(isForced, parse);
      if (!isForced && reply.tool_calls?.length) {
        this.#runToolCalls(reply.tool_calls, reply.content);
        continue;
      }
      const parsed = parse(reply.content ?? "");
      if (parsed.ok) {
        this.#messages.push({ role: "assistant", content: reply.content });
        return parsed.value;
      }
      return this.#askToFixUnreadableReply(reply, parsed.error, parse);
    }
  }

  async askAgain<T>(feedback: string, parse: OutputParser<T>): Promise<T> {
    this.#messages.push({ role: "user", content: feedback });
    return this.ask(parse);
  }

  #runToolCalls(calls: ChatCompletionMessageToolCall[], content: string | null): void {
    this.#messages.push({ role: "assistant", content, tool_calls: calls });
    for (const call of calls) {
      const result = this.#runToolCall(call);
      this.#messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  #runToolCall(call: ChatCompletionMessageToolCall): ToolResult {
    if (call.type !== "function") return rejected("이 형식의 도구는 없다");
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return rejected("도구 인자가 JSON이 아니다");
    }
    return this.#setup.tools.use(call.function.name, args);
  }

  async #askToFixUnreadableReply<T>(
    reply: ChatCompletionMessage,
    error: string,
    parse: OutputParser<T>,
  ): Promise<T> {
    this.#messages.push(
      { role: "assistant", content: reply.content ?? "" },
      {
        role: "user",
        content: `출력이 형식에 맞지 않는다: ${error}\n형식에 맞는 JSON 객체 하나로 다시 답하라.`,
      },
    );
    const retry = await this.#send(true, parse);
    const parsed = parse(retry.content ?? "");
    if (!parsed.ok) {
      throw new LlmCallError(`parse: ${parsed.error}`, { isOutputFailure: true });
    }
    this.#messages.push({ role: "assistant", content: retry.content });
    return parsed.value;
  }

  async #send(isForced: boolean, parse: OutputParser<unknown>): Promise<ChatCompletionMessage> {
    const ctx = this.#ctx;
    const request = this.#request(isForced);
    const sentAt = ctx.clock.now();
    ctx.harnessState.countLlmRequest(ctx.calendar.localDate(sentAt));

    let completion: ChatCompletion;
    try {
      completion = await ctx.chat.create(request);
    } catch (error) {
      const message = `api: ${error instanceof Error ? error.message : String(error)}`;
      this.#record(request, undefined, sentAt, message);
      throw new LlmCallError(message, { isOutputFailure: false, cause: error });
    }

    const reply = completion.choices[0]?.message;
    if (reply === undefined) {
      this.#record(request, completion, sentAt, "api: 답에 메시지가 없다");
      throw new LlmCallError("api: 답에 메시지가 없다", { isOutputFailure: false });
    }
    this.#record(request, completion, sentAt, describeReplyProblem(reply, isForced, parse));
    this.#ctx.logger.info(formatLlmReply(this.#setup.kind, reply));
    return reply;
  }

  /** 강제 호출에도 `tools`를 빼지 않는다. 도구 정의가 캐시 prefix에 들어 있어서, 빼면 캐시를 놓친다. */
  #request(isForced: boolean): ChatCompletionCreateParamsNonStreaming {
    const { config } = this.#ctx;
    const tools = toFunctionTools(this.#setup.tools);
    return {
      model: config.model,
      messages: [...this.#messages],
      response_format: { type: "json_object" },
      ...(tools.length > 0 && { tools }),
      ...(isForced && tools.length > 0 && { tool_choice: "none" }),
      ...(config.reasoning_effort !== undefined && {
        reasoning_effort:
          config.reasoning_effort as ChatCompletionCreateParamsNonStreaming["reasoning_effort"],
      }),
    };
  }

  #record(
    request: ChatCompletionCreateParamsNonStreaming,
    completion: ChatCompletion | undefined,
    sentAt: DateTime,
    error: string | null,
  ): void {
    const usage = completion?.usage;
    this.#ctx.llmCalls.record({
      kind: this.#setup.kind,
      flowId: this.#setup.flowId,
      request,
      response: completion,
      inputTokens: usage?.prompt_tokens ?? null,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
      latencyMs: this.#ctx.clock.now().diff(sentAt).toMillis(),
      error,
      createdAt: sentAt,
    });
  }
}

function formatLlmReply(kind: LlmCallKind, reply: ChatCompletionMessage): string {
  const lines = [`LLM ${kind}`];
  const content = reply.content?.trim();
  if (content) lines.push(content);
  for (const call of reply.tool_calls ?? []) {
    if (call.type !== "function") continue;
    lines.push(`tool ${call.function.name} ${call.function.arguments}`);
  }
  if (lines.length === 1) lines.push("(내용 없음)");
  return lines.join("\n");
}

/** 기록에 남길 실패 사유. 도구를 부른 답은 정상이고, 최종 답은 읽어 보고 정한다. */
function describeReplyProblem(
  reply: ChatCompletionMessage,
  isForced: boolean,
  parse: OutputParser<unknown>,
): string | null {
  if (!isForced && reply.tool_calls?.length) return null;
  const parsed = parse(reply.content ?? "");
  return parsed.ok ? null : `parse: ${parsed.error}`;
}
