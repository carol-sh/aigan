import type { HarnessContext } from "../worker/context.ts";
import type { WorkingGoal } from "../worker/tools/turn-changes.ts";
import type { TurnConversation, TurnDecider, TurnRequest } from "../worker/turn.ts";
import { LlmConversation } from "./conversation.ts";
import { renderTurnInput } from "./input/turn-input.ts";
import { formatDuration } from "./input/transcript.ts";
import { turnOutputParser } from "./outputs.ts";

export class LlmTurnDecider implements TurnDecider {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  begin({ task, planDate, tools, input }: TurnRequest): TurnConversation {
    const ctx = this.#ctx;
    const conversation = new LlmConversation(ctx, {
      kind: "turn",
      flowId: "flowId" in task ? task.flowId : null,
      messages: renderTurnInput(input, ctx.prompts, ctx.config.timezone),
      tools,
      maxToolRounds: ctx.config.max_tool_rounds,
    });
    const parse = turnOutputParser(task.trigger, ctx.config.timezone);
    return {
      decide: () => conversation.ask(parse),
      reconsider: (goals) => {
        const minutesLeft = Math.floor(
          ctx.calendar.endOfDay(planDate).diff(ctx.clock.now()).as("minutes"),
        );
        return conversation.askAgain(describeGoalsWithoutNextCheck(goals, minutesLeft), parse);
      },
    };
  }
}

function describeGoalsWithoutNextCheck(goals: WorkingGoal[], minutesLeft: number): string {
  return [
    "다음 목표에 다음 확인이 없다:",
    ...goals.map((goal) => `- #${goal.id} ${goal.title}`),
    "open_reserve로 시각을 잡거나, open_update로 기존 예약에 붙이거나, goal_close하라.",
    `오늘의 끝까지 남은 시간: ${formatDuration(minutesLeft)}`,
  ].join("\n");
}
