import type { DateTime } from "luxon";
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

export function renderMemory(state: string, sectionTitles: string[]): string[] {
  return [
    state === "" ? "state: (비어 있음)" : state,
    `칸: ${sectionTitles.length > 0 ? sectionTitles.join(", ") : NONE}`,
  ];
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
    `(${reservation.source})`,
    reservation.state === "fired" && "밀림",
  ]
    .filter(Boolean)
    .join(" ");
}
