import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../../src/db/open.ts";
import { makeDataDir, runCli } from "./run-cli.ts";

function makeDataDirWithDatabase(t: Parameters<typeof makeDataDir>[0]): string {
  const dataDir = makeDataDir(t);
  openDatabase(join(dataDir, "aigan.db")).close();
  return dataDir;
}

function backups(dataDir: string): string[] {
  const backupRoot = join(dataDir, "backup");
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot).flatMap((dir) =>
    readdirSync(join(backupRoot, dir)).map((file) => `${dir}/${file}`),
  );
}

test("reset은 reset을 입력하면 DB를 backup/<시각>/으로 옮기고 설정·프롬프트는 둔다", async (t) => {
  const dataDir = makeDataDirWithDatabase(t);

  const result = await runCli(["reset"], { dataDir, input: "reset\n" });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(!existsSync(join(dataDir, "aigan.db")));
  assert.ok(backups(dataDir).some((path) => /^\d{8}-\d{6}\/aigan\.db$/.test(path)));
  assert.ok(existsSync(join(dataDir, "config")));
  assert.ok(existsSync(join(dataDir, "prompts", "turn-rules.md")));
  assert.ok(!existsSync(join(dataDir, "aigan.lock")));
  assert.match(result.stdout, /옮겼다: /);
});

test("reset은 확인 입력이 다르면 아무것도 옮기지 않는다", async (t) => {
  const dataDir = makeDataDirWithDatabase(t);

  const result = await runCli(["reset"], { dataDir, input: "yes\n" });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /취소했다/);
  assert.ok(existsSync(join(dataDir, "aigan.db")));
  assert.deepEqual(backups(dataDir), []);
});

test("reset은 서버가 잠금을 잡고 있으면 거부한다", async (t) => {
  const dataDir = makeDataDirWithDatabase(t);
  writeFileSync(join(dataDir, "aigan.lock"), String(process.pid));

  const result = await runCli(["reset"], { dataDir, input: "reset\n" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /서버가 돌고 있다/);
  assert.ok(existsSync(join(dataDir, "aigan.db")));
  assert.deepEqual(backups(dataDir), []);
});

test("reset은 DB가 없으면 되돌릴 것이 없다고 한다", async (t) => {
  const dataDir = makeDataDir(t);

  const result = await runCli(["reset"], { dataDir });

  assert.deepEqual(result, { code: 0, stdout: "되돌릴 DB가 없다\n", stderr: "" });
});
