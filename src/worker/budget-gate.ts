import type { HarnessState } from "../db/repositories/harness-state.ts";
import type { HarnessContext } from "./context.ts";
import { enterHold } from "./hold.ts";

/**
 * LLM 작업이 상태를 바꾸기 전에 예산을 본다. 모자라면 보류에 들어가고, 작업은 아무것도 바꾸지 않고 끝나야
 * 한다. 그래야 예약은 지웠는데 턴은 못 돈 것 같은 반쯤 바뀐 상태가 남지 않는다. 작업 시작에 한 번만 보므로
 * 그 작업의 도구 라운드·재시도·되묻기가 상한을 넘는 것은 허용한다.
 */
export async function holdIfOutOfBudget(ctx: HarnessContext): Promise<boolean> {
  const state = ctx.harnessState.get();
  if (countTodaysLlmRequests(ctx, state) >= ctx.config.daily_call_limit) {
    await enterHold(ctx, { reason: "daily_limit" });
    return true;
  }
  return false;
}

/** 날짜가 바뀌었으면 0으로 본다. 0으로 쓰는 것은 요청 직전의 집계가 한다. */
function countTodaysLlmRequests(ctx: HarnessContext, state: HarnessState): number {
  const today = ctx.calendar.localDate(ctx.clock.now());
  return state.daily_calls_date === today ? state.daily_calls : 0;
}
