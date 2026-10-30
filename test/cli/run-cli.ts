import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { type ConfigOverrides, testConfigText } from "../fakes/config.ts";

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 설정과 테스트용 프롬프트를 넣은 임시 DATA_DIR. 테스트가 끝나면 지운다. */
export function makeDataDir(t: TestContext, config: ConfigOverrides = {}): string {
  const dataDir = mkdtempSync(join(tmpdir(), "aigan-cli-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeFileSync(join(dataDir, "config"), testConfigText(config));
  cpSync("test/fixtures/prompts", join(dataDir, "prompts"), { recursive: true });
  return dataDir;
}

/** `main.ts`를 자식 프로세스로 띄운다. 끝나기를 기다리지 않는다. */
export class CliProcess {
  stdout = "";
  stderr = "";
  readonly exited: Promise<CliResult>;
  readonly #child: ChildProcess;

  constructor(args: string[], dataDir: string | undefined) {
    const env = { ...process.env };
    if (dataDir === undefined) delete env.DATA_DIR;
    else env.DATA_DIR = dataDir;
    this.#child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "src/main.ts", ...args],
      { env },
    );
    this.#child.stdout!.on("data", (chunk: Buffer) => (this.stdout += chunk.toString("utf8")));
    this.#child.stderr!.on("data", (chunk: Buffer) => (this.stderr += chunk.toString("utf8")));
    this.exited = new Promise((resolve) => {
      this.#child.on("close", (code) =>
        resolve({ code, stdout: this.stdout, stderr: this.stderr }),
      );
    });
  }

  write(input: string): void {
    this.#child.stdin!.end(input);
  }

  signal(name: NodeJS.Signals): void {
    this.#child.kill(name);
  }
}

export async function runCli(
  args: string[],
  options: { dataDir?: string; input?: string } = {},
): Promise<CliResult> {
  const cli = new CliProcess(args, options.dataDir);
  cli.write(options.input ?? "");
  return cli.exited;
}

export async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("기다리던 일이 일어나지 않았다");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
