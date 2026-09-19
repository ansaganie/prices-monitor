# BI Parking Price Monitor

Watches parking listings at two BI Group complexes in Astana — **Jetisu Satti** and
**Jetisu Kerbez Comfort** — sends a status report to Telegram after each scan, and highlights alerts when either:

- an **available** unit's price drops to **≤ 2 200 000 ₸**, or
- the number of **available** units for an object falls **below 20**.

No server, no database, no npm dependencies. It's a single Bun script run by GitHub
Actions every 30 minutes during Astana working hours (06:00 to 20:00 UTC+05:00), using BI Group's own public JSON API.

Alert details within the report are **edge-triggered**: you're alerted when a condition newly becomes true, or
when it gets worse (a new unit crosses the floor, the count drops further).

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts.
2. Copy the token it gives you — that's `TELEGRAM_BOT_TOKEN`.
3. Send any message to your new bot (a bot cannot open a chat with you first).
4. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and copy
   `result[0].message.chat.id` — that's `TELEGRAM_CHAT_ID`.

### 2. Configure the repository

1. Push this repo to GitHub. A **public** repo gets unlimited free Actions minutes.
2. **Settings → Secrets and variables → Actions → New repository secret**, add both
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
3. **Settings → Actions → General → Workflow permissions** → select
   **Read and write permissions**. Without this the workflow can't read/write the
   `monitor-state` release and every run re-alerts.
4. **Actions** tab → *Monitor parking listings* → **Run workflow** to test it.

### 3. Run it locally (optional)

```sh
cp .env.example .env      # fill in Telegram + GitHub values — Bun loads .env automatically
bun run src/check.js
```

Run state lives in a GitHub Release body (see "How it works" below), so local
runs need `GITHUB_TOKEN` (a PAT with `repo` scope, or fine-grained
Contents: Read & Write) and `GITHUB_REPOSITORY` in `.env` too — both are set
automatically in the Actions environment.

Set `DRY_RUN=1` to print the alert to stdout instead of sending it:

```sh
DRY_RUN=1 bun run src/check.js
```

Outside working hours (06:00–20:00 Astana time), `check.js` will skip execution. Pass `--force` or `FORCE_RUN=1` to run regardless of time:

```sh
bun run src/check.js --force
```

## How it works

```
config/objects.js     what to watch: UUIDs, price floor, availability threshold
src/bi-api.js         paginated fetch of BI Group's placementList endpoint
src/telegram.js       sendMessage() via the Telegram Bot API
src/release-state.js  read/write run state via the GitHub Releases API
src/check.js          fetch → evaluate → diff vs. previous state → notify → save state
```

GitHub Actions runners are ephemeral, so "has this changed since last time?" is
answered by persisting state in the body of a dedicated GitHub Release
(tagged `monitor-state`), updated via `PATCH /repos/{owner}/{repo}/releases/{id}`
using the workflow's own `GITHUB_TOKEN` — no committed file, no git-history
pollution, no new secret. See
[`docs/adr/0001-release-body-for-state-persistence.md`](docs/adr/0001-release-body-for-state-persistence.md)
for why.

## Adding another object

Append an entry to `OBJECTS` in [`config/objects.js`](config/objects.js):

```js
{
  id: "some-stable-id",          // never change this once it's live — it keys the state
  name: "Display name",
  realEstateUUIDs: ["…"],
  propertyTypes: [PARKING_PROPERTY_TYPES],
  url: "https://bi.group/…",
}
```

To find the UUIDs: open that complex's picker on bi.group in a browser, open devtools
→ Network, and read `realEstateUUIDs` and `propertyTypes` out of the POST body sent to
`apigw.bi.group/sales-picker/microfe-v3/placementList`.

Thresholds live in the same file (`PRICE_FLOOR`, `AVAILABILITY_THRESHOLD`), and the
schedule is the `cron` line in [`.github/workflows/monitor.yml`](.github/workflows/monitor.yml).

## Assumptions worth knowing

These were each verified against live API data, and some are counter-intuitive.

