import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { toDbTime } from "../../time.ts";

export type LlmCallKind = "turn" | "plan" | "cleanup" | "compact";

export interface LlmCallRecord {
  kind: LlmCallKind;
  flowId: number | null;
  request: unknown;
  response: unknown;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  /** `api: ...`면 요청 자체가 실패, `parse: ...`면 답을 받았지만 읽을 수 없었다. */
  error: string | null;
  createdAt: DateTime;
}

export class LlmCallRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  record(call: LlmCallRecord): void {
    this.#db
      .prepare(
        `INSERT INTO llm_calls (kind, flow_id, request, response, input_tokens, cached_tokens,
           output_tokens, latency_ms, success, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.kind,
        call.flowId,
        JSON.stringify(call.request),
        call.response === undefined ? null : JSON.stringify(call.response),
        call.inputTokens,
        call.cachedTokens,
        call.outputTokens,
        call.latencyMs,
        call.error === null ? 1 : 0,
        call.error,
        toDbTime(call.createdAt),
      );
  }
}
