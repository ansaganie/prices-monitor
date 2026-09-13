// Main entrypoint: fetch → evaluate → diff against committed state → notify on
// new triggers only → write state back. The workflow commits data/state.json
// afterwards, which is the whole persistence layer.

import { AVAILABILITY_THRESHOLD, OBJECTS, PRICE_FLOOR } from "../config/objects.js";
import { fetchAllPlacements } from "./bi-api.js";
import { escapeHtml, sendMessage } from "./telegram.js";

const STATE_PATH = Bun.fileURLToPath(new URL("../data/state.json", import.meta.url));
const STATE_VERSION = 1;

/** Bump the keep-alive timestamp this often. Scheduled workflows are disabled
 *  after 60 days of repo inactivity, and state only commits when it changes —
 *  so a quiet stretch would otherwise switch the monitor off silently. */
const KEEPALIVE_DAYS = 14;

/** Cap how many units one alert lists before collapsing the rest into a count. */
const MAX_UNITS_LISTED = 15;

const formatPrice = (value) => new Intl.NumberFormat("ru-RU").format(value);


/**
 * A placement's real price. `discount.stock.data[].priceWithDiscount` is what
 * the site renders; the top-level `totalPriceWithDiscount` goes stale.
 * The `discounts.length` check is deliberate — `Math.min(...[])` is `Infinity`,
 * which is truthy, so a `||` fallback would never fire.
 */
export function priceOf(placement) {
  const discounts = (placement.discount?.stock?.data ?? [])
    .map((entry) => entry.priceWithDiscount)
    .filter((price) => typeof price === "number");
  return discounts.length > 0 ? Math.min(...discounts) : placement.totalPrice;
}

/**
 * Availability comes from `isSale`, not `placementStatusName` — the status
 * string records booking history (Kerbez has zero `Свободно` units despite 74
 * being on sale), so only an explicit `isSale === false` means unavailable.
 */
export const isAvailable = (placement) => placement.isSale !== false;

/**
 * Build the scan report Telegram string from per-object fetch results.
 * `objectResults` is an array of `{ object, placements, sections }` or `{ object, error }`.
 */
