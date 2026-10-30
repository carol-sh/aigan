import OpenAI from "openai";
import type { Config } from "../config.ts";
import type { ChatClient } from "../ports.ts";

const REQUEST_TIMEOUT_MS = 180_000;

/** SDK 재시도는 끈다. 실패한 요청의 재시도는 하네스 백오프가 맡고, 요청마다 `daily_calls`와 `llm_calls`에 남는다. */
export function createOpenAiChatClient(config: Config): ChatClient {
  const client = new OpenAI({
    apiKey: config.api_key,
    baseURL: config.llm_base_url,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return { create: (params) => client.chat.completions.create(params) };
}
