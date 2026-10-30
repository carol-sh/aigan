import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("SQLite runs in memory without external services", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)");
  db.prepare("INSERT INTO t VALUES (?)").run(1);
  assert.deepEqual({ ...db.prepare("SELECT x FROM t").get() }, { x: 1 });
  db.close();
});
