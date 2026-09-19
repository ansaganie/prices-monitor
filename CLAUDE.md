# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Implemented and verified against the live API. `i-need-a-price-sequential-snowglobe.md` is the design spec and remains the source of truth for *why* things are built the way they are (it records several live-debugged domain rules); read it before changing behaviour, and keep it in sync if the design changes. The summary below is a condensed pointer into it, not a replacement.

Not yet done: pushing to a GitHub repo, adding the two Telegram secrets, and a `workflow_dispatch` smoke run — see README.

## What this project is

A zero-server price monitor: it polls a source API on a schedule via GitHub Actions and notifies Telegram when a monitored object's price or availability is worth a look. Today it's configured for two BI Group residential complexes' parking (Jetisu Satti, Jetisu Kerbez Comfort) via BI Group's own API — see `docs/adr/0003-scope-bi-group-rebrand-to-docs.md` for what that does and doesn't mean about supporting other products later. Runtime is Bun with **no npm dependencies** — only Bun's built-in `fetch`. See `CONTEXT.md` for the domain vocabulary (Monitored Object, Send Trigger, Reported Baseline, Crossing Event, etc.) used throughout this file.

## Commands (once implemented)

- Run the monitor once: `bun run src/check.js` (or `bun run src/check.js --force` to bypass the 06:00–20:00 Astana working hours window)
- Run tests: `bun test`
- No build step, no linter configured yet — this is a single-script Bun project with built-in test runner.
- No npm/npx in this devcontainer (Bun-only image) — use `bunx` in place of `npx` for anything that needs it (e.g. the Perplexity MCP server config).
- Local runs need `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment (or a `.env` Bun loads automatically). Persisting state locally also needs `GITHUB_TOKEN` (a PAT with `repo` scope) and `GITHUB_REPOSITORY` (`owner/repo`) — see `.env.example`.

## Architecture

**State persistence across ephemeral runners**: GitHub Actions runners don't persist state between runs, so "did this change since last time" is tracked via the body of a dedicated GitHub Release (tagged `monitor-state`), read/written through the GitHub REST API using the workflow's own `GITHUB_TOKEN` (see `src/release-state.js` and `docs/adr/0001-release-body-for-state-persistence.md`). There is no external DB — this is the entire persistence layer. State used to be committed as `data/state.json` instead; that approach was dropped for the 25+ recurring "chore: update monitor state" commits it produced.

**File layout**:
- `config/objects.js` — monitored-object list (`PRICE_FLOOR`, `AVAILABILITY_THRESHOLD`, `OBJECTS`). Every entry today is shaped for BI Group's API specifically (`realEstateUUIDs`, `propertyTypes`) — it's not a generic plug-in point for other sources yet, see `docs/adr/0003-scope-bi-group-rebrand-to-docs.md`.
- `src/bi-api.js` — `fetchAllPlacements()`: paginates the BI Group API (`pageNo` starts at **1**, not 0) and validates every returned placement actually belongs to a requested `realEstateUUIDs` entry (guards against the API silently returning the wrong inventory on a bad request key). The only fetch adapter that exists; a different source would need a new one.
- `src/schedule.js` — Astana timezone (UTC+05:00) helpers, working-hours evaluation (06:00–20:00), and `isDigestDue()` (first run at/after 13:00 Astana each calendar day).
- `src/telegram.js` — `sendMessage(text)` via the Telegram Bot API; throws on non-OK so misconfigured secrets fail loudly.
- `src/release-state.js` — `readReleaseState()` / `writeReleaseState()`: get/patch the `monitor-state` release body via the GitHub REST API; `readReleaseState()` returns `null` (not a throw) when the release doesn't exist yet, which `check.js` treats as first run.
- `src/check.js` — main entrypoint: working hours check → fetch → evaluate against each object's Reported Baseline → send a Telegram message only if a Send Trigger is active (daily digest / change alert / run-gap watchdog — see `docs/adr/0002-baseline-diff-notification-triggers.md` and `CONTEXT.md`) → write updated state.
- `.github/workflows/monitor.yml` — `workflow_dispatch` (manual) + `repository_dispatch` (`external-cron`), needs `permissions: contents: write` to read/write the state release (the same permission already used for releases, no new secret).

**cron-job.org's `external-cron` dispatch is the sole automated trigger — do not re-diagnose this from scratch.** GitHub's native `schedule:` cron was removed: verified via the GitHub API that only ~3-9 of the ~24-28 daily runs the old cron expression implied actually fired, consistent with GitHub throttling `schedule:` events for new/low-trust accounts (anti-abuse measure). Running it alongside cron-job.org was redundant and made cadence unpredictable, so it's gone — the guarantee of ≥1 run/working-hour is now entirely the external cron-job.org job dispatching a `repository_dispatch` `external-cron` event every 30 minutes (`repository_dispatch` is an explicit API call, not a passive `schedule:` sweep, so it isn't subject to the same throttling). See README's "Guaranteeing ≥1 run per working-hour" section for the exact request shape and required PAT scope. `src/check.js` also tracks `lastRunAt` in state and treats a run gap over 90 minutes as its own independent Send Trigger (the Run-Gap Watchdog), so a broken external trigger (e.g. expired PAT) doesn't fail silently — this is now the only signal that the monitor has stopped running. Note this cadence (how often `check.js` runs) is independent of notification frequency (when it actually sends a Telegram message) — see the next section.

**Notifications are gated to three independent Send Triggers, not sent every run.** A run only messages Telegram if the Daily Digest is due (first run ≥13:00 Astana that day), a Change Alert fires (an object's min available price or available count differs, either direction, from its Reported Baseline — the values from the last message actually sent for it, not the previous run's values), or the Run-Gap Watchdog fires; multiple triggers on the same run merge into one message. A price/count change that crosses `PRICE_FLOOR`/`AVAILABILITY_THRESHOLD` is highlighted with 🔥 inside the Change Alert rather than being a separate alert path. Full rationale, the rejected alternatives (why baseline-diff instead of run-over-run diff, why crossings are folded in instead of kept separate), and the state-schema migration are in `docs/adr/0002-baseline-diff-notification-triggers.md`.

**Fetch failures never fail the Actions run.** `src/check.js` catches `fetchAllPlacements()` failures per object and keeps that object's previous Reported Baseline rather than treating the failure as zero availability. Only the transition matters for sending: starting to fail and recovering are each their own Send Trigger reason (`⚠️ Данные недоступны: <message>` / `✅ Данные снова доступны`); an object that's still failing on a run that sends for some other reason just rides along with an inline error line. The Actions run only fails on something the script genuinely can't recover from or report (e.g. Telegram itself unreachable).

### Non-obvious domain rules (already debugged in the spec — do not re-derive these from scratch)

- **Price field**: use `discount.stock.data[].priceWithDiscount` (minimum across entries if several), falling back to `totalPrice` only when `discount.stock.data` is empty. The top-level `totalPriceWithDiscount` field is unreliable (observed stale on real data). The fallback must check `discounts.length` explicitly — `Math.min(...discounts) || p.totalPrice` is a bug, since `Math.min()` of an empty array is `Infinity`, which is truthy.
- **Availability**: a placement counts as available when `isSale !== false`. Do **not** use `placementStatusName` for this — it records booking history, not current availability, and produces wrong results at Kerbez (which currently has zero `Свободно` placements despite having available units).
- **Request body**: the API key is `realEstateUUIDs` (array, plural) — sending `realEstateUUID` returns HTTP 200 with the wrong company-wide data instead of erroring, so always validate the response's real-estate UUIDs against the request. `companyIds` is not required and should be omitted. `pageNo` is 1-based; `pageNo: 0` returns HTTP 400.
- **An empty placement list is a failure, not an empty object.** A retired or mistyped-but-well-formed `realEstateUUID` returns HTTP 200 with `placements: []` (verified live) — which would flow into `availableCount = 0` and fire a false low-stock alert. `fetchAllPlacements` throws on zero placements so it takes the fetch-failure path instead.
- **Fetch failures must never be treated as zero placements/zero availability** — that would fire a false low-stock alert on a network hiccup. Skip evaluation for that object on failure instead.
- **First report for an object** alerts on anything already qualifying, not just future changes — a `null` Reported Baseline (no prior message sent) is treated as "changed" by definition, so a missing `monitor-state` release or a newly added object needs no special-casing.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues in `ansaganie/prices-monitor` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root (created lazily as needed). See `docs/agents/domain.md`.
