#!/usr/bin/env node
/**
 * reddit-auth.mjs — one-time 3-legged OAuth helper that mints the long-lived
 * REDDIT_REFRESH_TOKEN consumed by scripts/lib/reddit-client.mjs.
 *
 * Why this exists (read before changing the auth mode):
 * getAccessToken() in scripts/lib/reddit-client.mjs has two modes, tried in
 * order — refresh_token, then username+password. Client id/secret ALONE are
 * not enough: with neither a refresh token nor a password the function falls
 * through to `no usable auth mode … skipping` and the poster silently no-ops.
 * The owner chose the refresh-token mode, so REDDIT_PASSWORD stays unset and
 * this helper is the only thing that produces the missing half.
 *
 * Usage:
 *   node scripts/reddit-auth.mjs             # full flow, local listener on :8080
 *   node scripts/reddit-auth.mjs --url-only  # only print the consent URL
 *
 * Required env (from Remote Config via `source bin/rc-env.sh`):
 *   REDDIT_CLIENT_ID              app client id
 *   REDDIT_CLIENT_SECRET          app secret — mapped in RC as
 *                                 SERVER_REDDIT_CLIENT_SECRET (RC_TO_ENV
 *                                 renames it; the RC-side name is the one
 *                                 with the SERVER_ prefix, both loaders agree)
 *
 * ── THE detail that makes or breaks this: duration=permanent ──────────────
 * Reddit issues a refresh_token ONLY when the authorize URL carries
 * `duration=permanent`. Omit it (or send `temporary`) and the consent screen
 * looks identical, the exchange succeeds, and you get an access_token that
 * dies in 1 hour with NO refresh_token — which is exactly the state this
 * helper exists to escape. There is no way to upgrade such a grant after the
 * fact; you have to re-run the whole consent flow. Do not "simplify" it away.
 *
 * ── Two more Reddit-specific traps ────────────────────────────────────────
 * - The token endpoint authenticates the APP with HTTP Basic
 *   (base64 "client_id:client_secret"), not with client_id/client_secret in
 *   the form body. Sending them in the body returns 401 with an empty-ish
 *   payload that reads like a wrong secret. reddit-client.mjs already does
 *   Basic; this file matches it deliberately.
 * - Reddit rejects or throttles requests without a real User-Agent. We reuse
 *   userAgent() from lib/reddit-client.mjs so the helper and the poster are
 *   never identified differently.
 *
 * ── On the "script" app type ──────────────────────────────────────────────
 * A Reddit app of type "script" can run this authorization-code flow, but the
 * grant only works for accounts listed as developers of the app. That is fine
 * here because we authorize as the app owner (the automation account itself).
 * If the app is ever re-created as a "web app", nothing in this file changes
 * except that non-developer accounts could also consent.
 *
 * The redirect_uri below must match the one registered on the app BYTE FOR
 * BYTE — Reddit compares it as an opaque string, and a trailing slash or a
 * 127.0.0.1-vs-localhost difference is enough to fail with invalid_grant.
 *
 * Exit code is 0 on the happy path and 1 on an explicit auth failure — this is
 * an interactive one-shot tool, not a CI step.
 */

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

import { userAgent } from './lib/reddit-client.mjs';

const AUTHORIZE_ENDPOINT = 'https://www.reddit.com/api/v1/authorize';
const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';

const CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || '';
const REDIRECT_URI =
  process.env.REDDIT_REDIRECT_URI || 'http://localhost:8080/callback';

/**
 * identity → confirm which account consented (guards against authorizing
 *            while logged in as the wrong user, which is easy and silent)
 * submit   → create posts (submitPost)
 * flair    → submitPost sends flair_id / flair_text from the registry
 * read     → read listings, used when checking whether a post survived
 */
const SCOPE = process.env.REDDIT_SCOPE || 'identity submit flair read';
const PORT = Number(new URL(REDIRECT_URI).port || 8080);

const urlOnly = process.argv.includes('--url-only');

function buildAuthUrl(state) {
  const u = new URL(AUTHORIZE_ENDPOINT);
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('duration', 'permanent'); // see header — mandatory
  u.searchParams.set('scope', SCOPE);
  return u.toString();
}

async function exchangeCode(code) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent(),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/** Confirm which account actually consented. Non-fatal if it fails. */
async function whoAmI(accessToken) {
  try {
    const res = await fetch('https://oauth.reddit.com/api/v1/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': userAgent(),
      },
    });
    if (!res.ok) return null;
    const me = await res.json();
    return me?.name || null;
  } catch {
    return null;
  }
}

async function main() {
  if (!CLIENT_ID) {
    console.error('⚠️  REDDIT_CLIENT_ID is not set.');
    console.error('    Run `source bin/rc-env.sh` from the workspace root first.');
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = buildAuthUrl(state);

  console.log('─── Reddit OAuth (refresh-token mode) ───');
  console.log(`client_id:    ${CLIENT_ID}`);
  console.log(`redirect_uri: ${REDIRECT_URI}`);
  console.log(`scope:        ${SCOPE}`);
  console.log('duration:     permanent  ← required for a refresh_token');
  console.log('');
  console.log('Open this URL, check you are logged in as the automation account,');
  console.log('and press Allow:');
  console.log(authUrl);
  console.log('');

  if (urlOnly) return;

  if (!CLIENT_SECRET) {
    console.error('⚠️  REDDIT_CLIENT_SECRET is not set — cannot exchange the code.');
    console.error('    In Remote Config the parameter is SERVER_REDDIT_CLIENT_SECRET.');
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
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (err) {
        res.end(`Reddit returned an error: ${err}. You can close this tab.`);
        server.close();
        reject(new Error(`authorization denied: ${err}`));
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

  const tokens = await exchangeCode(code);
  const who = await whoAmI(tokens.access_token);

  console.log('');
  if (who) console.log(`✅ consented as u/${who}`);
  console.log('');

  if (tokens.refresh_token) {
    console.log('✅ Store this in Firebase Remote Config:');
    console.log(`SERVER_REDDIT_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('');
    console.log('   (RC_TO_ENV maps SERVER_REDDIT_REFRESH_TOKEN → REDDIT_REFRESH_TOKEN,');
    console.log('    which is what reddit-client.mjs reads. Store the SERVER_ name.)');
  } else {
    console.error('❌ No refresh_token in the response.');
    console.error('   The grant was almost certainly issued as duration=temporary.');
    console.error('   Re-run this helper — the URL it prints sets duration=permanent.');
    process.exitCode = 1;
  }

  console.log('');
  console.log(`access_token expires_in: ${tokens.expires_in}s`);
  console.log(`scope granted: ${tokens.scope || SCOPE}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
