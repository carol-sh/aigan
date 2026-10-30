import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../../src/db/open.ts";

function openFlow(db: ReturnType<typeof openDatabase>) {
  return db
    .prepare(
      "INSERT INTO flows (opener, plan_date, started_at) VALUES ('user', '2026-10-30', '2026-10-30T01:00:00Z')",
    )
    .run();
}

test("마이그레이션은 초기 행을 넣고 user_version을 올린다", () => {
  const db = openDatabase(":memory:");
  assert.deepEqual(
    { ...db.prepare("SELECT failure_count, hold_reason FROM harness_state").get() },
    {
      failure_count: 0,
      hold_reason: null,
    },
  );
  assert.equal(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    1,
  );
});

test("I1: 열린 흐름은 둘일 수 없다", () => {
  const db = openDatabase(":memory:");
  openFlow(db);
  assert.throws(() => openFlow(db), /UNIQUE/);
});

test("I2: 흐름 하나에 이어가기 예약은 하나뿐이다", () => {
  const db = openDatabase(":memory:");
  const flowId = Number(openFlow(db).lastInsertRowid);
  const insertContinue = db.prepare(
    "INSERT INTO reservations (kind, at, flow_id, source, created_at) VALUES ('continue', ?, ?, 'turn', ?)",
  );
  insertContinue.run("2026-10-30T02:00:00Z", flowId, "2026-10-30T01:00:00Z");
  assert.throws(
    () => insertContinue.run("2026-10-30T03:00:00Z", flowId, "2026-10-30T01:00:00Z"),
    /UNIQUE/,
  );
});
