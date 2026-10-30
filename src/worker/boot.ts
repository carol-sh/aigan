import { join } from "node:path";
import type { Update } from "grammy/types";
import { loadConfig } from "../config.ts";
import { acquireInstanceLock } from "../db/lock.ts";
import { openDatabase } from "../db/open.ts";
import { createRepositories } from "../db/repositories/index.ts";
import type { Clock, Logger, Telegram } from "../ports.ts";
import { recordIncomingMessage } from "../producers/poller.ts";
import { loadPrompts } from "../prompts.ts";
import { PlanCalendar } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { TaskLoop } from "./loop.ts";
import { type CleanupDecider, runCleanup } from "./cleanup.ts";
import type { PlanTask } from "./tasks.ts";
import { type TurnDecider, runTurn } from "./turn.ts";

export interface BootOptions {
  dataDir: string;
  clock: Clock;
  telegram: Telegram;
  logger: Logger;
  createDeciders(ctx: HarnessContext): Deciders;
}

/** LLM이 들어갈 자리. 계획은 아직 결정자로 나누지 않아 작업 통째로 받는다. */
export interface Deciders {
  turn: TurnDecider;
  cleanup: CleanupDecider;
  plan(task: PlanTask): Promise<void>;
}

export interface Harness {
  ctx: HarnessContext;
  loop: TaskLoop;
  receiveUpdate(update: Update): void;
  start(): void;
  stop(): void;
}

export function boot(options: BootOptions): Harness {
  const config = loadConfig(join(options.dataDir, "config"));
  const prompts = loadPrompts(join(options.dataDir, "prompts"));
  const releaseLock = acquireInstanceLock(options.dataDir);
  let db;
  try {
    db = openDatabase(join(options.dataDir, "aigan.db"));
  } catch (error) {
    releaseLock();
    throw error;
  }

  const ctx: HarnessContext = {
    ...createRepositories(db),
    db,
    config,
    prompts,
    calendar: PlanCalendar.fromConfig(config),
    clock: options.clock,
    telegram: options.telegram,
    logger: options.logger,
  };
  const deciders = options.createDeciders(ctx);
  const loop = new TaskLoop(ctx, {
    turn: (task) => runTurn(ctx, deciders.turn, task),
    cleanup: (task) => runCleanup(ctx, deciders.cleanup, task),
    plan: (task) => deciders.plan(task),
  });

  return {
    ctx,
    loop,
    receiveUpdate(update) {
      if (recordIncomingMessage(ctx, update)) loop.wake();
    },
    start() {
      const isHolding = ctx.harnessState.get().hold_reason !== null;
      loop.start(isHolding ? [] : [{ kind: "resumePendingWork" }]);
    },
    stop() {
      loop.stop();
      db.close();
      releaseLock();
    },
  };
}
