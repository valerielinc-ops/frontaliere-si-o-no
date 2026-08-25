#!/usr/bin/env node
/**
 * tiktok-auth.mjs — one-time OAuth helper that mints the tokens
 * scripts/post-to-tiktok.mjs needs (TIKTOK_ACCESS_TOKEN / TIKTOK_REFRESH_TOKEN).
 *
 * Modeled on scripts/linkedin-member-auth.mjs, adapted for TikTok's specifics:
 *
 * ── Desktop flow, not Web flow ────────────────────────────────────────────
 * TikTok's web OAuth flow requires an HTTPS redirect_uri registered on a
 * verified domain — this repo has no server to host a callback on. The
 * "Desktop" flow variant instead allows an http://localhost (or 127.0.0.1)
 * redirect_uri with an explicit port, at the cost of requiring PKCE. That is
 * a strictly better fit for a local one-shot script than standing up
 * infrastructure just to receive one redirect, so this helper always uses it
 * — same "local HTTP listener catches the redirect" shape as the LinkedIn
 * helper, just with PKCE added.
 *
 * ── PKCE: hex, not base64url ──────────────────────────────────────────────
 * TikTok's code_challenge is the HEX-encoded SHA-256 of code_verifier — most
 * OAuth PKCE implementations (and libraries) use base64url. Sending a
 * base64url challenge here fails silently at the consent screen with a
 * generic error, not a helpful one — verified against TikTok's own Login Kit
 * Desktop docs before writing buildCodeChallenge() below.
 *
 * ── Sandbox by default ─────────────────────────────────────────────────────
 * TikTok's own guidance for apps still under review: sandbox mode is "your
 * recording studio" — you can run the complete OAuth + posting flow before
 * audit, every post just lands SELF_ONLY regardless of the requested privacy
 * level, and a production run pre-audit is forced to the exact same
 * restriction anyway. Defaulting here to TIKTOK_SANDBOX_CLIENT_KEY/_SECRET
 * means the ordinary happy path never risks touching whatever state the
 * production app is in. Pass --prod to target the production app instead —
 * needed once TikTok's audit has passed and public posting should start
 * working for real.
 *
 * ── Sandbox target users ───────────────────────────────────────────────────
 * A sandbox app only accepts consent from TikTok accounts explicitly added
 * as target users on the app's Sandbox page in the developer portal (up to
 * ten). Add the account you're about to authorize there FIRST, or the
 * consent screen rejects it — this helper cannot do that step for you.
 *
 * Usage:
 *   node scripts/tiktok-auth.mjs                 # sandbox app, full flow
 *   node scripts/tiktok-auth.mjs --prod           # production app
 *   node scripts/tiktok-auth.mjs --url-only        # just print the consent URL
 *   node scripts/tiktok-auth.mjs --scope=user.info.basic,video.publish
 *
 * Required env (from Remote Config via `source bin/rc-env.sh` at the
 * workspace root, or `node scripts/load-rc-env.mjs` from this repo):
 *   TIKTOK_SANDBOX_CLIENT_KEY / TIKTOK_SANDBOX_CLIENT_SECRET   (default)
 *   TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET                   (--prod)
 *
 * What it prints at the end is what to store in Firebase Remote Config —
 * under the RC param names (SERVER_TIKTOK_ACCESS_TOKEN /
 * SERVER_TIKTOK_REFRESH_TOKEN), not the process.env names — ONLY when run
 * with --prod: a sandbox token is for recording the app-review demo video
 * and local testing, not for the daily cron, so storing it in RC would let
 * the poster silently run against sandbox (SELF_ONLY forever) once the app
 * passes audit and nobody remembers to re-run this with --prod.
 *
 * Exit code is 0 on the happy path and 1 only on an explicit auth failure —
 * this is an interactive one-shot tool, not a CI step.
 */

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

import { TIKTOK_API } from './lib/tiktok-publish.mjs';

