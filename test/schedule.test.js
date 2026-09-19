import { describe, expect, it } from "bun:test";
import {
  getAstanaTime,
  isDigestDue,
  isRunForced,
  isWithinWorkingHours,
  WORKING_HOURS_END,
  WORKING_HOURS_START,
} from "../src/schedule.js";

describe("schedule", () => {
  describe("getAstanaTime", () => {
    it("converts UTC time to Astana time (UTC+05:00)", () => {
      const morningUtc = new Date("2026-09-14T01:17:00Z");
      const morningAstana = getAstanaTime(morningUtc);
      expect(morningAstana.hours).toBe(6);
      expect(morningAstana.minutes).toBe(17);
      expect(morningAstana.timeString).toBe("06:17");

      const eveningUtc = new Date("2026-09-14T14:47:00Z");
      const eveningAstana = getAstanaTime(eveningUtc);
      expect(eveningAstana.hours).toBe(19);
      expect(eveningAstana.minutes).toBe(47);
      expect(eveningAstana.timeString).toBe("19:47");

      const midnightRolloverUtc = new Date("2026-09-14T20:00:00Z");
      const midnightAstana = getAstanaTime(midnightRolloverUtc);
      expect(midnightAstana.hours).toBe(1);
      expect(midnightAstana.timeString).toBe("01:00");
    });

    it("rolls the Astana calendar date over at 19:00 UTC (00:00 Astana)", () => {
      expect(getAstanaTime(new Date("2026-09-14T18:59:00Z")).dateString).toBe("2026-09-14");
      expect(getAstanaTime(new Date("2026-09-14T19:00:00Z")).dateString).toBe("2026-09-15");
    });
  });

  describe("isDigestDue", () => {
    it("is false before 13:00 Astana", () => {
      const astana = getAstanaTime(new Date("2026-09-14T07:59:00Z")); // 12:59 Astana
      expect(isDigestDue(astana, null)).toBe(false);
    });

    it("is true at/after 13:00 Astana when no digest has been sent today", () => {
      const astana = getAstanaTime(new Date("2026-09-14T08:00:00Z")); // 13:00 Astana
      expect(isDigestDue(astana, null)).toBe(true);
      expect(isDigestDue(astana, "2026-09-13")).toBe(true);
    });

    it("is false on later runs the same Astana day once already sent", () => {
      const astana = getAstanaTime(new Date("2026-09-14T10:00:00Z")); // 15:00 Astana
      expect(isDigestDue(astana, "2026-09-14")).toBe(false);
    });

    it("is true again the next Astana day", () => {
      const astana = getAstanaTime(new Date("2026-09-15T08:30:00Z")); // 13:30 Astana
      expect(isDigestDue(astana, "2026-09-14")).toBe(true);
    });
  });

  describe("isWithinWorkingHours", () => {
    it("returns true at the start boundary 06:00 Astana (01:00 UTC)", () => {
      const date = new Date("2026-09-14T01:00:00Z");
      expect(isWithinWorkingHours(date)).toBe(true);
    });

    it("returns false immediately before 06:00 Astana (00:59 UTC)", () => {
      const date = new Date("2026-09-14T00:59:59Z");
      expect(isWithinWorkingHours(date)).toBe(false);
    });

    it("returns true during the first scheduled run at 06:17 Astana (01:17 UTC)", () => {
      const date = new Date("2026-09-14T01:17:00Z");
      expect(isWithinWorkingHours(date)).toBe(true);
    });

    it("returns true during midday at 12:00 Astana (07:00 UTC)", () => {
      const date = new Date("2026-09-14T07:00:00Z");
      expect(isWithinWorkingHours(date)).toBe(true);
    });

    it("returns true during the last scheduled run at 19:47 Astana (14:47 UTC)", () => {
      const date = new Date("2026-09-14T14:47:00Z");
      expect(isWithinWorkingHours(date)).toBe(true);
    });

    it("returns true at 19:59 Astana (14:59 UTC)", () => {
      const date = new Date("2026-09-14T14:59:59Z");
      expect(isWithinWorkingHours(date)).toBe(true);
    });

    it("returns false at the end boundary 20:00 Astana (15:00 UTC)", () => {
      const date = new Date("2026-09-14T15:00:00Z");
      expect(isWithinWorkingHours(date)).toBe(false);
    });

    it("returns false after 20:00 Astana (e.g. 20:17 Astana / 15:17 UTC)", () => {
      const date = new Date("2026-09-14T15:17:00Z");
      expect(isWithinWorkingHours(date)).toBe(false);
    });

    it("returns false in the middle of the night (03:00 Astana / 22:00 UTC previous day)", () => {
      const date = new Date("2026-09-14T22:00:00Z");
      expect(isWithinWorkingHours(date)).toBe(false);
    });

    it("supports custom start and end hours", () => {
      const date = new Date("2026-09-14T05:00:00Z"); // 10:00 Astana
      expect(isWithinWorkingHours(date, 9, 18)).toBe(true);
      expect(isWithinWorkingHours(date, 11, 18)).toBe(false);
    });
  });

  describe("isRunForced", () => {
    it("returns true when FORCE_RUN=1", () => {
      expect(isRunForced({ FORCE_RUN: "1" }, [])).toBe(true);
    });

    it("returns true when FORCE_RUN=true", () => {
      expect(isRunForced({ FORCE_RUN: "true" }, [])).toBe(true);
    });

    it("returns true when --force is passed in argv", () => {
      expect(isRunForced({}, ["bun", "src/check.js", "--force"])).toBe(true);
    });

    it("returns false when no force flag or env is present", () => {
      expect(isRunForced({}, ["bun", "src/check.js"])).toBe(false);
    });
  });
});
