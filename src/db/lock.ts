import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class InstanceLockedError extends Error {}

export type ReleaseLock = () => void;

export function acquireInstanceLock(dataDir: string): ReleaseLock {
  const lockPath = join(dataDir, "aigan.lock");
  if (!tryCreateLockFile(lockPath)) {
    const holderPid = readHolderPid(lockPath);
    if (holderPid !== undefined && isProcessAlive(holderPid)) {
      throw new InstanceLockedError(`다른 aigan(pid ${holderPid})이 ${dataDir}를 쓰고 있다`);
    }
    writeFileSync(lockPath, String(process.pid));
  }
  return () => rmSync(lockPath, { force: true });
}

function tryCreateLockFile(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function readHolderPid(lockPath: string): number | undefined {
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
