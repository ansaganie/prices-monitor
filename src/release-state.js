// Reads/writes the monitor's run state from a GitHub Release body instead of a
// committed file — see docs/adr/0001-release-body-for-state-persistence.md for why.
// Uses the workflow's existing GITHUB_TOKEN; releases are covered by the same
// `contents: write` permission as commits, so no new secret is needed.

const API_BASE = "https://api.github.com";
const RELEASE_TAG = "monitor-state";
const RELEASE_NAME = "Monitor state (do not delete)";
const REQUEST_TIMEOUT_MS = 20_000;

/** Split "owner/repo" (the shape GitHub Actions sets GITHUB_REPOSITORY to). */
export function parseRepository(repository) {
  const parts = (repository ?? "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`GITHUB_REPOSITORY must be in "owner/repo" form, got: ${JSON.stringify(repository)}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function readConfig(env) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN must be set to read/write monitor state");
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  return { token, owner, repo };
}

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Fetch the current state from the release body.
 * @returns {Promise<{ releaseId: number, state: object } | null>} `null` if the
 * release doesn't exist yet — a genuine first run, not an error.
 */
export async function readReleaseState(env = process.env) {
  const { token, owner, repo } = readConfig(env);

  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/releases/tags/${RELEASE_TAG}`, {
    headers: apiHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GET release "${RELEASE_TAG}" failed: HTTP ${res.status} ${res.statusText} ${detail}`.trim());
  }

  const release = await res.json();
  try {
    return { releaseId: release.id, state: JSON.parse(release.body ?? "") };
  } catch (error) {
    // Refuse to fall back to "empty state" here — that would replay every
    // already-sent alert, the same failure mode a missing/corrupt state file
    // would cause with the old commit-based storage.
    throw new Error(`Release "${RELEASE_TAG}" body is not valid JSON: ${error.message}`);
  }
}

/**
 * Persist `state` into the release body, creating the release on first use.
 * Pass the `releaseId` a prior `readReleaseState()` call returned to update it
 * in place; omit it (or pass null) only when no release exists yet.
 */
export async function writeReleaseState(state, releaseId, env = process.env) {
  const { token, owner, repo } = readConfig(env);
  const body = JSON.stringify(state, null, 2);

  const res =
    releaseId != null
      ? await fetch(`${API_BASE}/repos/${owner}/${repo}/releases/${releaseId}`, {
          method: "PATCH",
          headers: { ...apiHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      : await fetch(`${API_BASE}/repos/${owner}/${repo}/releases`, {
          method: "POST",
          headers: { ...apiHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify({ tag_name: RELEASE_TAG, name: RELEASE_NAME, body, prerelease: true }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const verb = releaseId != null ? "PATCH" : "POST";
    throw new Error(`${verb} release "${RELEASE_TAG}" failed: HTTP ${res.status} ${res.statusText} ${detail}`.trim());
  }
}
