// Main entrypoint: fetch → evaluate → diff against previous state → notify on
// new triggers only → write state back. State lives in a GitHub Release body
// (see docs/adr/0001-release-body-for-state-persistence.md) rather than a
// committed file — that release is the whole persistence layer.

import { AVAILABILITY_THRESHOLD, OBJECTS, PRICE_FLOOR } from "../config/objects.js";
import { fetchAllPlacements } from "./bi-api.js";
import { readReleaseState, writeReleaseState } from "./release-state.js";
import {
  getAstanaTime,
  isRunForced,
  isWithinWorkingHours,
  WORKING_HOURS_END,
  WORKING_HOURS_START,
} from "./schedule.js";
import { escapeHtml, sendMessage } from "./telegram.js";

const STATE_VERSION = 1;

/** Bump the keep-alive timestamp this often. Historically guarded against
 *  GitHub's 60-day scheduled-workflow inactivity disable; kept as-is per
 *  docs/adr/0001-release-body-for-state-persistence.md (storage changed,
 *  behaviour didn't). */
const KEEPALIVE_DAYS = 14;

/** Cap how many units one alert lists before collapsing the rest into a count. */
const MAX_UNITS_LISTED = 15;

/** If longer than this has passed since the last run, the external-cron guarantee
 *  has silently broken (expired PAT, cron-job.org outage, etc.) — flag it once. */
const RUN_GAP_WARNING_MINUTES = 90;

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

const emptyState = () => ({ version: STATE_VERSION, keepAliveAt: null, lastRunAt: null, objects: {} });

/**
 * @returns {Promise<{ releaseId: number | null, state: object }>} `releaseId`
 * is null on a genuine first run (no release yet) — `saveState` then creates it.
 */
async function loadState() {
  const found = await readReleaseState();
  if (!found) {
    // No release yet = first run. Empty defaults make every currently-qualifying
    // unit a "new" trigger, which is the intended behaviour.
    return { releaseId: null, state: emptyState() };
  }
  return {
    releaseId: found.releaseId,
    state: { ...emptyState(), ...found.state, objects: found.state.objects ?? {} },
  };
}

/** Minutes since the previous run, or null if there's no previous run to compare
 *  against (first run, or an unparseable timestamp). */
function minutesSinceLastRun(state) {
  if (!state.lastRunAt) return null;
  const previous = Date.parse(state.lastRunAt);
  return Number.isNaN(previous) ? null : (Date.now() - previous) / 60_000;
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
  const forced = isRunForced();
  if (!forced && !isWithinWorkingHours()) {
    const { timeString } = getAstanaTime();
    console.log(
      `Outside Astana working hours (${WORKING_HOURS_START}:00 - ${WORKING_HOURS_END}:00 UTC+05:00, current: ${timeString}). ` +
        `Skipping check. (Use --force or FORCE_RUN=1 to run anyway)`,
    );
    return;
  }

  const { releaseId, state } = await loadState();
  const gapMinutes = minutesSinceLastRun(state);
  const nextObjects = { ...state.objects };
  // Collected for the scan report — one entry per object.
  const objectResults = [];

  for (const object of OBJECTS) {
    const previous = { ...emptyObjectState(object.name), ...(state.objects[object.id] ?? {}) };

    let placements;
    try {
      placements = await fetchAllPlacements(object);
    } catch (error) {
      // Never let a fetch failure look like "0 available" — that would fire a
      // false low-stock alert. Keep the previous numbers and skip evaluation.
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
  // The external-cron trigger is what guarantees a run every working hour (native
  // GitHub `schedule:` is unreliable for this account — see monitor.yml). A large
  // gap since the last run means that guarantee has silently broken.
  const gapWarning =
    gapMinutes !== null && gapMinutes > RUN_GAP_WARNING_MINUTES
      ? `⚠️ Предыдущий запуск был ${Math.round(gapMinutes)} мин назад — проверьте внешний cron.\n\n`
      : "";
  await sendMessage(`${gapWarning}${report}`);
  console.log("Sent scan report");

  const alertCount = objectResults.filter((r) => r.sections?.length > 0).length;
  if (alertCount > 0) {
    console.log(`Report includes alerts for ${alertCount} object(s)`);
  } else {
    console.log("No new alert triggers in this scan");
  }

  await saveState({ ...state, objects: nextObjects, lastRunAt: new Date().toISOString() }, releaseId);
}

async function saveState(state, releaseId) {
  const previousKeepAlive = state.keepAliveAt ? Date.parse(state.keepAliveAt) : NaN;
  const staleKeepAlive =
    Number.isNaN(previousKeepAlive) || Date.now() - previousKeepAlive > KEEPALIVE_DAYS * 86_400_000;

  const next = {
    version: STATE_VERSION,
    keepAliveAt: staleKeepAlive ? new Date().toISOString() : state.keepAliveAt,
    lastRunAt: state.lastRunAt,
    objects: state.objects,
  };
  await writeReleaseState(next, releaseId);
}

// Guarded so the pure helpers above (priceOf, isAvailable) can be imported and
// exercised without firing a live run.
if (import.meta.main) await main();
