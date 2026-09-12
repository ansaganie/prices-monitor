// Client for BI Group's public sales-picker API. No auth, no cookies — the
// site's own frontend calls this endpoint directly.

const API_URL = "https://apigw.bi.group/sales-picker/microfe-v3/placementList";

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 5000 placements — far beyond any real object; a runaway guard.
const REQUEST_TIMEOUT_MS = 20_000;
const RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage({ realEstateUUIDs, propertyTypes, pageNo }) {
  // `realEstateUUIDs` is plural and `pageNo` is 1-based. Both matter: the API
  // ignores unknown keys and answers 200 with the whole company's inventory if
  // you send `realEstateUUID`, and answers 400 for `pageNo: 0`.
  const body = { realEstateUUIDs, propertyTypes, pageNo, pageSize: PAGE_SIZE };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`placementList page ${pageNo} returned HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (!Array.isArray(json?.placements)) {
    throw new Error(`placementList page ${pageNo} returned no "placements" array`);
  }
  return json.placements;
}

async function fetchPageWithRetry(params) {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fetchPage(params);
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

/**
 * Fetch every placement for one object, walking pages until a short page ends it.
 * Throws on any HTTP/network failure or on a response that doesn't match the
 * request — callers must treat a throw as "no data this run", never as "0 units".
 *
 * @returns {Promise<object[]>} flat array of placements, deduped by uuid
 */
export async function fetchAllPlacements({ realEstateUUIDs, propertyTypes }) {
  const byUuid = new Map();
  let pageNo = 1;

  for (; pageNo <= MAX_PAGES; pageNo++) {
    const page = await fetchPageWithRetry({ realEstateUUIDs, propertyTypes, pageNo });
    for (const placement of page) byUuid.set(placement.uuid, placement);
    if (page.length < PAGE_SIZE) break;
  }

  if (pageNo > MAX_PAGES) {
    throw new Error(`placementList did not terminate within ${MAX_PAGES} pages — refusing partial data`);
  }

  const placements = [...byUuid.values()];

  // A retired or mistyped-but-well-formed UUID gets HTTP 200 with an empty list,
  // not an error — which would flow into "0 available" and fire a false low-stock
  // alert. A monitored object always has placements, so treat empty as a failure.
  if (placements.length === 0) {
    throw new Error(
      `placementList returned 0 placements for ${realEstateUUIDs.join(", ")} — ` +
        "treating as a failed fetch rather than an empty object (check the UUIDs are still valid)",
    );
  }

  // The only runtime check that catches a bad request key: the API answers 200
  // with someone else's inventory rather than erroring, so verify what came back
  // is actually what was asked for.
  const requested = new Set(realEstateUUIDs);
  const foreign = [...new Set(placements.map((p) => p.realEstateUUID).filter((u) => !requested.has(u)))];
  if (foreign.length > 0) {
    throw new Error(
      `placementList returned placements from unrequested real estate: ${foreign.join(", ")} ` +
        `(requested ${realEstateUUIDs.join(", ")})`,
    );
  }

  return placements;
}
