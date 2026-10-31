import type { DateTime } from "luxon";
import type { MemoryRepository } from "../../db/repositories/memory.ts";
import type { Message } from "../../db/repositories/messages.ts";
import type { Reservation } from "../../db/repositories/reservations.ts";
import { fromDbTime } from "../../time.ts";
import { formatLocalTime } from "../../worker/reservation-times.ts";

export const NONE = "(없음)";

/** 시각을 그릴 기준. 지금과 로컬 날짜가 같은 시각은 날짜를 생략한다. */
export interface TimeView {
  now: DateTime;
  timezone: string;
}

/** 절은 비어도 빼지 않는다. 자리가 늘 같아야 모델이 "없음"과 "안 보여 줌"을 구분하고, prefix 캐시도 산다. */
export function renderSection(title: string, lines: string[]): string {
  return [`## ${title}`, ...(lines.length > 0 ? lines : [NONE])].join("\n");
}

export function renderMessages(messages: Message[], view: TimeView): string[] {
  return messages.map((message) => renderMessage(message, view));
}

/** 압축된 흐름은 요약과 압축하지 않은 구간 원문으로 보인다. 압축한 적 없으면 원문 전체다. */
export interface ConversationView {
  summary: string | undefined;
  messages: Message[];
}

export function renderConversation(conversation: ConversationView, view: TimeView): string[] {
  const summary =
    conversation.summary === undefined
      ? []
      : [indentFollowingLines(`[요약] ${conversation.summary}`)];
  return [...summary, ...renderMessages(conversation.messages, view)];
}

function renderMessage(message: Message, view: TimeView): string {
  const speaker = message.role === "user" ? "사용자" : "나";
  const ignoredMark = message.triage === "ignored" ? " (무시됨)" : "";
  const time = formatShortTime(fromDbTime(message.ts), view);
  return indentFollowingLines(`[${time}] ${speaker}: ${message.content}`).concat(ignoredMark);
}

function indentFollowingLines(text: string): string {
  const [firstLine, ...restLines] = text.split("\n");
  return [firstLine, ...restLines.map((line) => `    ${line}`)].join("\n");
}

export function formatShortTime(time: DateTime, { now, timezone }: TimeView): string {
  const local = time.setZone(timezone);
  const isToday = local.hasSame(now.setZone(timezone), "day");
  return local.toFormat(isToday ? "HH:mm" : "MM-dd HH:mm");
}

/** 기억 절에 보일 것. 칸은 모두 제목이 보이고, `content`가 있는 칸만 본문까지 보인다. */
export interface MemoryView {
  state: string;
  sections: { title: string; content: string | undefined }[];
}

/**
 * 비추론 모델은 `memory_read`를 자주 건너뛴다. 그래서 본문이 꼭 필요한 호출(정리·계획, 턴은 설정한 칸)은
 * 본문을 입력에 넣는다.
 */
export function viewMemory(
  memory: MemoryRepository,
  showsBody: (title: string) => boolean,
): MemoryView {
  return {
    state: memory.readState(),
    sections: memory.listSections().map(({ title, content }) => ({
      title,
      content: showsBody(title) ? content : undefined,
    })),
  };
}

export function renderMemory({ state, sections }: MemoryView): string[] {
  const titles = sections.map((section) => section.title);
  return [
    state === "" ? "state: (비어 있음)" : state,
    `칸: ${titles.length > 0 ? titles.join(", ") : NONE}`,
    ...sections.flatMap(({ title, content }) =>
      content === undefined ? [] : [`[칸 ${title}]`, ...indentLines(content)],
    ),
  ];
}

/** 본문의 `##` 제목이 입력 문서의 절로 읽히지 않게 들여쓴다. */
export function indentLines(text: string): string[] {
  return text.split("\n").map((line) => (line === "" ? line : `  ${line}`));
}

/** `N분`, `H시간`, `H시간 M분`. 늦은 정도와 되묻기의 남은 시간이 쓴다. */
export function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}분`;
  return minutes === 0 ? `${hours}시간` : `${hours}시간 ${minutes}분`;
}

export interface OpeningView {
  reservation: Reservation;
  goalIds: number[];
}

export function renderOpening({ reservation, goalIds }: OpeningView, timezone: string): string {
  return [
    `- #${reservation.id}`,
    formatLocalTime(fromDbTime(reservation.at), timezone),
    reservation.intent,
    goalIds.length > 0 && `[목표 ${goalIds.join(", ")}]`,
    reservation.job_id && `[방침 ${reservation.job_id}]`,
    `(${reservation.source})`,
    reservation.state === "fired" && "밀림",
  ]
    .filter(Boolean)
    .join(" ");
}
