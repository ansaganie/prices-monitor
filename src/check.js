// Main entrypoint: fetch → evaluate → diff against previous state → notify on
// active Send Triggers only → write state back. State lives in a GitHub Release
// body (see docs/adr/0001-release-body-for-state-persistence.md) rather than a
// committed file — that release is the whole persistence layer.
//
// See CONTEXT.md and docs/adr/0002-baseline-diff-notification-triggers.md for
// the Send Trigger / Reported Baseline / Crossing Event vocabulary used below.

import { AVAILABILITY_THRESHOLD, OBJECTS, PRICE_FLOOR } from "../config/objects.js";
import { fetchAllPlacements } from "./bi-api.js";
import { readReleaseState, writeReleaseState } from "./release-state.js";
import {
  getAstanaTime,
  isDigestDue,
  isRunForced,
  isWithinWorkingHours,
  WORKING_HOURS_END,
  WORKING_HOURS_START,
} from "./schedule.js";
import { escapeHtml, sendMessage } from "./telegram.js";

const STATE_VERSION = 2;

/** Bump the keep-alive timestamp this often. Historically guarded against
 *  GitHub's 60-day scheduled-workflow inactivity disable; kept as-is per
 *  docs/adr/0001-release-body-for-state-persistence.md (storage changed,
 *  behaviour didn't). */
const KEEPALIVE_DAYS = 14;

/** If longer than this has passed since the last run, the external-cron guarantee
 *  has silently broken (expired PAT, cron-job.org outage, etc.) — flag it once. */
const RUN_GAP_WARNING_MINUTES = 90;

const formatPrice = (value) => new Intl.NumberFormat("ru-RU").format(value);

/**
 * Mutes the availability-count's role as a Change Alert trigger (and its 🔥
 * Crossing Event marker), without touching the Reported Baseline — set via the
 * external-cron repository_dispatch's client_payload.skipAvailabilityAlert,
 * wired through to SKIP_AVAILABILITY_ALERT in monitor.yml. Price-based Change
 * Alerts, the Daily Digest, and the Run-Gap Watchdog are unaffected.
 */
export function isAvailabilityAlertSuppressed(env = process.env) {
  return env.SKIP_AVAILABILITY_ALERT === "1" || env.SKIP_AVAILABILITY_ALERT === "true";
}

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
 * Compare this run's observations against the Reported Baseline (the values
 * from the last message actually sent for this object) and decide whether a
 * Change Alert is warranted. Aggregate-only: min available price and available
 * count, not individual placements.
 */
export function evaluate({ placements, previous }) {
  const available = placements.filter(isAvailable);
  const availableCount = available.length;
  const cheapest =
    available.length > 0 ? available.reduce((best, p) => (priceOf(p) < priceOf(best) ? p : best)) : null;
  const minPrice = cheapest ? priceOf(cheapest) : null;

  const priceChanged = previous.lastReportedMinPrice !== minPrice;
  const countChanged = previous.lastReportedAvailableCount !== availableCount;

  // Crossing Event: the Reported Baseline was on one side of the floor/threshold
  // and the new value is on the other. A one-time highlight, not a persistent
  // "still low" status — so it only fires alongside the change that caused it.
  // No baseline (previous value null, i.e. never reported) counts as "above",
  // so a first-ever report that already qualifies is itself a crossing.
  const wasAboveFloor = previous.lastReportedMinPrice === null || previous.lastReportedMinPrice > PRICE_FLOOR;
  const isAtOrBelowFloor = minPrice !== null && minPrice <= PRICE_FLOOR;
  const priceCrossedFloor = priceChanged && wasAboveFloor && isAtOrBelowFloor;

  const wasAboveThreshold =
    previous.lastReportedAvailableCount === null || previous.lastReportedAvailableCount >= AVAILABILITY_THRESHOLD;
  const isBelowThreshold = availableCount < AVAILABILITY_THRESHOLD;
  const countCrossedThreshold = countChanged && wasAboveThreshold && isBelowThreshold;

  return {
    availableCount,
    minPrice,
    cheapest,
    priceChanged,
    countChanged,
    priceCrossedFloor,
    countCrossedThreshold,
    previousMinPrice: previous.lastReportedMinPrice,
    previousAvailableCount: previous.lastReportedAvailableCount,
    // The Reported Baseline only needs updating when it actually differs — and
    // priceChanged/countChanged being true is exactly what forces a send this
    // run (see main()), so setting it unconditionally here is safe: when
    // nothing changed the value is identical to the previous baseline anyway.
    next: {
      lastReportedMinPrice: minPrice,
      lastReportedAvailableCount: availableCount,
    },
  };
}

