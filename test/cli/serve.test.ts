import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { DateTime } from "luxon";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { OWNER_CHAT_ID } from "../fakes/config.ts";
import { FakeApiServer, chatCompletion } from "../fakes/fake-api-server.ts";
import { CliProcess, makeDataDir, runCli, waitUntil } from "./run-cli.ts";

/** 계획에는 빈 계획을, 턴에는 인사 한마디로 흐름을 끝내는 답을 낸다. 도구 목록으로 호출을 가린다. */
function answerPlanAndTurn(params: ChatCompletionCreateParamsNonStreaming) {
  const toolNames = (params.tools ?? []).map((tool) =>
    tool.type === "function" ? tool.function.name : "",
  );
  return toolNames.includes("goal_create")
    ? chatCompletion(JSON.stringify({ messages: ["반가워"], next: "end" }))
    : chatCompletion(JSON.stringify({ body: "오늘은 쉬어 간다", openings: [] }));
}

/** 지금이 블랙아웃이면 판정 턴이 돌지 않는다. 블랙아웃을 지금으로부터 두 시간 뒤에 둔다. */
function blackoutAwayFromNow(): string {
  const now = DateTime.now().setZone("Asia/Seoul");
  return `${now.plus({ hours: 2 }).toFormat("HH:mm")}-${now.plus({ hours: 3 }).toFormat("HH:mm")}`;
}

async function startServerAndDataDir(t: TestContext) {
  const server = await FakeApiServer.start();
  t.after(() => server.close());
  server.respondToChatWith(answerPlanAndTurn);
  const dataDir = makeDataDir(t, {
    llm_base_url: `${server.url}/v1`,
    telegram_api_root: server.url,
    message_debounce_sec: "0",
    blackout: blackoutAwayFromNow(),
  });
  return { server, dataDir };
}

test("serve는 텔레그램 메시지를 받아 LLM 턴을 돌려 답하고, SIGTERM에 잠금을 풀고 0으로 끝난다", async (t) => {
  const { server, dataDir } = await startServerAndDataDir(t);
  const serve = new CliProcess(["serve"], dataDir);
  t.after(() => serve.signal("SIGKILL"));
  await waitUntil(() => server.chatRequests.length === 1);

  server.queueTextUpdate("안녕", OWNER_CHAT_ID);
  await waitUntil(() => server.callsTo("sendMessage").length === 1);
  const second = await runCli(["serve"], { dataDir });
  serve.signal("SIGTERM");
  const result = await serve.exited;

  assert.deepEqual(server.callsTo("sendMessage"), [{ chat_id: OWNER_CHAT_ID, text: "반가워" }]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /시작하지 못했다: 다른 aigan\(pid \d+\)/);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /SIGTERM를 받아 멈춘다/);
  assert.ok(!existsSync(join(dataDir, "aigan.lock")));
  const db = new DatabaseSync(join(dataDir, "aigan.db"), { readOnly: true });
  assert.deepEqual(
    db
      .prepare("SELECT kind, success FROM llm_calls ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { kind: "plan", success: 1 },
      { kind: "turn", success: 1 },
    ],
  );
  db.close();
});

test("serve는 설정이 잘못됐거나 provider=deepseek면 잠금을 잡지 않고 1로 끝난다", async (t) => {
  const broken = makeDataDir(t, { api_key: "" });
  const deepseek = makeDataDir(t, {
    provider: "deepseek",
    balance_threshold: "1",
    balance_retry_sec: "600",
  });

  const brokenResult = await runCli(["serve"], { dataDir: broken });
  const deepseekResult = await runCli(["serve"], { dataDir: deepseek });

  assert.equal(brokenResult.code, 1);
  assert.match(brokenResult.stderr, /시작하지 못했다: 설정이 잘못됐다/);
  assert.equal(deepseekResult.code, 1);
  assert.match(deepseekResult.stderr, /provider=deepseek는 아직 지원하지 않는다/);
  assert.ok(!existsSync(join(broken, "aigan.lock")));
  assert.ok(!existsSync(join(deepseek, "aigan.lock")));
});
