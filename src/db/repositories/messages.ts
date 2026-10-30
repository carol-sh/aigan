import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { fromDbTime, toDbTime } from "../../time.ts";
import type { Flow } from "./flows.ts";

export interface Message {
  id: number;
  flow_id: number | null;
  role: "user" | "assistant";
  content: string;
  ts: string;
  triage: "pending" | "ignored" | "accepted" | null;
  void_reason: "undelivered" | "busy" | "trimmed" | null;
  sent_at: string | null;
  tg_update_id: number | null;
  tg_message_id: number | null;
}

export interface IncomingUserMessage {
  flowId: number | null;
  content: string;
  receivedAt: DateTime;
  telegramUpdateId: number;
  telegramMessageId: number;
}

const UNANSWERED_IN_FLOW = `flow_id = :flowId AND role = 'user' AND void_reason IS NULL AND id > :answeredUptoId`;
const PENDING_OUTSIDE_FLOW = `flow_id IS NULL AND triage = 'pending' AND void_reason IS NULL`;
const OUTBOX = `role = 'assistant' AND sent_at IS NULL AND void_reason IS NULL`;

export class MessageRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  hasTelegramUpdate(updateId: number): boolean {
    return (
      this.#db.prepare("SELECT 1 FROM messages WHERE tg_update_id = ?").get(updateId) !== undefined
    );
  }

  recordUserMessage(message: IncomingUserMessage): number {
    const result = this.#db
      .prepare(
        `INSERT INTO messages (flow_id, role, content, ts, triage, tg_update_id, tg_message_id)
         VALUES (?, 'user', ?, ?, ?, ?, ?)`,
      )
      .run(
        message.flowId,
        message.content,
        toDbTime(message.receivedAt),
        message.flowId === null ? "pending" : null,
        message.telegramUpdateId,
        message.telegramMessageId,
      );
    return Number(result.lastInsertRowid);
  }

  queueAssistantMessage(flowId: number, content: string, createdAt: DateTime): number {
    const result = this.#db
      .prepare("INSERT INTO messages (flow_id, role, content, ts) VALUES (?, 'assistant', ?, ?)")
      .run(flowId, content, toDbTime(createdAt));
    return Number(result.lastInsertRowid);
  }

  /** 입력에 보여 줄 흐름 대화. 지운 것(`busy`, `trimmed`, `undelivered`)은 뺀다. */
  findShownInFlow(flowId: number): Message[] {
    return this.#db
      .prepare("SELECT * FROM messages WHERE flow_id = ? AND void_reason IS NULL ORDER BY id")
      .all(flowId) as unknown as Message[];
  }

  findLastShownInFlow(flowId: number, limit: number): Message[] {
    const latestFirst = this.#db
      .prepare(
        "SELECT * FROM messages WHERE flow_id = ? AND void_reason IS NULL ORDER BY id DESC LIMIT ?",
      )
      .all(flowId, limit) as unknown as Message[];
    return latestFirst.reverse();
  }

  findShownOutsideFlow(): Message[] {
    return this.#db
      .prepare("SELECT * FROM messages WHERE flow_id IS NULL AND void_reason IS NULL ORDER BY id")
      .all() as unknown as Message[];
  }

  latestUnansweredAt(flow: Flow): DateTime | undefined {
    const row = this.#db
      .prepare(`SELECT MAX(ts) AS ts FROM messages WHERE ${UNANSWERED_IN_FLOW}`)
      .get({ flowId: flow.id, answeredUptoId: flow.answered_upto_id }) as { ts: string | null };
    return row.ts === null ? undefined : fromDbTime(row.ts);
  }

  moveUnansweredOutOfFlow(flow: Flow): number {
    const result = this.#db
      .prepare(`UPDATE messages SET flow_id = NULL, triage = 'pending' WHERE ${UNANSWERED_IN_FLOW}`)
      .run({ flowId: flow.id, answeredUptoId: flow.answered_upto_id });
    return Number(result.changes);
  }

  latestPendingAt(): DateTime | undefined {
    const row = this.#db
      .prepare(`SELECT MAX(ts) AS ts FROM messages WHERE ${PENDING_OUTSIDE_FLOW}`)
      .get() as {
      ts: string | null;
    };
    return row.ts === null ? undefined : fromDbTime(row.ts);
  }

  /**
   * 흐름을 여는 커밋은 흐름 밖 메시지를 모두 그 흐름으로 옮긴다. 판정 대기였던 것은 받은 것이 된다.
   * 최근 `keepLatest`개 밖의 것은 입력에서 빠지도록 `trimmed`로 표시한다.
   */
  moveOutsideMessagesIntoFlow(flowId: number, keepLatest: number): void {
    this.#db
      .prepare(
        `UPDATE messages SET void_reason = 'trimmed'
         WHERE flow_id IS NULL AND role = 'user' AND void_reason IS NULL
           AND id NOT IN (
             SELECT id FROM messages WHERE flow_id IS NULL AND role = 'user' AND void_reason IS NULL
             ORDER BY id DESC LIMIT ?)`,
      )
      .run(keepLatest);
    this.#db
      .prepare(
        `UPDATE messages SET flow_id = ?, triage = CASE triage WHEN 'pending' THEN 'accepted' ELSE triage END
         WHERE flow_id IS NULL AND role = 'user'`,
      )
      .run(flowId);
  }

  markPendingIgnoredUpTo(lastSeenId: number): void {
    this.#db
      .prepare(`UPDATE messages SET triage = 'ignored' WHERE ${PENDING_OUTSIDE_FLOW} AND id <= ?`)
      .run(lastSeenId);
  }

  hasUserMessageSince(since: DateTime): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM messages WHERE role = 'user' AND ts > ?")
        .get(toDbTime(since)) !== undefined
    );
  }

  findOutbox(): Message[] {
    return this.#db
      .prepare(`SELECT * FROM messages WHERE ${OUTBOX} ORDER BY id`)
      .all() as unknown as Message[];
  }

  markSent(messageId: number, sentAt: DateTime): void {
    this.#db
      .prepare("UPDATE messages SET sent_at = ? WHERE id = ?")
      .run(toDbTime(sentAt), messageId);
  }

  markUndelivered(messageId: number): void {
    this.#db.prepare("UPDATE messages SET void_reason = 'undelivered' WHERE id = ?").run(messageId);
  }

  markAllOutboxUndelivered(): number {
    const result = this.#db
      .prepare(`UPDATE messages SET void_reason = 'undelivered' WHERE ${OUTBOX}`)
      .run();
    return Number(result.changes);
  }

  markOutboxOlderThanUndelivered(cutoff: DateTime): number {
    const result = this.#db
      .prepare(`UPDATE messages SET void_reason = 'undelivered' WHERE ${OUTBOX} AND ts < ?`)
      .run(toDbTime(cutoff));
    return Number(result.changes);
  }
}
