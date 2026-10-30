import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DateTime } from "luxon";
import { PlanCalendar, failureBackoffDelaySec } from "../../src/time.ts";
import { testConfig } from "../fakes/config.ts";

function calendarWithBlackout(blackout: string, timezone = "Asia/Seoul"): PlanCalendar {
  return PlanCalendar.fromConfig(testConfig({ blackout, timezone }));
}

function seoul(local: string): DateTime {
  return DateTime.fromISO(local, { zone: "Asia/Seoul" });
}

function iso(time: DateTime, zone = "Asia/Seoul"): string {
  return time.setZone(zone).toFormat("yyyy-MM-dd HH:mm");
}

describe("블랙아웃 00:00-08:00", () => {
  const calendar = calendarWithBlackout("00:00-08:00");

  test("D일 00:00 진입의 계획일은 D다", () => {
    assert.equal(calendar.currentPlanDate(seoul("2026-10-30T00:00")), "2026-10-30");
    assert.equal(calendar.currentPlanDate(seoul("2026-10-29T23:59")), "2026-10-29");
  });

  test("블랙아웃은 [00:00, 08:00)이다", () => {
    assert.equal(calendar.isInBlackout(seoul("2026-10-30T00:00")), true);
    assert.equal(calendar.isInBlackout(seoul("2026-10-30T07:59")), true);
    assert.equal(calendar.isInBlackout(seoul("2026-10-30T08:00")), false);
    assert.equal(calendar.isInBlackout(seoul("2026-10-29T23:59")), false);
  });

  test("깨어 있는 구간은 08:00부터 다음 날 00:00까지다", () => {
    assert.equal(iso(calendar.blackoutEndOf("2026-10-30")), "2026-10-30 08:00");
    assert.equal(iso(calendar.endOfDay("2026-10-30")), "2026-10-31 00:00");
  });

  test("다음 블랙아웃 시작은 언제나 지금보다 뒤다", () => {
    assert.equal(iso(calendar.nextBlackoutStart(seoul("2026-10-30T00:00"))), "2026-10-31 00:00");
    assert.equal(iso(calendar.nextBlackoutStart(seoul("2026-10-30T15:00"))), "2026-10-31 00:00");
  });
});

describe("블랙아웃 23:00-07:00 (자정 넘김)", () => {
  const calendar = calendarWithBlackout("23:00-07:00");

  test("D일 23:00 진입의 계획일은 D+1이고, D+1일 01:00·15:00도 D+1이다", () => {
    assert.equal(calendar.currentPlanDate(seoul("2026-10-30T23:00")), "2026-10-31");
    assert.equal(calendar.currentPlanDate(seoul("2026-10-31T01:00")), "2026-10-31");
    assert.equal(calendar.currentPlanDate(seoul("2026-10-31T15:00")), "2026-10-31");
    assert.equal(calendar.currentPlanDate(seoul("2026-10-30T22:59")), "2026-10-30");
  });

  test("D+1일 23:00 진입에서 계획일이 D+2로 넘어간다", () => {
    assert.equal(calendar.currentPlanDate(seoul("2026-10-31T23:00")), "2026-11-01");
  });

  test("계획일 D+1의 블랙아웃은 D일 23:00에 시작해 D+1일 07:00에 끝나고, 그날 끝은 D+1일 23:00이다", () => {
    assert.equal(calendar.isInBlackout(seoul("2026-10-30T23:30")), true);
    assert.equal(iso(calendar.blackoutEndOf("2026-10-31")), "2026-10-31 07:00");
    assert.equal(iso(calendar.endOfDay("2026-10-31")), "2026-10-31 23:00");
  });
});

describe("DST가 있는 시간대", () => {
  const calendar = calendarWithBlackout("02:30-08:00", "America/New_York");

  test("없는 시각(봄 02:30)은 luxon 기본 보정으로 앞당겨진 구간이 된다", () => {
    const start = calendar.endOfDay("2026-03-07");
    assert.equal(iso(start, "America/New_York"), "2026-03-08 03:30");
    assert.equal(calendar.currentPlanDate(start), "2026-03-08");
    assert.equal(calendar.currentPlanDate(start.minus({ minutes: 1 })), "2026-03-07");
  });

  test("두 번 있는 날에도 계획일은 하루씩 넘어간다", () => {
    const fallBackDay = DateTime.fromISO("2026-11-01T12:00", { zone: "America/New_York" });
    assert.equal(calendar.currentPlanDate(fallBackDay), "2026-11-01");
    assert.equal(calendar.currentPlanDate(fallBackDay.plus({ days: 1 })), "2026-11-02");
  });
});

test("턴 백오프는 처음 값에서 두 배씩 늘고 상한에서 멈춘다", () => {
  const config = testConfig();
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((failures) => failureBackoffDelaySec(failures, config)),
    [600, 1200, 2400, 4800, 7200],
  );
});
