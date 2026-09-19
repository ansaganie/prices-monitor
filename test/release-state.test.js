import { describe, expect, it } from "bun:test";
import { parseRepository } from "../src/release-state.js";

describe("release-state", () => {
  describe("parseRepository", () => {
    it("splits an owner/repo string", () => {
      expect(parseRepository("ansaganie/prices-monitor")).toEqual({
        owner: "ansaganie",
        repo: "prices-monitor",
      });
    });

    it("throws when the value is missing", () => {
      expect(() => parseRepository(undefined)).toThrow(/GITHUB_REPOSITORY/);
    });

    it("throws when the value has no slash", () => {
      expect(() => parseRepository("prices-monitor")).toThrow(/GITHUB_REPOSITORY/);
    });

    it("throws when either half is empty", () => {
      expect(() => parseRepository("/prices-monitor")).toThrow(/GITHUB_REPOSITORY/);
      expect(() => parseRepository("ansaganie/")).toThrow(/GITHUB_REPOSITORY/);
    });

    it("throws when there are extra path segments", () => {
      expect(() => parseRepository("ansaganie/prices-monitor/extra")).toThrow(/GITHUB_REPOSITORY/);
    });
  });
});
