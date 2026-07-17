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

function warnExit(msg) {
  console.log(`::warning::mint-app-token: ${msg} — APP_TOKEN not set, callers fall back to GITHUB_PAT/GITHUB_TOKEN.`);
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
  console.log(`mint-app-token: minted installation token for ${repo} (expires ${tok.body.expires_at}).`);
}

// CLI-only (so buildAppJwt stays unit-testable in isolation).
if (process.argv[1] && process.argv[1].endsWith('mint-app-token.mjs')) {
  main().catch((e) => warnExit(`unexpected error (${String(e?.message || e).slice(0, 80)})`));
}
