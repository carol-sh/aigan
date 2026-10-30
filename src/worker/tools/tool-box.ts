import { z } from "zod";

export type ToolResult = { ok: true; [field: string]: unknown } | { ok: false; reason: string };

export interface Tool<Args> {
  description: string;
  args: z.ZodType<Args>;
  run(args: Args): ToolResult;
}

export function defineTool<Args>(tool: Tool<Args>): Tool<unknown> {
  return tool as Tool<unknown>;
}

export function rejected(reason: string): ToolResult {
  return { ok: false, reason };
}

/** 도구 이름 → 도구 표. 표에 없는 이름은 이 호출에 주지 않은 도구라 거부한다. */
export class ToolBox {
  readonly #tools: Record<string, Tool<unknown>>;

  constructor(tools: Record<string, Tool<unknown>>) {
    this.#tools = tools;
  }

  get names(): string[] {
    return Object.keys(this.#tools);
  }

  use(name: string, rawArgs: unknown): ToolResult {
    const tool = this.#tools[name];
    if (tool === undefined) {
      return rejected(`${name}은 쓸 수 없는 도구다. 쓸 수 있는 도구: ${this.names.join(", ")}`);
    }
    const parsed = tool.args.safeParse(rawArgs);
    if (!parsed.success) return rejected(`인자가 잘못됐다\n${z.prettifyError(parsed.error)}`);
    return tool.run(parsed.data);
  }
}