/**
 * Whether this run's evaluation warrants a Change Alert send. Split out from
 * `evaluate()` (which stays agnostic of the suppression toggle) so it's
 * unit-testable on its own: with `suppressAvailabilityAlert`, a count-only
 * change no longer forces a send — only a price change or recovery does.
 */
export function isChangeAlert(evaluated, { justRecovered = false, suppressAvailabilityAlert = false } = {}) {
  return evaluated.priceChanged || (evaluated.countChanged && !suppressAvailabilityAlert) || justRecovered;
}

function buildObjectBlock({ object, evaluated, justRecovered, suppressAvailabilityAlert = false }) {
  const header = `<b>${escapeHtml(object.name)}</b>`;
  const lines = [header];
  if (justRecovered) lines.push("✅ Данные снова доступны");

  const {
    availableCount,
    minPrice,
    cheapest,
    priceChanged,
    countChanged,
    priceCrossedFloor,
    countCrossedThreshold,
    previousMinPrice,
    previousAvailableCount,
  } = evaluated;

  const countWas = countChanged && previousAvailableCount !== null ? ` (было ${previousAvailableCount})` : "";
  lines.push(`• В продаже: <b>${availableCount}</b>${countWas}`);

  if (availableCount > 0) {
    const details = [
      cheapest.floor != null ? `эт. ${cheapest.floor}` : null,
      cheapest.square != null ? `${cheapest.square} м²` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const detailSuffix = details ? ` · ${details}` : "";
    const priceWas =
      priceChanged && previousMinPrice !== null ? ` (было ${formatPrice(previousMinPrice)} ₸)` : "";
    lines.push(`• Мин. цена: <b>${formatPrice(minPrice)} ₸</b>${detailSuffix}${priceWas}`);
  }

  if (priceCrossedFloor) lines.push(`🔥 Цена достигла порога ≤ ${formatPrice(PRICE_FLOOR)} ₸`);
  if (countCrossedThreshold && !suppressAvailabilityAlert) {
    lines.push(`🔥 Наличие ниже порога ${AVAILABILITY_THRESHOLD}`);
  }

  if (object.url) lines.push(`🔗 ${object.url}`);
  return lines.join("\n");
}

/**
 * Build the Telegram message for this run's active Send Triggers. Always shows
 * every Monitored Object's full current status (not just the one that
 * triggered the send) — cheap context, and it's the same shape whether the
 * send is a Daily Digest, a Change Alert, or both merged together.
 */
export function buildReport(objectResults, { suppressAvailabilityAlert = false } = {}) {
  const hasChanges = objectResults.some((r) => r.changed);
  const title = hasChanges
    ? "🅿️ <b>BI Group — паркинг · Отчет о сканировании 🔔</b>"
    : "🅿️ <b>BI Group — паркинг · Отчет о сканировании</b>";

  const blocks = objectResults.map(({ object, error, evaluated, justRecovered }) => {
    if (error) {
      const header = `<b>${escapeHtml(object.name)}</b>`;
      return `${header}\n⚠️ Данные недоступны: <i>${escapeHtml(error.message)}</i>`;
    }
    return buildObjectBlock({ object, evaluated, justRecovered, suppressAvailabilityAlert });
  });

  return `${title}\n\n${blocks.join("\n\n")}`;
}

const emptyState = () => ({
  version: STATE_VERSION,
  keepAliveAt: null,
  lastRunAt: null,
  lastDigestDate: null,
  objects: {},
});

/**
 * @returns {Promise<{ releaseId: number | null, state: object }>} `releaseId`
 * is null on a genuine first run (no release yet) — `saveState` then creates it.
 */
async function loadState() {
  const found = await readReleaseState();
  if (!found) {
    // No release yet = first run. Empty defaults make every currently-qualifying
    // object's baseline "unreported", which is the intended behaviour.
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
    lastReportedMinPrice: null,
    lastReportedAvailableCount: null,
    failing: false,
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
  const astana = getAstanaTime();
  const digestDue = isDigestDue(astana, state.lastDigestDate);
  const gapWarningActive = gapMinutes !== null && gapMinutes > RUN_GAP_WARNING_MINUTES;

  const nextObjects = { ...state.objects };
  // Collected for the report — one entry per object, only included in the
  // Telegram message when something ends up warranting a send this run.
  const objectResults = [];

  const suppressAvailabilityAlert = isAvailabilityAlertSuppressed();
  if (suppressAvailabilityAlert) {
    console.log("Availability Change Alert suppressed this run (SKIP_AVAILABILITY_ALERT)");
  }

  for (const object of OBJECTS) {
    const previous = { ...emptyObjectState(object.name), ...(state.objects[object.id] ?? {}) };

    let placements;
    try {
      placements = await fetchAllPlacements(object);
    } catch (error) {
      // Never let a fetch failure look like "0 available" — that would fire a
      // false low-stock Change Alert. Keep the previous baseline and skip
      // evaluation. Only the *first* run an object fails is itself a trigger
      // (an ongoing failure just rides along on whatever else sends).
      console.error(`[${object.id}] fetch failed: ${error.message}`);
      const justStartedFailing = !previous.failing;
      nextObjects[object.id] = { ...previous, failing: true };
      objectResults.push({ object, error, changed: justStartedFailing, justStartedFailing });
      continue;
    }

    const evaluated = evaluate({ placements, previous });
    const justRecovered = previous.failing;
    const changed = isChangeAlert(evaluated, { justRecovered, suppressAvailabilityAlert });
    nextObjects[object.id] = { name: object.name, ...evaluated.next, failing: false };

    console.log(
      `[${object.id}] ${placements.length} placements, ${evaluated.availableCount} available, ` +
        `min price ${evaluated.minPrice ?? "—"}${changed ? " (changed)" : ""}`,
    );

    objectResults.push({ object, evaluated, changed, justRecovered });
  }

  const anyObjectChanged = objectResults.some((r) => r.changed);
  const shouldSend = digestDue || gapWarningActive || anyObjectChanged;

  if (shouldSend) {
    const report = buildReport(objectResults, { suppressAvailabilityAlert });
    // The external-cron trigger is what guarantees a run every working hour (native
    // GitHub `schedule:` is unreliable for this account — see monitor.yml). A large
    // gap since the last run means that guarantee has silently broken.
    const gapWarning = gapWarningActive
      ? `⚠️ Предыдущий запуск был ${Math.round(gapMinutes)} мин назад — проверьте внешний cron.\n\n`
      : "";
    await sendMessage(`${gapWarning}${report}`);

    const reasons = [
      digestDue && "daily digest",
      anyObjectChanged && "change alert",
      gapWarningActive && "run-gap watchdog",
    ].filter(Boolean);
    console.log(`Sent report (${reasons.join(" + ")})`);
  } else {
    console.log("No active Send Trigger this run — nothing sent");
  }

  await saveState(
    {
      ...state,
      objects: nextObjects,
      lastRunAt: new Date().toISOString(),
      lastDigestDate: digestDue ? astana.dateString : state.lastDigestDate,
    },
    releaseId,
  );
}

async function saveState(state, releaseId) {
  const previousKeepAlive = state.keepAliveAt ? Date.parse(state.keepAliveAt) : NaN;
  const staleKeepAlive =
    Number.isNaN(previousKeepAlive) || Date.now() - previousKeepAlive > KEEPALIVE_DAYS * 86_400_000;

  const next = {
    version: STATE_VERSION,
    keepAliveAt: staleKeepAlive ? new Date().toISOString() : state.keepAliveAt,
    lastRunAt: state.lastRunAt,
    lastDigestDate: state.lastDigestDate,
    objects: state.objects,
  };
  await writeReleaseState(next, releaseId);
}

// Guarded so the pure helpers above (priceOf, isAvailable, evaluate) can be
// imported and exercised without firing a live run.
if (import.meta.main) await main();
