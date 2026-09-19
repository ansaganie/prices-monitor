# Store run-state in a GitHub Release body instead of committing it

Status: accepted

`data/state.json` (the JSON blob `check.js` uses to detect price/availability changes between runs) was committed back to `main` after every workflow run, producing 25+ recurring "chore: update monitor state" commits and needing a `git pull --rebase && push` step that's a source of fragility. We now write that JSON into a GitHub Release's `body` field instead, updated via `PATCH /repos/{owner}/{repo}/releases/{release_id}` using the workflow's existing `GITHUB_TOKEN` (its `contents: write` permission already covers releases) — no new secret, no git-history pollution, and releases aren't subject to eviction.

## Considered Options

- **GitHub Actions cache**: purpose-built for key→blob persistence, but cache keys are immutable (updating requires delete-then-save every run) and GitHub gives no durability guarantee — an unexpected eviction would silently reset state and replay already-sent Telegram alerts. Rejected: a correctness risk, not just a style concern.
- **GitHub Release asset** (an uploaded file) instead of the body field: works, but re-uploading requires deleting the old asset first (`422` on name collision) — more API calls than editing the body for no benefit.
- **GitHub Gist**: requires a brand-new PAT scoped to `gist` specifically (the existing `contents:write` token doesn't cover it) — costs a new secret.
- **Upstash Redis** / **Cloudflare KV**: both genuinely free-forever and reachable via plain `fetch` with no SDK, but both need a new third-party account + secret that the Release-body approach avoids entirely.
- **jsonbin.io**: rejected outright — its "free tier" is a lifetime 10,000-request cap (not renewing), which would run out in roughly 3-4 months at this cadence.

## Consequences

Implemented: `src/release-state.js` reads/writes the `monitor-state` release body (`readReleaseState()` returns `null` on a genuine first run rather than throwing), `src/check.js` calls it instead of touching a file, and `.github/workflows/monitor.yml` no longer commits `data/state.json` — the "Commit state" step and its `git pull --rebase && push` are gone, and the "Check listings" step gets `GITHUB_TOKEN` in its `env:`. `data/state.json` is removed from the repo. Scope is limited to this one state file, not a general persistence layer for future features. The existing `lastRunAt` run-gap watchdog semantics are unaffected — only the storage mechanism changed, not what's stored.