export function buildReport(objectResults) {
  const hasAlerts = objectResults.some((r) => r.sections && r.sections.length > 0);
  const title = hasAlerts
    ? "🅿️ <b>BI Group — паркинг · Отчет о сканировании 🔔</b>"
    : "🅿️ <b>BI Group — паркинг · Отчет о сканировании</b>";

  const blocks = objectResults.map(({ object, placements, error, sections = [] }) => {
    const header = `<b>${escapeHtml(object.name)}</b>`;
    if (error) {
      return `${header}\n⚠️ Данные недоступны: <i>${escapeHtml(error.message)}</i>`;
    }

    const available = placements.filter(isAvailable);
    const availableCount = available.length;

    if (availableCount === 0) {
      const lines = [`${header}\n• В продаже: <b>0</b>`];
      if (sections.length > 0) {
        lines.push(sections.join("\n"));
        if (object.url) lines.push(`🔗 ${object.url}`);
      }
      return lines.join("\n");
    }

    const cheapest = available.reduce((best, p) =>
      priceOf(p) < priceOf(best) ? p : best,
    );

    const details = [
      cheapest.floor != null ? `эт. ${cheapest.floor}` : null,
      cheapest.square != null ? `${cheapest.square} м²` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const detailSuffix = details ? ` · ${details}` : "";

    const lines = [
      header,
      `• В продаже: <b>${availableCount}</b>`,
      `• Мин. цена: <b>${formatPrice(priceOf(cheapest))} ₸</b>${detailSuffix}`,
    ];

    if (sections.length > 0) {
      lines.push(sections.join("\n"));
      if (object.url) lines.push(`🔗 ${object.url}`);
    }

    return lines.join("\n");
  });

  return `${title}\n\n${blocks.join("\n\n")}`;
}

export const buildDigest = buildReport;

async function loadState() {
  try {
    const state = await Bun.file(STATE_PATH).json();
    return { version: STATE_VERSION, keepAliveAt: null, ...state, objects: state.objects ?? {} };
  } catch {
    // Missing or unreadable state = first run. Empty defaults make every
    // currently-qualifying unit a "new" trigger, which is the intended behaviour.
    return { version: STATE_VERSION, keepAliveAt: null, objects: {} };
  }
}

function emptyObjectState(name) {
  return {
    name,
    availableCount: null,
    belowFloorUUIDs: [],
    lastNotifiedAvailableCount: null,
    failing: false,
  };
}

/** Evaluate one object against its previous state. Returns the next state plus
 *  any alert lines this run should send. */
function evaluate({ object, placements, previous }) {
  const available = placements.filter(isAvailable);
  const availableCount = available.length;

  const belowFloor = available
    .filter((placement) => priceOf(placement) <= PRICE_FLOOR)
    .sort((a, b) => priceOf(a) - priceOf(b));

  const knownBelowFloor = new Set(previous.belowFloorUUIDs);
  const newlyBelowFloor = belowFloor.filter((placement) => !knownBelowFloor.has(placement.uuid));

  // Edge-triggered: fire when the count first drops under the threshold, and
  // again only if it drops further than what was last reported.
  const lowAvailability = availableCount < AVAILABILITY_THRESHOLD;
  const notifyAvailability =
    lowAvailability &&
    (previous.lastNotifiedAvailableCount === null || availableCount < previous.lastNotifiedAvailableCount);

  const sections = [];

  if (newlyBelowFloor.length > 0) {
    const lines = [
      `💰 Новые лоты по цене ≤ ${formatPrice(PRICE_FLOOR)} ₸ — ${newlyBelowFloor.length} шт.:`,
      ...newlyBelowFloor.slice(0, MAX_UNITS_LISTED).map((placement) => {
        const details = [
          placement.floor != null ? `${placement.floor} эт.` : null,
          placement.square != null ? `${placement.square} м²` : null,
        ].filter(Boolean);
        const suffix = details.length > 0 ? ` · ${details.join(" · ")}` : "";
        return `• №${escapeHtml(placement.name)} — <b>${formatPrice(priceOf(placement))} ₸</b>${suffix}`;
      }),
    ];
    if (newlyBelowFloor.length > MAX_UNITS_LISTED) {
      lines.push(`• …и ещё ${newlyBelowFloor.length - MAX_UNITS_LISTED}`);
    }
    sections.push(lines.join("\n"));
  }

  if (notifyAvailability) {
    const was =
      previous.availableCount !== null && previous.availableCount !== availableCount
        ? ` (было ${previous.availableCount})`
        : "";
    sections.push(
      `📉 Осталось в продаже: <b>${availableCount}</b>${was} — ниже порога ${AVAILABILITY_THRESHOLD}`,
    );
  }

  return {
    sections,
    next: {
      name: object.name,
      availableCount,
      belowFloorUUIDs: belowFloor.map((placement) => placement.uuid).sort(),
      // Reset once the count recovers, so a later re-crossing alerts again.
      lastNotifiedAvailableCount: notifyAvailability
        ? availableCount
        : lowAvailability
          ? previous.lastNotifiedAvailableCount
          : null,
      failing: false,
    },
  };
}

async function main() {
  const state = await loadState();
  const nextObjects = { ...state.objects };
  // Collected for the scan report — one entry per object.
  const objectResults = [];
  let anyFailure = false;

  for (const object of OBJECTS) {
    const previous = { ...emptyObjectState(object.name), ...(state.objects[object.id] ?? {}) };

    let placements;
    try {
      placements = await fetchAllPlacements(object);
    } catch (error) {
      // Never let a fetch failure look like "0 available" — that would fire a
      // false low-stock alert. Keep the previous numbers and skip evaluation.
      anyFailure = true;
      console.error(`[${object.id}] fetch failed: ${error.message}`);
      nextObjects[object.id] = { ...previous, failing: true };
      objectResults.push({ object, error });
      continue;
    }

    const { sections, next } = evaluate({ object, placements, previous });
    nextObjects[object.id] = next;

    console.log(
      `[${object.id}] ${placements.length} placements, ${next.availableCount} available, ` +
        `${next.belowFloorUUIDs.length} at/below ${PRICE_FLOOR}`,
    );

    if (previous.failing) {
      sections.unshift("✅ Данные снова доступны");
    }

    objectResults.push({ object, placements, sections });
  }

  const report = buildReport(objectResults);
  await sendMessage(report);
  console.log("Sent scan report");

  const alertCount = objectResults.filter((r) => r.sections?.length > 0).length;
  if (alertCount > 0) {
    console.log(`Report includes alerts for ${alertCount} object(s)`);
  } else {
    console.log("No new alert triggers in this scan");
  }

  await saveState({ ...state, objects: nextObjects });

  // Exit non-zero on failure so a broken run is visible in the Actions list;
  // the workflow still commits state because its commit step runs `if: always()`.
  if (anyFailure) process.exit(1);
}

async function saveState(state) {
  const previousKeepAlive = state.keepAliveAt ? Date.parse(state.keepAliveAt) : NaN;
  const staleKeepAlive =
    Number.isNaN(previousKeepAlive) || Date.now() - previousKeepAlive > KEEPALIVE_DAYS * 86_400_000;

  const next = {
    version: STATE_VERSION,
    keepAliveAt: staleKeepAlive ? new Date().toISOString() : state.keepAliveAt,
    objects: state.objects,
  };
  await Bun.write(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

// Guarded so the pure helpers above (priceOf, isAvailable) can be imported and
// exercised without firing a live run.
if (import.meta.main) await main();
