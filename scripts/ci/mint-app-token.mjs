/**
 * mint-app-token.mjs — mint a short-lived GitHub App installation token (zero-dep).
 *
 * Replaces the manually-maintained `GITHUB_PAT` for the autonomous loop's
 * push/merge/dispatch identity. Unlike a PAT, an App installation token:
 *   - auto-mints per run (no expiry to babysit),
 *   - acts as the App identity `<app-slug>[bot]` (NOT `github-actions[bot]`), so
 *     its events DO re-trigger downstream workflows (the GITHUB_TOKEN
 *     anti-recursion does not apply) — the whole reason the PAT existed.
 *
 * We mint it with a tiny RS256 JWT + the REST API (node:crypto, global fetch on
 * Node 22) instead of `actions/create-github-app-token@v1`, which runs on Node 20
 * and would fail the repo's `lint:gha-node-runtime` gate (minNode 24).
 *
 * Scopes the token to THIS repo only. On success: masks it and appends
 * `APP_TOKEN=<token>` to $GITHUB_ENV. Missing/invalid App creds → warn + exit 0
 * (no APP_TOKEN written) so callers fall back to GITHUB_PAT/GITHUB_TOKEN.
 *
 * ─── `APP_TOKEN_WORKFLOWS`: capability VERIFIED, not asserted (issue #5288) ──────────
 *
 * A minted token is NOT proof of what that token can do. The `access_tokens` response
 * carries the installation's ACTUAL granted `permissions`, and an App permission that
 * the owner has requested but never approved on the installation simply does not appear
 * there — the mint still returns 201 and a perfectly usable token.
 *
 * issue-fix.yml used to infer `workflows: write` from the mere PRESENCE of APP_TOKEN:
 * the pre-flight capability guard was gated on `env.APP_TOKEN == ''`, and the agent
 * prompt told the fixer "this run's token HAS the `workflows` scope, treat those files
 * normally". When the installation lacked the permission, that assertion was false and
 * the failure surfaced only at the very END of the run, at `git push`:
 *
 *   ! [remote rejected] fix/issue-5280 -> fix/issue-5280 (refusing to allow a GitHub App
 *     to create or update workflow `.github/workflows/hydrated-article-parity.yml`
 *     without `workflows` permission)
 *
 * — verbatim from issue #5280 (2026-08-07), whose comment adds "despite the run setup
 * asserting otherwise". Cost: a full diagnosis + implementation (~1M tokens) thrown away
 * per run, i.e. exactly the burn escalation #3887 had already eliminated with a
 * deterministic zero-Claude guard, silently reintroduced by trusting presence for
 * capability.
 *
 * So this script now READS `tok.body.permissions` and publishes the answer as a separate
 * env var, `APP_TOKEN_WORKFLOWS=true|false`. APP_TOKEN itself is still written whenever a
 * token was minted — deliberately: ~23 workflows use it purely as a push/dispatch IDENTITY
 * (the App acts as `<app-slug>[bot]`, so its events re-trigger downstream workflows) and
 * would regress to `github-actions[bot]` if a missing `workflows` grant suppressed the
 * token wholesale. Only the `workflows`-specific claim is downgraded, and only for the
 * callers that make it.
 *
 * Fail-closed by construction: every path that does NOT reach a successful mint leaves
 * `APP_TOKEN_WORKFLOWS=false` (warnExit writes it explicitly), and a consumer reading an
 * UNSET var also sees something other than `'true'`. There is no way to arrive at
 * "capability granted" without the API having said so.
 *
 * Env: APP_ID, APP_PRIVATE_KEY (PEM), GITHUB_REPOSITORY (owner/repo).
 * Usage: node scripts/ci/mint-app-token.mjs
 */
import { createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';

const API = 'https://api.github.com';

/**
 * Build a signed RS256 JWT for GitHub App auth (10-min window, 60s clock-skew).
 * Pure + testable (no I/O, caller passes nowSec).
 * @param {string} appId
 * @param {string} privateKeyPem
 * @param {number} nowSec current time in seconds
 * @returns {string} the JWT
 */
export function buildAppJwt(appId, privateKeyPem, nowSec) {
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64u({ alg: 'RS256', typ: 'JWT' });
  // iat back-dated 60s to tolerate clock skew; exp 9min (< the 10min max).
  const payload = b64u({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign(privateKeyPem).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

async function ghJson(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: githubApiHeaders(token, { 'User-Agent': 'mint-app-token' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * Does this installation-token `permissions` object actually grant `workflows: write`?
 *
 * Pure + exported so the two branches that matter (granted / not granted) are unit
 * testable without the network. GitHub omits a permission entirely when it is not
 * granted on the installation, and a read-only grant would still be rejected by the
 * push-time workflow check — so only the literal `'write'` counts. Anything
 * missing/undefined/malformed → false (fail-closed).
 *
 * @param {Record<string, string>|null|undefined} permissions `tok.body.permissions`
 * @returns {boolean}
 */
export function hasWorkflowsWrite(permissions) {
  return permissions?.workflows === 'write';
}

/**
 * Publish the VERIFIED workflows capability to $GITHUB_ENV so downstream steps can gate
 * on `env.APP_TOKEN_WORKFLOWS == 'true'` instead of inferring it from `env.APP_TOKEN != ''`.
 * Written on every exit path, so "unset" is never the way a consumer learns the answer.
 */
function setWorkflowsCapability(granted) {
  const out = process.env.GITHUB_ENV;
  if (out) appendFileSync(out, `APP_TOKEN_WORKFLOWS=${granted ? 'true' : 'false'}\n`);
}

function warnExit(msg) {
  console.log(`::warning::mint-app-token: ${msg} — APP_TOKEN not set, callers fall back to GITHUB_PAT/GITHUB_TOKEN.`);
  setWorkflowsCapability(false);
  process.exit(0);
}

async function main() {
  const appId = process.env.APP_ID || '';
  const pem = process.env.APP_PRIVATE_KEY || '';
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!appId || !pem) warnExit('APP_ID or APP_PRIVATE_KEY missing');
  if (!repo || !repo.includes('/')) warnExit('GITHUB_REPOSITORY missing/invalid');
  const [owner, name] = repo.split('/');

  let jwt;
  try {
    jwt = buildAppJwt(appId, pem, Math.floor(Date.now() / 1000));
  } catch (e) {
    warnExit(`JWT build failed (${String(e?.message || e).slice(0, 80)})`);
  }

  // Installation for THIS repo.
  const inst = await ghJson(`/repos/${owner}/${name}/installation`, { token: jwt });
  if (inst.status !== 200 || !inst.body?.id) {
    warnExit(`no installation for ${repo} (status ${inst.status})`);
  }

  // Token scoped to THIS repo only (least privilege).
  const tok = await ghJson(`/app/installations/${inst.body.id}/access_tokens`, {
    token: jwt,
    method: 'POST',
    body: { repositories: [name] },
  });
  if (tok.status !== 201 || !tok.body?.token) {
    warnExit(`token mint failed (status ${tok.status})`);
  }

  const token = tok.body.token;
  // Mask in logs BEFORE exposing it anywhere.
  console.log(`::add-mask::${token}`);
  const out = process.env.GITHUB_ENV;
  if (out) appendFileSync(out, `APP_TOKEN=${token}\n`);

  // The response's own `permissions` is the only authority on what this token can do —
  // see the module docstring (#5288). Never infer it from the mint having succeeded.
  const workflowsWrite = hasWorkflowsWrite(tok.body.permissions);
  setWorkflowsCapability(workflowsWrite);
  if (!workflowsWrite) {
    console.log(
      '::warning::mint-app-token: the installation token does NOT carry `workflows: write` ' +
        `(granted: ${Object.keys(tok.body.permissions || {}).sort().join(', ') || 'none'}). ` +
        'Pushes touching .github/workflows/** WILL be rejected. Approve the pending permission ' +
        'request for this App installation at github.com/settings/installations. ' +
        'APP_TOKEN_WORKFLOWS=false — capability-gated steps degrade automatically.',
    );
  }
  console.log(
    `mint-app-token: minted installation token for ${repo} (expires ${tok.body.expires_at}; ` +
      `workflows=${workflowsWrite ? 'write' : 'not granted'}).`,
  );
}

// CLI-only (so buildAppJwt stays unit-testable in isolation).
if (process.argv[1] && process.argv[1].endsWith('mint-app-token.mjs')) {
  main().catch((e) => warnExit(`unexpected error (${String(e?.message || e).slice(0, 80)})`));
}
