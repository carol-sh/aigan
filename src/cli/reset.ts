import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import { InstanceLockedError, acquireInstanceLock } from "../db/lock.ts";

const DATABASE_FILES = ["aigan.db", "aigan.db-wal", "aigan.db-shm"];

type ReadLine = () => Promise<string | undefined>;

/** 처음 서버를 켠 상태로 되돌린다(§9.10). DB는 지우지 않고 옮겨 실수로 리셋해도 되돌릴 수 있게 한다. */
export function runReset(dataDir: string, readLine: ReadLine): Promise<number> {
  return changeDatabaseOffline(dataDir, readLine, {
    confirmation: "reset",
    noDatabaseMessage: "되돌릴 DB가 없다",
    warning: `${join(dataDir, "aigan.db")}를 backup/으로 옮긴다. 기억·목표·대화가 모두 처음으로 돌아가고, 설정·프롬프트는 그대로다.`,
    change() {
      // 설정이 깨져서 리셋하는 경우도 있어 설정의 시간대를 읽지 않는다.
      const backupDir = join(dataDir, "backup", DateTime.local().toFormat("yyyyMMdd-HHmmss"));
      mkdirSync(backupDir, { recursive: true });
      for (const file of existingDatabaseFiles(dataDir)) {
        renameSync(join(dataDir, file), join(backupDir, file));
      }
      return `옮겼다: ${backupDir}`;
    },
  });
}

/** 리셋과 같지만 백업 없이 지운다. 스키마가 바뀌어 옛 DB를 버릴 때 쓴다. */
export function runWipe(dataDir: string, readLine: ReadLine): Promise<number> {
  return changeDatabaseOffline(dataDir, readLine, {
    confirmation: "wipe",
    noDatabaseMessage: "지울 DB가 없다",
    warning: `${join(dataDir, "aigan.db")}를 백업 없이 지운다. 기억·목표·대화가 모두 사라지고, 설정·프롬프트·backup/은 그대로다.`,
    change() {
      for (const file of existingDatabaseFiles(dataDir)) rmSync(join(dataDir, file));
      return "지웠다";
    },
  });
}

interface OfflineChange {
  confirmation: string;
  noDatabaseMessage: string;
  warning: string;
  /** 끝나고 출력할 한 줄을 돌려준다. */
  change(): string;
}

/** 서버가 쓰는 중인 DB를 바꾸지 않게 잠금을 잡고, 확인 단어를 입력받은 뒤에만 바꾼다. */
async function changeDatabaseOffline(
  dataDir: string,
  readLine: ReadLine,
  { confirmation, noDatabaseMessage, warning, change }: OfflineChange,
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
      process.stdout.write(`${noDatabaseMessage}\n`);
      return 0;
    }
    process.stdout.write(`${warning}\n계속하려면 ${confirmation}을 입력하라: `);
    if ((await readLine())?.trim() !== confirmation) {
      process.stdout.write("\n취소했다\n");
      return 1;
    }
    process.stdout.write(`${change()}\n`);
    return 0;
  } finally {
    releaseLock();
  }
}

function existingDatabaseFiles(dataDir: string): string[] {
  return DATABASE_FILES.filter((name) => existsSync(join(dataDir, name)));
}
