import type { HarnessContext } from "./context.ts";

const ALERT_PREFIX = "[aigan 알림]";

/**
 * 운영자와 사용자는 같은 사람이라 같은 채팅으로 보낸다. outbox를 거치지 않는 것은, `messages`에 넣으면
 * 다음 턴 입력에 "나:" 줄로 나와 모델이 자기가 한 말로 읽기 때문이다. 알림이 실패해도 작업은 실패가 아니다.
 */
export async function alertOperator(ctx: HarnessContext, text: string): Promise<void> {
  ctx.logger.warn(`운영자 알림: ${text}`);
  if (ctx.harnessState.get().hold_reason === "blocked") return;
  try {
    await ctx.telegram.sendMessage(`${ALERT_PREFIX} ${text}`);
  } catch (error) {
    ctx.logger.warn("운영자 알림을 보내지 못했다", error);
  }
}