const isProd = process.argv.includes('--prod');
const urlOnly = process.argv.includes('--url-only');
const scopeArg = process.argv.find((a) => a.startsWith('--scope='));

const CLIENT_KEY = isProd
  ? process.env.TIKTOK_CLIENT_KEY || ''
  : process.env.TIKTOK_SANDBOX_CLIENT_KEY || '';
const CLIENT_SECRET = isProd
  ? process.env.TIKTOK_CLIENT_SECRET || ''
  : process.env.TIKTOK_SANDBOX_CLIENT_SECRET || '';

// video.publish covers both the video and the photo/carousel Content Posting
// API (see scripts/post-to-tiktok.mjs) — user.info.basic is added so
// creator_info/query (called before every post) has a scope to run under.
const SCOPE = scopeArg ? scopeArg.split('=')[1] : 'user.info.basic,video.publish';

// Trailing-slash path REQUIRED: TikTok's own Login Kit Desktop doc
// (developers.tiktok.com/docs/en/login-kit-desktop) lists valid examples as
// `http://localhost:3455/callback/` / `https://127.0.0.1:3455/callback/` —
// scheme, port, AND a trailing-slash path, all four required verbatim. A bare
// `http://localhost:PORT` (no path) was tried first based on a third-party
// summary and got `error_type=redirect_uri` from the live authorize call even
// after being registered — TikTok's own doc is the source of truth here, not
// search-result summaries of it. The registered value in the app's Login Kit
// config (Manage apps → app → Sandbox → Products → Login Kit → Desktop tab)
// MUST equal this string byte-for-byte, trailing slash included.
const REDIRECT_URI = process.env.TIKTOK_AUTH_REDIRECT_URI || 'http://localhost:8083/callback/';
const PORT = Number(new URL(REDIRECT_URI).port || 8083);

const AUTH_ENDPOINT = 'https://www.tiktok.com/v2/auth/authorize/';
// The API host comes from the shared publish layer rather than a third literal
// copy: post-to-tiktok.mjs, this helper and check-social-publish-readiness.mjs
// all talk to the same base, and a version bump that misses one of them is
// exactly the drift AGENTS.md #6 asks to make impossible by construction.
const TOKEN_ENDPOINT = `${TIKTOK_API}/oauth/token/`;

/** code_verifier: 43-128 char unreserved-charset random string (RFC 7636). */
function buildCodeVerifier() {
  return crypto.randomBytes(64).toString('base64url').slice(0, 128);
}

/**
 * TikTok's code_challenge is the HEX-encoded SHA-256 digest of
 * code_verifier — NOT the base64url encoding most PKCE implementations use.
 * Getting this wrong fails at the consent screen with no useful error.
 */
function buildCodeChallenge(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier).digest('hex');
}

