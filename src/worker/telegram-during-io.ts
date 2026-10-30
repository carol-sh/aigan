import type { CancelTimer } from "../ports.ts";
import type { HarnessContext } from "./context.ts";

const TYPING_REPEAT_MS = 4000;

/**
 * 일하는 동안 "입력 중"을 띄운다. 텔레그램 표시는 5초쯤 뒤 꺼지고 끄는 API가 없어서,
 * 몇 초마다 다시 보내다가 일이 끝나면 멈추는 것이 해제다.
 */
export async function keepTypingDuring<T>(ctx: HarnessContext, work: () => Promise<T>): Promise<T> {
  let cancelNextTyping: CancelTimer | undefined;
  const showTyping = () => {
    ctx.telegram
      .showTyping()
      .catch((error: unknown) => ctx.logger.warn("입력 중 표시를 보내지 못했다", error));
    cancelNextTyping = ctx.clock.setTimer(TYPING_REPEAT_MS, showTyping);
  };
  showTyping();
  try {
    return await work();
  } finally {
    cancelNextTyping?.();
  }
}

/**
 * 말하는 턴의 io 중에 온 사용자 메시지를 텔레그램에서 지우고, 지운 것의 id를 돌려준다.
 * 대상은 지금 한 번 정한다. 지우는 동안 새로 온 메시지와 지우지 못한 메시지는 평소 메시지로 남는다.
 * 텔레그램 호출은 tx 안에 둘 수 없어 커밋 전에 하고, `busy` 표시는 커밋이 한다.
 */
export async function deleteMessagesArrivedDuringIo(
  ctx: HarnessContext,
  lastMessageIdBeforeIo: number,
): Promise<number[]> {
  const deletedIds: number[] = [];
  for (const message of ctx.messages.findUserMessagesAfter(lastMessageIdBeforeIo)) {
    try {
      await ctx.telegram.deleteMessage(message.tg_message_id!);
      deletedIds.push(message.id);
    } catch (error) {
      ctx.logger.warn(`io 중에 온 메시지 ${message.id}를 지우지 못했다`, error);
    }
  }
  return deletedIds;
}
