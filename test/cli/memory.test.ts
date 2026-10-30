import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DateTime } from "luxon";
import { openDatabase } from "../../src/db/open.ts";
import { MemoryRepository } from "../../src/db/repositories/memory.ts";
import { makeDataDir, runCli } from "./run-cli.ts";

test("90j: memory는 서버가 잠금을 잡고 있어도 state와 칸을 읽기만 해서 출력한다", async (t) => {
  const dataDir = makeDataDir(t);
  const db = openDatabase(join(dataDir, "aigan.db"));
  const memory = new MemoryRepository(db);
  const write = { flowId: 3, writtenAt: DateTime.fromISO("2026-10-30T01:00:20Z") };
  memory.writeState("아침형", write);
  memory.writeSection("습관", "저녁에 끝낸다\n아침에 몰아서 한다", write);
  memory.writeSection("약점", "제약을 안 본다", { ...write, flowId: 4 });
  const before = { state: memory.findState(), sections: memory.listSections() };
  db.close();
  writeFileSync(join(dataDir, "aigan.lock"), String(process.pid));

  const result = await runCli(["memory"], { dataDir });

  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    [
      "[state] 갱신 2026-10-30 10:00 (흐름 #3)",
      "아침형",
      "",
      "[습관] 갱신 2026-10-30 10:00 (흐름 #3)",
      "저녁에 끝낸다",
      "아침에 몰아서 한다",
      "",
      "[약점] 갱신 2026-10-30 10:00 (흐름 #4)",
      "제약을 안 본다",
      "",
    ].join("\n"),
  );
  const after = openDatabase(join(dataDir, "aigan.db"));
  const afterMemory = new MemoryRepository(after);
  assert.deepEqual(
    { state: afterMemory.findState(), sections: afterMemory.listSections() },
    before,
  );
  after.close();
  assert.ok(existsSync(join(dataDir, "aigan.lock")));
});

test("memory는 기억이 비었으면 비었다고, DB가 없으면 아직 없다고 출력한다", async (t) => {
  const dataDir = makeDataDir(t);
  assert.deepEqual(await runCli(["memory"], { dataDir }), {
    code: 0,
    stdout: "아직 기억이 없다\n",
    stderr: "",
  });

  openDatabase(join(dataDir, "aigan.db")).close();
  const result = await runCli(["memory"], { dataDir });

  assert.equal(result.stdout, "[state] (비어 있음)\n\n(칸 없음)\n");
});
