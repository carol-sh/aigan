import { join } from "node:path";
import type { Update } from "grammy/types";
import { loadConfig } from "../config.ts";
import { acquireInstanceLock } from "../db/lock.ts";
import { openDatabase } from "../db/open.ts";
import { createRepositories } from "../db/repositories/index.ts";
import { LlmCleanupDecider } from "../llm/cleanup-decider.ts";
import { LlmTurnDecider } from "../llm/turn-decider.ts";
import type { ChatClient, Clock, Logger, Telegram } from "../ports.ts";
import { recordIncomingMessage } from "../producers/poller.ts";
import { loadPrompts } from "../prompts.ts";
import { PlanCalendar } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { holdIfOutOfBudget } from "./budget-gate.ts";
import { TaskLoop } from "./loop.ts";
import { runCleanup } from "./cleanup.ts";
import type { PlanTask } from "./tasks.ts";
import { runTurn } from "./turn.ts";

export interface BootOptions {
  dataDir: string;
  clock: Clock;
  telegram: Telegram;
  logger: Logger;
  chat: ChatClient;
  /** 계획은 아직 LLM 실행기로 옮기지 않아 작업 통째로 받는다. */
  runPlan(ctx: HarnessContext, task: PlanTask): Promise<void>;
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
    telegram: options.telegram,
    logger: options.logger,
  };
  const turnDecider = new LlmTurnDecider(ctx);
  const cleanupDecider = new LlmCleanupDecider(ctx);
  const loop = new TaskLoop(ctx, {
    turn: (task) => runTurn(ctx, turnDecider, task),
    cleanup: (task) => runCleanup(ctx, cleanupDecider, task),
    // 계획 단계에서 게이트를 runPlan 안으로 옮긴다.
    plan: async (task) => {
      if (await holdIfOutOfBudget(ctx)) return;
      await options.runPlan(ctx, task);
    },
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
