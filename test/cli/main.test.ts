import assert from "node:assert/strict";
import { test } from "node:test";
import { makeDataDir, runCli } from "./run-cli.ts";

test("명령이 없거나 모르는 명령이면 사용법을 보이고 2로 끝난다", async (t) => {
  const dataDir = makeDataDir(t);
  for (const args of [[], ["start"]]) {
    const result = await runCli(args, { dataDir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^사용법: DATA_DIR=/);
  }
});

test("DATA_DIR이 없으면 1로 끝난다", async () => {
  const result = await runCli(["memory"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^DATA_DIR이 필요하다/);
});
