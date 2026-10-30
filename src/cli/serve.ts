import type { Api } from "grammy";
import { connectToServices } from "../adapters/connections.ts";
import { ConsoleLogger } from "../adapters/console-logger.ts";
import { SystemClock } from "../adapters/system-clock.ts";
import { TelegramPoller } from "../adapters/telegram-poller.ts";
import { createTelegramApi } from "../adapters/telegram.ts";
import { type Harness, boot } from "../worker/boot.ts";

const SHUTDOWN_GRACE_MS = 10_000;

export async function runServe(dataDir: string): Promise<number> {
  const logger = new ConsoleLogger();
  let telegramApi: Api | undefined;
  let harness: Harness;
  try {
    harness = boot({
      dataDir,
      clock: new SystemClock(),
      logger,
      connect: (config) => {
        telegramApi = createTelegramApi(config);
        return connectToServices(config, telegramApi);
      },
    });
  } catch (error) {
    process.stderr.write(
      `시작하지 못했다: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const poller = new TelegramPoller(telegramApi!, logger);
  const signal = waitForStopSignal();
  poller.start((update) => harness.receiveUpdate(update));
  harness.start();
  logger.info(`시작했다 (DATA_DIR=${dataDir})`);

  logger.info(`${await signal}를 받아 멈춘다`);
  await poller.stop();
  harness.loop.stop();
  if (await finishesWithin(harness.loop.whenIdle(), SHUTDOWN_GRACE_MS)) {
    harness.stop();
    return 0;
  }
  // 시도는 io 전에 기록돼 있어 크래시와 같다. 잠금 파일이 남지만 pid가 죽었으므로 다음 시작이 가져간다.
  logger.warn(`진행 중인 작업이 ${SHUTDOWN_GRACE_MS / 1000}초 안에 끝나지 않아 그대로 끝낸다`);
  setImmediate(() => process.exit(0));
  return 0;
}

function waitForStopSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function finishesWithin(work: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const finished = await Promise.race([work.then(() => true), timeout]);
  clearTimeout(timer);
  return finished;
}
