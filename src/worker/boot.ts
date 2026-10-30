import { join } from "node:path";
import type { Update } from "grammy/types";
import { loadConfig } from "../config.ts";
import { acquireInstanceLock } from "../db/lock.ts";
import { openDatabase } from "../db/open.ts";
import { createRepositories } from "../db/repositories/index.ts";
import { LlmCleanupDecider } from "../llm/cleanup-decider.ts";
import { LlmCompactDecider } from "../llm/compact-decider.ts";
import { LlmPlanDecider } from "../llm/plan-decider.ts";
import { LlmTurnDecider } from "../llm/turn-decider.ts";
import type { BalanceSource, ChatClient, Clock, Logger, Telegram } from "../ports.ts";
import { recordIncomingMessage } from "../producers/poller.ts";
import { loadPrompts } from "../prompts.ts";
import { PlanCalendar } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { TaskLoop } from "./loop.ts";
import { runCleanup } from "./cleanup.ts";
import { runPlan } from "./plan.ts";
import { runTurn } from "./turn.ts";

export interface BootOptions {
  dataDir: string;
  clock: Clock;
  telegram: Telegram;
  logger: Logger;
  chat: ChatClient;
  balance: BalanceSource;
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
    chat: options.chat,
    balance: options.balance,
    telegram: options.telegram,
    logger: options.logger,
  };
  const turnDeciders = { turn: new LlmTurnDecider(ctx), compact: new LlmCompactDecider(ctx) };
  const cleanupDecider = new LlmCleanupDecider(ctx);
  const planDecider = new LlmPlanDecider(ctx);
  const loop = new TaskLoop(ctx, {
    turn: (task) => runTurn(ctx, turnDeciders, task),
    cleanup: (task) => runCleanup(ctx, cleanupDecider, task),
    plan: (task) => runPlan(ctx, planDecider, task),
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
