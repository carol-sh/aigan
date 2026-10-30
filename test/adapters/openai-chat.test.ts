import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { createOpenAiChatClient } from "../../src/adapters/openai-chat.ts";
import { testConfig } from "../fakes/config.ts";
import { FakeApiServer, chatCompletion } from "../fakes/fake-api-server.ts";

const params: ChatCompletionCreateParamsNonStreaming = {
  model: "test-model",
  messages: [{ role: "user", content: "안녕" }],
  response_format: { type: "json_object" },
};

async function startServer(t: TestContext) {
  const server = await FakeApiServer.start();
  t.after(() => server.close());
  const chat = createOpenAiChatClient(testConfig({ llm_base_url: `${server.url}/v1` }));
  return { server, chat };
}

test("OpenAI 클라이언트는 요청을 그대로 chat/completions에 키와 함께 보내고 답을 돌려준다", async (t) => {
  const { server, chat } = await startServer(t);
  server.replyToChat(chatCompletion('{"messages":[],"next":"end"}'));

  const completion = await chat.create(params);

  assert.equal(completion.choices[0]?.message.content, '{"messages":[],"next":"end"}');
  assert.deepEqual(server.chatRequests, [{ authorization: "Bearer test-key", body: params }]);
});

test("OpenAI 클라이언트는 SDK 재시도 없이 오류를 바로 던진다", async (t) => {
  const { server, chat } = await startServer(t);
  server.replyToChat({ status: 500, body: { error: { message: "고장" } } });

  await assert.rejects(chat.create(params));

  assert.equal(server.chatRequests.length, 1);
});
