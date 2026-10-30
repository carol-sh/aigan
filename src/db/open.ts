import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./transaction.ts";

const migrationsDirectory = new URL("./migrations/", import.meta.url);

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const appliedVersion = readUserVersion(db);
  for (const migration of listMigrations()) {
    if (migration.version <= appliedVersion) continue;
    inTransaction(db, () => {
      db.exec(readFileSync(new URL(migration.fileName, migrationsDirectory), "utf8"));
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function listMigrations(): { version: number; fileName: string }[] {
  return readdirSync(migrationsDirectory)
    .filter((fileName) => /^\d{3}_.+\.sql$/.test(fileName))
    .sort()
    .map((fileName) => ({ version: Number(fileName.slice(0, 3)), fileName }));
}
