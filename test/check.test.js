import { describe, expect, it } from "bun:test";
import { AVAILABILITY_THRESHOLD, PRICE_FLOOR } from "../config/objects.js";
import {
  buildReport,
  evaluate,
  isAvailabilityAlertSuppressed,
  isAvailable,
  isChangeAlert,
  priceOf,
} from "../src/check.js";

const placement = (overrides = {}) => ({
  uuid: "u1",
  name: "42",
  isSale: true,
  floor: 3,
  square: 18,
  discount: { stock: { data: [] } },
  totalPrice: 3_000_000,
  ...overrides,
});

const withPrice = (price) => placement({ discount: { stock: { data: [{ priceWithDiscount: price }] } } });

const noBaseline = { lastReportedMinPrice: null, lastReportedAvailableCount: null };

describe("check", () => {
  describe("priceOf", () => {
    it("prefers the minimum discounted price over totalPrice", () => {
      const p = placement({
        totalPrice: 5_000_000,
        discount: { stock: { data: [{ priceWithDiscount: 4_000_000 }, { priceWithDiscount: 3_500_000 }] } },
      });
      expect(priceOf(p)).toBe(3_500_000);
    });

    it("falls back to totalPrice when there are no discount entries", () => {
      expect(priceOf(placement({ totalPrice: 3_000_000 }))).toBe(3_000_000);
    });
  });

  describe("isAvailable", () => {
    it("treats isSale !== false as available", () => {
      expect(isAvailable(placement({ isSale: true }))).toBe(true);
      expect(isAvailable(placement({ isSale: undefined }))).toBe(true);
      expect(isAvailable(placement({ isSale: false }))).toBe(false);
    });
  });

  describe("evaluate", () => {
    it("first run (no baseline): treats a qualifying value as changed and as a crossing", () => {
      const placements = [withPrice(2_000_000)]; // at/below PRICE_FLOOR
      const result = evaluate({ placements, previous: noBaseline });
      expect(result.priceChanged).toBe(true);
      expect(result.priceCrossedFloor).toBe(true);
      expect(result.countChanged).toBe(true);
      expect(result.next).toEqual({ lastReportedMinPrice: 2_000_000, lastReportedAvailableCount: 1 });
    });

    it("no change: identical min price and count against the baseline", () => {
      const placements = [withPrice(3_000_000)];
      const previous = { lastReportedMinPrice: 3_000_000, lastReportedAvailableCount: 1 };
      const result = evaluate({ placements, previous });
      expect(result.priceChanged).toBe(false);
      expect(result.countChanged).toBe(false);
      expect(result.priceCrossedFloor).toBe(false);
      expect(result.countCrossedThreshold).toBe(false);
    });

    it("price rising back above the floor is a change, not a crossing", () => {
      const placements = [withPrice(2_500_000)];
      const previous = { lastReportedMinPrice: 2_000_000, lastReportedAvailableCount: 1 };
      const result = evaluate({ placements, previous });
      expect(result.priceChanged).toBe(true);
      expect(result.priceCrossedFloor).toBe(false);
    });

    it("price dropping further while already at/below the floor is a change, not a re-crossing", () => {
      const placements = [withPrice(1_800_000)];
      const previous = { lastReportedMinPrice: 2_100_000, lastReportedAvailableCount: 1 };
      const result = evaluate({ placements, previous });
      expect(result.priceChanged).toBe(true);
      expect(result.priceCrossedFloor).toBe(false); // was already at/below floor
    });

    it("flags a count crossing when availability newly drops under the threshold", () => {
      const placements = Array.from({ length: AVAILABILITY_THRESHOLD - 1 }, () => withPrice(5_000_000));
      const previous = { lastReportedMinPrice: 5_000_000, lastReportedAvailableCount: AVAILABILITY_THRESHOLD };
      const result = evaluate({ placements, previous });
      expect(result.countChanged).toBe(true);
      expect(result.countCrossedThreshold).toBe(true);
    });

    it("does not re-flag a count crossing on a further drop below the threshold", () => {
      const placements = Array.from({ length: 3 }, () => withPrice(5_000_000));
      const previous = { lastReportedMinPrice: 5_000_000, lastReportedAvailableCount: 10 };
      const result = evaluate({ placements, previous });
      expect(result.countChanged).toBe(true);
      expect(result.countCrossedThreshold).toBe(false);
    });

    it("zero available units: minPrice is null and does not crash floor comparison", () => {
      const placements = [placement({ isSale: false })];
      const result = evaluate({ placements, previous: noBaseline });
      expect(result.availableCount).toBe(0);
      expect(result.minPrice).toBeNull();
      expect(result.priceCrossedFloor).toBe(false);
    });

    it("ignores unavailable placements when computing the minimum price", () => {
      const placements = [withPrice(1_000_000), placement({ isSale: false, discount: { stock: { data: [{ priceWithDiscount: 1 }] } } })];
      const result = evaluate({ placements, previous: noBaseline });
      expect(result.availableCount).toBe(1);
      expect(result.minPrice).toBe(1_000_000);
    });
  });

  describe("buildReport", () => {
    const object = { name: "Test Object", url: "https://example.com" };

    it("omits the bell when nothing changed", () => {
      const evaluated = evaluate({ placements: [withPrice(3_000_000)], previous: { lastReportedMinPrice: 3_000_000, lastReportedAvailableCount: 1 } });
      const report = buildReport([{ object, evaluated, changed: false }]);
      expect(report).not.toContain("🔔");
      expect(report).toContain("Мин. цена");
      expect(report).not.toContain("было");
    });

    it("shows the bell and a 'was' delta when something changed", () => {
      const evaluated = evaluate({ placements: [withPrice(2_000_000)], previous: { lastReportedMinPrice: 3_000_000, lastReportedAvailableCount: 1 } });
      const report = buildReport([{ object, evaluated, changed: true }]);
      expect(report).toContain("🔔");
      expect(report).toContain("было");
      expect(report).toContain("🔥");
    });

    it("reports a fetch error inline instead of throwing", () => {
      const report = buildReport([{ object, error: new Error("HTTP 500"), changed: true }]);
      expect(report).toContain("Данные недоступны");
      expect(report).toContain("HTTP 500");
    });
  });

  describe("availability alert suppression", () => {
    it("isAvailabilityAlertSuppressed reads SKIP_AVAILABILITY_ALERT", () => {
      expect(isAvailabilityAlertSuppressed({ SKIP_AVAILABILITY_ALERT: "1" })).toBe(true);
      expect(isAvailabilityAlertSuppressed({ SKIP_AVAILABILITY_ALERT: "true" })).toBe(true);
      expect(isAvailabilityAlertSuppressed({})).toBe(false);
      expect(isAvailabilityAlertSuppressed({ SKIP_AVAILABILITY_ALERT: "0" })).toBe(false);
    });

    describe("isChangeAlert", () => {
      const countCrossing = evaluate({
        placements: Array.from({ length: AVAILABILITY_THRESHOLD - 1 }, () => withPrice(5_000_000)),
        previous: { lastReportedMinPrice: 5_000_000, lastReportedAvailableCount: AVAILABILITY_THRESHOLD },
      });

      it("a count-only change alerts when not suppressed", () => {
        expect(isChangeAlert(countCrossing, { suppressAvailabilityAlert: false })).toBe(true);
      });

      it("a count-only change is muted when suppressed", () => {
        expect(isChangeAlert(countCrossing, { suppressAvailabilityAlert: true })).toBe(false);
      });

      it("a price change still alerts even when suppressed", () => {
        const priceChange = evaluate({
          placements: [withPrice(2_000_000)],
          previous: { lastReportedMinPrice: 3_000_000, lastReportedAvailableCount: 1 },
        });
        expect(isChangeAlert(priceChange, { suppressAvailabilityAlert: true })).toBe(true);
      });

      it("recovery still alerts even when suppressed and nothing else changed", () => {
        const noChange = evaluate({
          placements: [withPrice(3_000_000)],
          previous: { lastReportedMinPrice: 3_000_000, lastReportedAvailableCount: 1 },
        });
        expect(isChangeAlert(noChange, { justRecovered: true, suppressAvailabilityAlert: true })).toBe(true);
      });
    });

    describe("buildReport", () => {
      const object = { name: "Test Object" };

      it("hides the count-crossing 🔥 marker when suppressed, but keeps the count itself", () => {
        const evaluated = evaluate({
          placements: Array.from({ length: AVAILABILITY_THRESHOLD - 1 }, () => withPrice(5_000_000)),
          previous: { lastReportedMinPrice: 5_000_000, lastReportedAvailableCount: AVAILABILITY_THRESHOLD },
        });

        const shown = buildReport([{ object, evaluated, changed: true }]);
        const hidden = buildReport([{ object, evaluated, changed: true }], { suppressAvailabilityAlert: true });

        expect(shown).toContain("Наличие ниже порога");
        expect(hidden).not.toContain("Наличие ниже порога");
        expect(hidden).not.toContain("🔥");
        expect(hidden).toContain("В продаже");
      });

      it("still shows the price-crossing 🔥 marker even when availability alerts are suppressed", () => {
        const evaluated = evaluate({
          placements: [withPrice(2_000_000)],
          previous: { lastReportedMinPrice: 3_000_000, lastReportedAvailableCount: 1 },
        });

        const report = buildReport([{ object, evaluated, changed: true }], { suppressAvailabilityAlert: true });
        expect(report).toContain("🔥");
        expect(report).toContain("Цена достигла порога");
      });
    });
  });
});
