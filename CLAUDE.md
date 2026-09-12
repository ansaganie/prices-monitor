# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Implemented and verified against the live API. `i-need-a-price-sequential-snowglobe.md` is the design spec and remains the source of truth for *why* things are built the way they are (it records several live-debugged domain rules); read it before changing behaviour, and keep it in sync if the design changes. The summary below is a condensed pointer into it, not a replacement.

Not yet done: pushing to a GitHub repo, adding the two Telegram secrets, and a `workflow_dispatch` smoke run — see README.

## What this project is

A zero-server parking-listing monitor for two BI Group residential complexes (Jetisu Satti, Jetisu Kerbez Comfort). It polls BI Group's internal JSON API on a schedule via GitHub Actions and sends a Telegram notification when a unit's price drops to/below a floor (2,200,000 KZT) or when available-unit count drops below a threshold (20). Runtime is Bun with **no npm dependencies** — only Bun's built-in `fetch`.

## Commands (once implemented)

- Run the monitor once: `bun run src/check.js`
- No build step, no test framework, no linter configured yet — this is a single-script Bun project.
- No npm/npx in this devcontainer (Bun-only image) — use `bunx` in place of `npx` for anything that needs it (e.g. the Perplexity MCP server config).
- Local runs need `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment (or a `.env` Bun loads automatically).

## Architecture

**State persistence across ephemeral runners**: GitHub Actions runners don't persist state between runs, so "did this change since last time" is tracked by committing `data/state.json` back to the repo after each run (only when it actually changed). There is no external DB — this is the entire persistence layer.

**Planned file layout** (see the spec doc for full detail):
- `config/objects.js` — extendable array of monitored real-estate objects (`PRICE_FLOOR`, `AVAILABILITY_THRESHOLD`, `OBJECTS`).
- `src/bi-api.js` — `fetchAllPlacements()`: paginates the BI Group API (`pageNo` starts at **1**, not 0) and validates every returned placement actually belongs to a requested `realEstateUUIDs` entry (guards against the API silently returning the wrong inventory on a bad request key).
- `src/telegram.js` — `sendMessage(text)` via the Telegram Bot API; throws on non-OK so misconfigured secrets fail loudly.
- `src/check.js` — main entrypoint: fetch → evaluate → diff against previous `data/state.json` → notify on new triggers only (edge-triggered, not every run) → write updated state.
- `.github/workflows/monitor.yml` — cron (`*/30 * * * *`) + `workflow_dispatch`, needs `permissions: contents: write` to commit state back.

### Non-obvious domain rules (already debugged in the spec — do not re-derive these from scratch)

- **Price field**: use `discount.stock.data[].priceWithDiscount` (minimum across entries if several), falling back to `totalPrice` only when `discount.stock.data` is empty. The top-level `totalPriceWithDiscount` field is unreliable (observed stale on real data). The fallback must check `discounts.length` explicitly — `Math.min(...discounts) || p.totalPrice` is a bug, since `Math.min()` of an empty array is `Infinity`, which is truthy.
- **Availability**: a placement counts as available when `isSale !== false`. Do **not** use `placementStatusName` for this — it records booking history, not current availability, and produces wrong results at Kerbez (which currently has zero `Свободно` placements despite having available units).
- **Request body**: the API key is `realEstateUUIDs` (array, plural) — sending `realEstateUUID` returns HTTP 200 with the wrong company-wide data instead of erroring, so always validate the response's real-estate UUIDs against the request. `companyIds` is not required and should be omitted. `pageNo` is 1-based; `pageNo: 0` returns HTTP 400.
- **An empty placement list is a failure, not an empty object.** A retired or mistyped-but-well-formed `realEstateUUID` returns HTTP 200 with `placements: []` (verified live) — which would flow into `availableCount = 0` and fire a false low-stock alert. `fetchAllPlacements` throws on zero placements so it takes the fetch-failure path instead.
- **Fetch failures must never be treated as zero placements/zero availability** — that would fire a false low-stock alert on a network hiccup. Skip evaluation for that object on failure instead.
- **First run** alerts on anything already qualifying (empty previous state = everything is "new"), not just future crossings — no special-casing needed as long as missing `data/state.json` defaults to empty sets.
