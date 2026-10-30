import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Duration, type DurationLike } from "luxon";
import type { Update } from "grammy/types";
import { type Harness, boot } from "../src/worker/boot.ts";
import { type ConfigOverrides, testConfigText } from "./fakes/config.ts";
import { FakeBalance } from "./fakes/balance.ts";
import { FakeClock, flushAsyncWork } from "./fakes/clock.ts";
import { ScriptedLlm, parseLocalTime } from "./fakes/scripted-llm.ts";
import { MemoryLogger } from "./fakes/logger.ts";
import { FakeTelegram } from "./fakes/telegram.ts";

const TIMEZONE = "Asia/Seoul";

export interface StartOptions {
  /** 로컬 시각 `yyyy-MM-dd HH:mm`. 기본은 평범한 금요일 오전. */
  at?: string;
  config?: ConfigOverrides;
  llm?: ScriptedLlm;
  /** 기본은 정리 규칙이 있어 흐름이 닫히면 정리가 돈다. false면 정리를 건너뛴다. */
  cleanupRules?: boolean;
  /** 기본은 압축 규칙이 없어 압축하지 않는다. true면 흐름이 길어질 때 압축이 돈다. */
  compactRules?: boolean;
  preparePrompts?: (promptsDir: string) => void;
}

/** 임시 DATA_DIR로 실제 부팅을 하고 루프를 돌린다. 바깥 경계(시계·텔레그램·LLM 클라이언트·잔액)만 가짜다. */
export async function startApp(t: TestContext, options: StartOptions = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "aigan-"));
  writeFileSync(join(dataDir, "config"), testConfigText({ timezone: TIMEZONE, ...options.config }));
  cpSync("examples/prompts", join(dataDir, "prompts"), { recursive: true });
  if (options.cleanupRules !== false) {
    writeFileSync(join(dataDir, "prompts", "cleanup-rules.md"), "기억에 남길 것을 정리한다.");
  }
  if (options.compactRules === true) {
    writeFileSync(join(dataDir, "prompts", "compact-rules.md"), "긴 대화를 요약한다.");
  }
  options.preparePrompts?.(join(dataDir, "prompts"));

  const clock = new FakeClock(parseLocalTime(options.at ?? "2026-10-30 10:00", TIMEZONE));
  const app = new TestApp(dataDir, clock, options.llm ?? new ScriptedLlm());
  t.after(() => app.shutDown());
  await app.bootAndStart();
  return app;
}

export class TestApp {
  readonly dataDir: string;
  readonly clock: FakeClock;
  readonly llm: ScriptedLlm;
  readonly telegram = new FakeTelegram();
  readonly balance = new FakeBalance();
  readonly logger = new MemoryLogger();
  #harness: Harness | undefined;

  constructor(dataDir: string, clock: FakeClock, llm: ScriptedLlm) {
    this.dataDir = dataDir;
    this.clock = clock;
    this.llm = llm;
  }

  get harness(): Harness {
    if (!this.#harness) throw new Error("앱이 떠 있지 않다");
    return this.#harness;
  }

  async bootAndStart(): Promise<void> {
    this.#harness = boot({
      dataDir: this.dataDir,
      clock: this.clock,
      telegram: this.telegram,
      logger: this.logger,
      chat: this.llm,
      balance: this.balance,
    });
    this.llm.attach(this.#harness.ctx);
    this.#harness.start();
    await flushAsyncWork();
  }

  async user(text: string): Promise<void> {
    await this.receive(this.telegram.textUpdate(text));
  }

  async receive(update: Update): Promise<void> {
    this.harness.receiveUpdate(update);
    await flushAsyncWork();
  }

  async advance(duration: DurationLike): Promise<void> {
    await this.clock.advance(Duration.fromDurationLike(duration).toMillis());
  }

  async advanceTo(localTime: string): Promise<void> {
    const target = this.at(localTime);
    const now = this.clock.now();
    if (target < now) throw new Error(`${localTime}은 이미 지났다`);
    await this.clock.advance(target.diff(now).toMillis());
  }

  /** 기기 절전. 벽시계만 흐르고 타이머는 멈춰 있다. */
  suspend(duration: DurationLike): void {
    this.clock.suspend(Duration.fromDurationLike(duration).toMillis());
  }

  async restart(options: { downFor?: DurationLike } = {}): Promise<void> {
    this.#stopHarness();
    this.clock.passWhileDown(Duration.fromDurationLike(options.downFor ?? 0).toMillis());
    await this.bootAndStart();
  }

  at(localTime: string) {
    return parseLocalTime(localTime, TIMEZONE, this.clock.now());
  }

  /** LLM 작업 기록을 `MM-dd HH:mm 종류[:트리거][#개시 예약 id][:reconsider]`로. */
  get llmTasks(): string[] {
    return this.llm.log.map(({ task, startedAt, isReconsider }) => {
      const label =
        task.kind !== "turn"
          ? task.kind
          : task.trigger === "open"
            ? `turn:open#${task.reservationId}`
            : `turn:${task.trigger}`;
      const time = startedAt.setZone(TIMEZONE).toFormat("MM-dd HH:mm");
      return `${time} ${label}${isReconsider ? ":reconsider" : ""}`;
    });
  }

  rows<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.harness.ctx.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }) as T);
  }

  row<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T {
    const [first] = this.rows<T>(sql, ...params);
    if (first === undefined) throw new Error(`결과가 없다: ${sql}`);
    return first;
  }

  /** 실제 경로로 만들기 번거로운 상태(턴 백오프 등)를 심는다. */
  plant(sql: string, ...params: (string | number | null)[]): void {
    this.harness.ctx.db.prepare(sql).run(...params);
  }

  shutDown(): void {
    this.#stopHarness();
    rmSync(this.dataDir, { recursive: true, force: true });
    if (this.logger.errors.length > 0) {
      throw new Error(`앱이 오류를 남겼다: ${this.logger.errors.map(String).join("; ")}`);
    }
    if (this.llm.problems.length > 0) {
      throw new Error(`각본 모델에 문제가 있었다: ${this.llm.problems.join("; ")}`);
    }
  }

  #stopHarness(): void {
    this.#harness?.stop();
    this.#harness = undefined;
  }
}
