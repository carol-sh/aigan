import type { DatabaseSync } from "node:sqlite";
import { FlowRepository } from "./flows.ts";
import { GoalRepository } from "./goals.ts";
import { HarnessStateRepository } from "./harness-state.ts";
import { MemoryRepository } from "./memory.ts";
import { MessageRepository } from "./messages.ts";
import { ReservationRepository } from "./reservations.ts";

export interface Repositories {
  harnessState: HarnessStateRepository;
  flows: FlowRepository;
  goals: GoalRepository;
  memory: MemoryRepository;
  messages: MessageRepository;
  reservations: ReservationRepository;
}

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    harnessState: new HarnessStateRepository(db),
    flows: new FlowRepository(db),
    goals: new GoalRepository(db),
    memory: new MemoryRepository(db),
    messages: new MessageRepository(db),
    reservations: new ReservationRepository(db),
  };
}
