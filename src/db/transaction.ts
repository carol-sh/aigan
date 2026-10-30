import type { DatabaseSync } from "node:sqlite";

/**
 * 이미 트랜잭션 안이면 그 트랜잭션에 합친다. 흐름 닫기처럼 호출한 쪽의 트랜잭션 안에서
 * 돌아야 하는 연산이 혼자 불려도 원자적이게 하기 위해서다.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
