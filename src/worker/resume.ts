import type { Flow } from "../db/repositories/flows.ts";
import { fromDbTime } from "../time.ts";
import type { HarnessContext } from "./context.ts";
import { closeFlow } from "./flow.ts";
import { sendOutbox } from "./send.ts";

export async function resumePendingWork(ctx: HarnessContext): Promise<void> {
  const staleBefore = ctx.clock.now().minus({ seconds: ctx.config.stale_after_sec });
  const dropped = ctx.messages.markOutboxOlderThanUndelivered(staleBefore);
  if (dropped > 0) ctx.logger.warn(`낡은 미전송 메시지 ${dropped}개를 보내지 않는다`);
  await sendOutbox(ctx);

  const openFlow = ctx.flows.findOpen();
  if (openFlow) recoverOpenFlow(ctx, openFlow);
}

function recoverOpenFlow(ctx: HarnessContext, flow: Flow): void {
  const now = ctx.clock.now();
  const continuation = ctx.reservations.findContinue(flow.id);
  if (!continuation) {
    ctx.reservations.scheduleContinue(
      flow.id,
      now.plus({ seconds: ctx.config.min_lead_sec }),
      "harness",
      now,
    );
    ctx.logger.warn(`이어가기 예약이 없는 흐름 ${flow.id}에 복구 예약을 넣었다`);
    return;
  }
  if (fromDbTime(continuation.at) < now.minus({ seconds: ctx.config.stale_after_sec })) {
    closeFlow(ctx, flow.id, "stale");
  }
}
