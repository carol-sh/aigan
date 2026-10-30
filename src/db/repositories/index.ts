import type { DatabaseSync } from "node:sqlite";
import { FlowRepository } from "./flows.ts";
import { GoalRepository } from "./goals.ts";
import { HarnessStateRepository } from "./harness-state.ts";
import { LlmCallRepository } from "./llm-calls.ts";
import { MemoryRepository } from "./memory.ts";
import { MessageRepository } from "./messages.ts";
import { PlanRepository } from "./plans.ts";
import { ReservationRepository } from "./reservations.ts";

export interface Repositories {
  harnessState: HarnessStateRepository;
  flows: FlowRepository;
  goals: GoalRepository;
  llmCalls: LlmCallRepository;
  memory: MemoryRepository;
  messages: MessageRepository;
  plans: PlanRepository;
  reservations: ReservationRepository;
}

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    harnessState: new HarnessStateRepository(db),
    flows: new FlowRepository(db),
    goals: new GoalRepository(db),
    llmCalls: new LlmCallRepository(db),
    memory: new MemoryRepository(db),
    messages: new MessageRepository(db),
    plans: new PlanRepository(db),
    reservations: new ReservationRepository(db),
  };
}
