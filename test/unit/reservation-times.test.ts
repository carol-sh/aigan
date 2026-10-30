import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DateTime } from "luxon";
import { PlanCalendar } from "../../src/time.ts";
import {
  type ReservationTimeRules,
  fitContinueTime,
  fitOpeningTime,
  parseLocalTime,
} from "../../src/worker/reservation-times.ts";
import { testConfig } from "../fakes/config.ts";

function rulesWith(overrides: Record<string, string> = {}): ReservationTimeRules {
  const config = testConfig({ timezone: "Asia/Seoul", ...overrides });
  return { config, calendar: PlanCalendar.fromConfig(config) };
}

function local(text: string, timezone = "Asia/Seoul"): DateTime {
  return parseLocalTime(text, timezone)!;
}

function shown(time: DateTime, timezone = "Asia/Seoul"): string {
  return time.setZone(timezone).toFormat("yyyy-MM-dd HH:mm:ss");
}

describe("개시 예약 시각", () => {
  const rules = rulesWith({ blackout: "00:00-08:00" });
  const now = local("2026-10-30 10:00");

  test("깨어 있는 구간 안이면 그대로다", () => {
    const fitted = fitOpeningTime(rules, local("2026-10-30 15:00"), "2026-10-30", now);
    assert.deepEqual(fitted.ok && shown(fitted.at), "2026-10-30 15:00:00");
  });

  test("지난 시각과 min_lead 안의 시각은 now + min_lead로 당긴다", () => {
    for (const requested of ["2026-10-30 09:00", "2026-10-30 10:00"]) {
      const fitted = fitOpeningTime(rules, local(requested), "2026-10-30", now);
      assert.deepEqual(fitted.ok && shown(fitted.at), "2026-10-30 10:01:00");
    }
  });

  test("블랙아웃 안이면 블랙아웃 끝으로 당긴다", () => {
    const fitted = fitOpeningTime(
      rules,
      local("2026-10-30 07:00"),
      "2026-10-30",
      local("2026-10-30 06:00"),
    );
    assert.deepEqual(fitted.ok && shown(fitted.at), "2026-10-30 08:00:00");
  });

  test("그날 끝 바로 앞은 받고, 그날 끝부터는 이유에 그날 끝 시각을 담아 거부한다", () => {
    assert.equal(fitOpeningTime(rules, local("2026-10-30 23:59"), "2026-10-30", now).ok, true);
    const rejected = fitOpeningTime(rules, local("2026-10-31 00:00"), "2026-10-30", now);
    assert.equal(rejected.ok, false);
    assert.match(!rejected.ok ? rejected.reason : "", /2026-10-31 00:00/);
  });

  test("그날 끝까지 min_lead도 남지 않으면 어떤 시각이든 거부한다", () => {
    const lateNow = local("2026-10-30 23:59");
    assert.equal(fitOpeningTime(rules, lateNow, "2026-10-30", lateNow).ok, false);
  });

  test("자정을 넘는 블랙아웃에서는 그날 끝이 23:00이다", () => {
    const overnight = rulesWith({ blackout: "23:00-07:00" });
    const at = (text: string) =>
      fitOpeningTime(overnight, local(text), "2026-10-30", local("2026-10-30 10:00")).ok;
    assert.equal(at("2026-10-30 22:59"), true);
    assert.equal(at("2026-10-30 23:00"), false);
  });

  test("DST가 끝나는 날에도 그날 끝은 로컬 자정이다", () => {
    const newYork = rulesWith({ blackout: "00:00-08:00", timezone: "America/New_York" });
    const nyNow = local("2026-11-01 10:00", "America/New_York");
    const at = (text: string) =>
      fitOpeningTime(newYork, local(text, "America/New_York"), "2026-11-01", nyNow).ok;
    assert.equal(at("2026-11-01 23:59"), true);
    assert.equal(at("2026-11-02 00:00"), false);
  });
});

describe("이어가기 예약 시각", () => {
  const rules = rulesWith({ blackout: "00:00-08:00" });
  const now = local("2026-10-30 10:00");

  test("빠지거나 지난 시각은 continue_default_sec로 메우고 메웠다고 알린다", () => {
    for (const requested of [undefined, local("2026-10-30 09:00")]) {
      const fitted = fitContinueTime(rules, requested, "2026-10-30", now);
      assert.deepEqual(
        [shown(fitted.at), fitted.wasFilledWithDefault],
        ["2026-10-30 10:10:00", true],
      );
    }
  });

  test("너무 가까우면 now + min_lead로, 그날 끝 이후면 그날 끝으로 당긴다", () => {
    const soon = fitContinueTime(rules, now.plus({ seconds: 30 }), "2026-10-30", now);
    const tomorrow = fitContinueTime(rules, local("2026-10-31 08:00"), "2026-10-30", now);
    assert.deepEqual(
      [shown(soon.at), shown(tomorrow.at), soon.wasFilledWithDefault],
      ["2026-10-30 10:01:00", "2026-10-31 00:00:00", false],
    );
  });

  test("블랙아웃 시작을 넘겨 커밋하면 지난 그날 끝이 되어 곧바로 블랙아웃 닫기로 간다", () => {
    const fitted = fitContinueTime(rules, undefined, "2026-10-30", local("2026-10-31 00:05"));
    assert.equal(shown(fitted.at), "2026-10-31 00:00:00");
  });
});
