import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.ts";
import type { Repositories } from "../db/repositories/index.ts";
import type { Clock, Logger, Telegram } from "../ports.ts";
import type { Prompts } from "../prompts.ts";
import type { PlanCalendar } from "../time.ts";

export interface HarnessContext extends Repositories {
  db: DatabaseSync;
  config: Config;
  prompts: Prompts;
  calendar: PlanCalendar;
  clock: Clock;
  telegram: Telegram;
  logger: Logger;
}
