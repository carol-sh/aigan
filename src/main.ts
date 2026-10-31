// 진입점. serve / reset / wipe / memory (docs/harness-design.md §9.10)
import { createInterface } from "node:readline";
import { runMemory } from "./cli/memory.ts";
import { runReset, runWipe } from "./cli/reset.ts";
import { runServe } from "./cli/serve.ts";

const USAGE = "사용법: DATA_DIR=<데이터 폴더> aigan <serve|reset|wipe|memory>\n";

async function main(args: string[]): Promise<number> {
  const [command] = args;
  if (command !== "serve" && command !== "reset" && command !== "wipe" && command !== "memory") {
    process.stderr.write(USAGE);
    return 2;
  }
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) {
    process.stderr.write(`DATA_DIR이 필요하다\n${USAGE}`);
    return 1;
  }
  switch (command) {
    case "serve":
      return runServe(dataDir);
    case "reset":
      return runReset(dataDir, readLineFromStdin);
    case "wipe":
      return runWipe(dataDir, readLineFromStdin);
    case "memory":
      return runMemory(dataDir);
  }
}

async function readLineFromStdin(): Promise<string | undefined> {
  const lines = createInterface({ input: process.stdin });
  try {
    for await (const line of lines) return line;
    return undefined;
  } finally {
    lines.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