- **Price** comes from `discount.stock.data[].priceWithDiscount` (the minimum, if there
  are several entries), falling back to `totalPrice` only when no discount is active.
  The top-level `totalPriceWithDiscount` field is **not** used — it was observed stale
  at Kerbez, reporting the undiscounted price for a unit that was 50% off.
- **"Available" means `isSale !== false`.** It is *not* based on
  `placementStatusName`, which records booking *history* rather than current
  availability: Kerbez has **zero** units marked `Свободно` despite 74 being on sale,
  so a status-based rule would fire a permanent, wrong low-stock alert there.
- **Fetch failures are never counted as zero, and never fail the Actions run.** If an
  object can't be fetched, it's skipped for that run and its previous numbers are kept,
  so a network hiccup can't masquerade as "everything sold out". The failure is
  reported inline in the Telegram scan report (`⚠️ Данные недоступны: ...`) — the
  script absorbs it rather than exiting non-zero, so the Actions run still shows green.
  You get one alert when an object starts failing and one when it recovers — not one
  per run.
- **The first run alerts on whatever already qualifies**, not only on future changes,
  since no `monitor-state` release yet means "nothing seen yet".
- **Schedule is every 30 minutes during Astana working hours (06:00 to 20:00 UTC+05:00 / 01:00 to 15:00 UTC)**.
  cron-job.org is the *only* automated trigger — see "Keeping the workflow alive" below.
  GitHub's native `schedule:` cron was tried and removed: it was unreliable for this
  repo (observed as low as 3 of the ~28 expected daily runs actually firing, consistent
  with GitHub throttling `schedule:` events for new/low-trust accounts), and running it
  alongside cron-job.org was redundant once cron-job.org proved reliable on its own.
  Runs outside working hours can still be triggered manually via `workflow_dispatch`
  (with the `force` input) or with `--force` / `FORCE_RUN=1` locally.

## Keeping the workflow alive

GitHub **disables scheduled workflows after 60 days of repository inactivity**. To
guard against a long quiet stretch switching the monitor off with no warning, the
persisted state carries a `keepAliveAt` timestamp that's refreshed every 14 days
(see [`docs/adr/0001-release-body-for-state-persistence.md`](docs/adr/0001-release-body-for-state-persistence.md)
for where state now lives).

If the monitor ever does go quiet for months, check the **Actions** tab for a
"this workflow was disabled" banner and re-enable it there.

### Guaranteeing ≥1 run per working-hour

GitHub's own `schedule:` cron proved unreliable for this repo (see the assumption
above) and has been removed — an external service, [cron-job.org](https://cron-job.org),
is now the *only* automated trigger. It pings the workflow directly via GitHub's REST
API every 30 minutes during working hours:

- `POST https://api.github.com/repos/<owner>/<repo>/dispatches`
- Headers: `Authorization: Bearer <fine-grained PAT>`, `Accept: application/vnd.github+json`
- Body: `{"event_type": "external-cron"}`
- Restricted to `01:00`–`14:40` UTC (Astana's working hours), offset from GitHub's own
  `:17`/`:47` schedule so the two trigger sources spread across ~4 time points/hour.

The PAT needs only the **Contents: Read & Write** repository permission (Metadata:
Read is auto-included), scoped to this one repo — that's what the dispatches endpoint
requires. Enable cron-job.org's "notify on failure" email so an expired token or a
renamed repo surfaces immediately instead of silently.

As a second line of defense, `src/check.js` tracks `lastRunAt` in the persisted state
and prepends a `⚠️ Предыдущий запуск был давно` warning to the next report if more
than 90 minutes passed since the previous run — catching the case where a trigger
fires late rather than not at all.

## Unit deep links

BI Group's API returns no per-unit URL, and `bi.group` rejects non-browser clients, so
the exact "open this parking spot" link couldn't be derived. Alerts therefore link to
each complex's landing page. If you find the URL pattern that opens a specific
placement (check the address bar while clicking a unit in the picker), put it in the
`url` field in `config/objects.js` and the alerts will use it.
