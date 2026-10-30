import type { TurnScript } from "./scripted-llm.ts";

/** 사용자가 연 흐름에서 목표 둘을 만들고, 그 목표를 확인할 개시 예약을 잡은 뒤 흐름을 닫는다. */
export function createTwoGoalsCheckedAt(checkAt: string): TurnScript {
  return async (turn) => {
    const goalIds = [
      await turn.createGoal({ title: "물 2리터" }),
      await turn.createGoal({ title: "책 30쪽" }),
    ];
    await turn.reserveOpening({ at: checkAt, intent: "진행 확인", goalIds });
    return turn.end(["오늘 할 일 둘이야", "이따 확인할게"]);
  };
}