function buildAuthUrl({ state, codeChallenge }) {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set('client_key', CLIENT_KEY);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

async function exchangeCode(code, codeVerifier) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  if (!CLIENT_KEY) {
    console.error(
      `⚠️  ${isProd ? 'TIKTOK_CLIENT_KEY' : 'TIKTOK_SANDBOX_CLIENT_KEY'} is not set.`,
    );
    console.error('    Run `source bin/rc-env.sh` from the workspace root first.');
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = buildCodeVerifier();
  const codeChallenge = buildCodeChallenge(codeVerifier);
  const authUrl = buildAuthUrl({ state, codeChallenge });

  console.log(`─── TikTok OAuth (${isProd ? 'PRODUCTION' : 'SANDBOX'} app) ───`);
  console.log(`client_key:    ${CLIENT_KEY}`);
  console.log(`redirect_uri:  ${REDIRECT_URI}`);
  console.log(`scope:         ${SCOPE}`);
  console.log('');
  console.log(`⚠️  This exact redirect_uri (or a matching http://localhost:* wildcard)`);
  console.log('   must be registered in the Login Kit product config for this app on');
  console.log('   developers.tiktok.com (Manage apps → your app → Login Kit → Redirect');
  console.log('   URI) BEFORE the consent screen will accept it — TikTok rejects an');
  console.log('   unregistered one with a generic "app settings" error.');
  if (!isProd) {
    console.log('');
    console.log('⚠️  Sandbox: the TikTok account you sign in with must already be added');
    console.log('   as a target user on this app\'s Sandbox page in the developer portal.');
  }
  console.log('');
  console.log('Open this URL, sign in, and press Allow:');
  console.log(authUrl);
  console.log('');

  if (urlOnly) return;

  if (!CLIENT_SECRET) {
    console.error(
      `⚠️  ${isProd ? 'TIKTOK_CLIENT_SECRET' : 'TIKTOK_SANDBOX_CLIENT_SECRET'} is not set — cannot exchange the code.`,
    );
    process.exit(1);
  }

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
      if (reqUrl.pathname !== new URL(REDIRECT_URI).pathname) {
        res.writeHead(404).end('not the callback path');
        return;
      }
      const got = reqUrl.searchParams.get('code');
      const gotState = reqUrl.searchParams.get('state');
      const err = reqUrl.searchParams.get('error');
      const errDescription = reqUrl.searchParams.get('error_description');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (err) {
        res.end(`TikTok returned an error: ${err} (${errDescription || 'no description'}). You can close this tab.`);
        server.close();
        reject(new Error(`authorization denied: ${err} — ${errDescription || ''}`));
        return;
      }
      if (gotState !== state) {
        res.end('state mismatch — aborted. You can close this tab.');
        server.close();
        reject(new Error('state mismatch (possible CSRF) — aborted'));
        return;
      }
      res.end('Authorization received. You can close this tab.');
      server.close();
      resolve(got);
    });
    server.listen(PORT, () => console.log(`⏳ waiting for the callback on port ${PORT}…`));
    server.on('error', reject);
  });

  // TikTok's docs note the code should be URL-decoded before exchange;
  // URLSearchParams.get() above already decodes it.
  const tokens = await exchangeCode(code, codeVerifier);

  console.log('');
  if (isProd) {
    console.log('✅ Store these in Firebase Remote Config:');
    console.log(`SERVER_TIKTOK_ACCESS_TOKEN=${tokens.access_token}`);
    console.log(`SERVER_TIKTOK_REFRESH_TOKEN=${tokens.refresh_token || '(none returned)'}`);
  } else {
    console.log('✅ Sandbox tokens (for the app-review demo video / local testing):');
    console.log(`TIKTOK_ACCESS_TOKEN=${tokens.access_token}`);
    console.log(`TIKTOK_REFRESH_TOKEN=${tokens.refresh_token || '(none returned)'}`);
    console.log('');
    console.log('Do NOT store these under the SERVER_TIKTOK_* RC params — those feed the');
    console.log('production daily cron. Export them in your shell instead, e.g.:');
    console.log('');
    console.log(`  TIKTOK_ACCESS_TOKEN='${tokens.access_token}' \\`);
    console.log(`  TIKTOK_CLIENT_KEY='${CLIENT_KEY}' TIKTOK_CLIENT_SECRET='${CLIENT_SECRET}' \\`);
    console.log(`  TIKTOK_REFRESH_TOKEN='${tokens.refresh_token || ''}' \\`);
    console.log('  node scripts/post-to-tiktok.mjs --only=job');
  }
  console.log('');
  console.log(`expires_in: ${tokens.expires_in}s (~${Math.round(tokens.expires_in / 3600)}h)`);
  if (tokens.refresh_expires_in) {
    console.log(
      `refresh_expires_in: ${tokens.refresh_expires_in}s (~${Math.round(tokens.refresh_expires_in / 86400)}d)`,
    );
  }
  console.log(`scope granted: ${tokens.scope || SCOPE}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
