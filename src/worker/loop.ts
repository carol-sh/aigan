import { DateTime } from "luxon";
import { nextDeadline } from "../producers/deadline.ts";
import { fireDueReservations } from "../producers/timer.ts";
import type { CancelTimer } from "../ports.ts";
import type { HarnessContext } from "./context.ts";
import { pickNextTask } from "./pick-next-task.ts";
import { runTask } from "./run-task.ts";
import { sendOutbox } from "./send.ts";
import type { LlmTaskHandlers, Task } from "./tasks.ts";

export interface LoopStats {
  wakeUps: number;
  tasksRun: number;
  sleepingUntil: DateTime | undefined;
}

/** 이벤트 큐 없이, 깨어날 때마다 DB에서 다음 작업을 골라 하나씩 처리하고, 할 일이 없으면 다음 기한까지 잔다. */
export class TaskLoop {
  readonly stats: LoopStats = { wakeUps: 0, tasksRun: 0, sleepingUntil: undefined };
  readonly #ctx: HarnessContext;
  readonly #llm: LlmTaskHandlers;
  #isWorking = false;
  #isStopped = true;
  #cancelTimer: CancelTimer | undefined;
  #idleWaiters: (() => void)[] = [];

  constructor(ctx: HarnessContext, llm: LlmTaskHandlers) {
    this.#ctx = ctx;
    this.#llm = llm;
  }

  start(firstTasks: Task[] = []): void {
    this.#isStopped = false;
    void this.#workUntilIdle(firstTasks);
  }

  stop(): void {
    this.#isStopped = true;
    this.#cancelSleep();
  }

  /** 자고 있으면 깨운다. 일하는 중이면 아무것도 하지 않는다. 작업이 끝나면 어차피 다음 작업을 고른다. */
  wake(): void {
    if (this.#isWorking || this.#isStopped) return;
    this.#cancelSleep();
    void this.#workUntilIdle([]);
  }

  whenIdle(): Promise<void> {
    if (!this.#isWorking) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #workUntilIdle(firstTasks: Task[]): Promise<void> {
    this.#isWorking = true;
    this.stats.wakeUps += 1;
    try {
      for (const task of firstTasks) await this.#run(task);
      let task = this.#pickNextTask();
      while (task !== null) {
        await this.#run(task);
        task = this.#pickNextTask();
      }
    } catch (error) {
      this.#ctx.logger.error("작업이 예외로 끝났다. 다음에 깨어날 때 다시 고른다", error);
    } finally {
      this.#isWorking = false;
      if (!this.#isStopped) this.#sleepUntilNextDeadline();
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
  }

  #pickNextTask(): Task | null {
    if (this.#isStopped) return null;
    fireDueReservations(this.#ctx);
    return pickNextTask(this.#ctx);
  }

  async #run(task: Task): Promise<void> {
    this.stats.tasksRun += 1;
    await runTask(this.#ctx, this.#llm, task);
    await sendOutbox(this.#ctx);
  }

  /**
   * 한 번에 `timer_max_sleep_sec`보다 오래 자지 않는다. 런타임 타이머는 단조 시계를 따르는데
   * 기기 절전 동안 이 시계가 멈추는 플랫폼이 있어서, 깨어난 뒤에도 기한이 절전한 만큼 늦어진다.
   * 자주 깨어나 벽시계로 다시 고르면 늦어짐이 이 값 이하로 줄어든다.
   */
  #sleepUntilNextDeadline(): void {
    const now = this.#ctx.clock.now();
    const latestWakeUp = now.plus({ seconds: this.#ctx.config.timer_max_sleep_sec });
    const deadline = nextDeadline(this.#ctx);
    const wakeUpAt = deadline === undefined ? latestWakeUp : DateTime.min(deadline, latestWakeUp);
    this.stats.sleepingUntil = wakeUpAt;
    this.#cancelTimer = this.#ctx.clock.setTimer(wakeUpAt.diff(now).toMillis(), () => {
      this.#cancelTimer = undefined;
      this.wake();
    });
  }

  #cancelSleep(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.stats.sleepingUntil = undefined;
  }
}
