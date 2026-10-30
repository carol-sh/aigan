import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import { InstanceLockedError, acquireInstanceLock } from "../db/lock.ts";

const DATABASE_FILES = ["aigan.db", "aigan.db-wal", "aigan.db-shm"];
const CONFIRMATION = "reset";

/** 처음 서버를 켠 상태로 되돌린다(§9.10). DB는 지우지 않고 옮겨 실수로 리셋해도 되돌릴 수 있게 한다. */
export async function runReset(
  dataDir: string,
  readLine: () => Promise<string | undefined>,
): Promise<number> {
  let releaseLock;
  try {
    releaseLock = acquireInstanceLock(dataDir);
  } catch (error) {
    if (!(error instanceof InstanceLockedError)) throw error;
    process.stderr.write(`서버가 돌고 있다(${error.message}). 멈춘 뒤 다시 하라\n`);
    return 1;
  }
  try {
    if (!existsSync(join(dataDir, "aigan.db"))) {
      process.stdout.write("되돌릴 DB가 없다\n");
      return 0;
    }
    process.stdout.write(
      `${join(dataDir, "aigan.db")}를 backup/으로 옮긴다. 기억·목표·대화가 모두 처음으로 돌아가고, 설정·프롬프트는 그대로다.\n` +
        `계속하려면 ${CONFIRMATION}을 입력하라: `,
    );
    if ((await readLine())?.trim() !== CONFIRMATION) {
      process.stdout.write("\n취소했다\n");
      return 1;
    }
    // 설정이 깨져서 리셋하는 경우도 있어 설정의 시간대를 읽지 않는다.
    const backupDir = join(dataDir, "backup", DateTime.local().toFormat("yyyyMMdd-HHmmss"));
    mkdirSync(backupDir, { recursive: true });
    for (const file of DATABASE_FILES.filter((name) => existsSync(join(dataDir, name)))) {
      renameSync(join(dataDir, file), join(backupDir, file));
    }
    process.stdout.write(`옮겼다: ${backupDir}\n`);
    return 0;
  } finally {
    releaseLock();
  }
}
