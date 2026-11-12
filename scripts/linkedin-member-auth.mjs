#!/usr/bin/env node
/**
 * linkedin-member-auth.mjs — one-time 3-legged OAuth helper for the MEMBER
 * (personal profile) LinkedIn surface.
 *
 * This is NOT the Company Page path. scripts/post-to-linkedin.mjs posts as
 * `urn:li:organization:<id>` with w_organization_social (Community Management
 * API — access currently denied, appeal CAS-11756532-G7J8T5). This helper and
 * scripts/post-to-linkedin-member.mjs post as `urn:li:person:<id>` with
 * w_member_social ("Share on LinkedIn" product, already provisioned).
 * They are deliberately separate files: different author URN, different scope,
 * different token, different failure modes.
 *
 * Usage:
 *   node scripts/linkedin-member-auth.mjs            # full flow, opens a local listener
 *   node scripts/linkedin-member-auth.mjs --url-only # just print the consent URL
 *
 * Required env (from Remote Config via `source bin/rc-env.sh`):
 *   LINKEDIN_MEMBER_CLIENT_ID       app client id      (78ikswckn74d2t)
 *   LINKEDIN_MEMBER_CLIENT_SECRET   app primary secret
 *
 * What it prints at the end is what has to be stored in Remote Config:
 *   LINKEDIN_MEMBER_ACCESS_TOKEN    ~60 days (app is configured for 5184000s)
 *   LINKEDIN_MEMBER_REFRESH_TOKEN   ~1 year, only if the app has refresh enabled
 *   LINKEDIN_MEMBER_URN             urn:li:person:<sub>, see the note below
 *
 * ── Member identity and least scope ─────────────────────────────────────
 * This publishing flow requests only `w_member_social`. The profile/post
 * analytics permissions are separate and are not available to this app; adding
 * them to the default request makes LinkedIn reject OAuth before consent.
 * The publisher uses the configured LINKEDIN_MEMBER_URN. `/v2/userinfo` is
 * attempted opportunistically, but without an OIDC scope the configured URN
 * remains authoritative. If it is missing, the posting script soft-skips.
 *
 * Exit code is 0 on the happy path and 1 only on an explicit auth failure —
 * this is an interactive one-shot tool, not a CI step.
 */

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { classifyOAuthCallback } from './lib/oauth-callback-state.mjs';

const CLIENT_ID = process.env.LINKEDIN_MEMBER_CLIENT_ID || '78ikswckn74d2t';
const CLIENT_SECRET = process.env.LINKEDIN_MEMBER_CLIENT_SECRET || '';
const REDIRECT_URI =
  process.env.LINKEDIN_MEMBER_REDIRECT_URI || 'http://localhost:8080/callback';
const SCOPE = process.env.LINKEDIN_MEMBER_SCOPE || 'w_member_social';
const PORT = Number(new URL(REDIRECT_URI).port || 8080);

const urlOnly = process.argv.includes('--url-only');

function buildAuthUrl(state) {
  const u = new URL('https://www.linkedin.com/oauth/v2/authorization');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('state', state);
  u.searchParams.set('scope', SCOPE);
  return u.toString();
}

async function exchangeCode(code) {
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/** Opportunistic — expected to fail with only w_member_social. */
async function tryResolveUrn(accessToken) {
  try {
    const res = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const info = await res.json();
    return info?.sub ? `urn:li:person:${info.sub}` : null;
  } catch {
    return null;
  }
}

async function main() {
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = buildAuthUrl(state);

  console.log('─── LinkedIn member OAuth ───');
  console.log(`client_id:    ${CLIENT_ID}`);
  console.log(`redirect_uri: ${REDIRECT_URI}`);
  console.log(`scope:        ${SCOPE}`);
  console.log('');
  console.log('Open this URL, sign in, and press Allow:');
  console.log(authUrl);
  console.log('');

  if (urlOnly) return;

  if (!CLIENT_SECRET) {
    console.error('⚠️  LINKEDIN_MEMBER_CLIENT_SECRET is not set — cannot exchange the code.');
    console.error('    Run `source bin/rc-env.sh` from the workspace root first.');
    process.exit(1);
  }

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
      if (reqUrl.pathname !== new URL(REDIRECT_URI).pathname) {
        res.writeHead(404).end('not the callback path');
        return;
      }
      const callback = classifyOAuthCallback(
        {
          code: reqUrl.searchParams.get('code'),
          error: reqUrl.searchParams.get('error'),
          state: reqUrl.searchParams.get('state'),
        },
        state,
      );
      if (callback.kind === 'stale') {
        console.warn('Ignoring a LinkedIn OAuth callback with stale state; the active flow remains open.');
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Stale OAuth callback ignored. The active authorization is still waiting.');
        return;
      }
      if (callback.kind === 'error') {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`LinkedIn returned an error: ${callback.error}. You can close this tab.`);
        server.close();
        reject(new Error(`authorization denied: ${callback.error}`));
        return;
      }
      if (callback.kind === 'invalid') {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('LinkedIn callback did not include an authorization code. The active authorization is still waiting.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Authorization received. You can close this tab.');
      server.close();
      resolve(callback.code);
    });
    server.listen(PORT, () => console.log(`⏳ waiting for the callback on port ${PORT}…`));
    server.on('error', reject);
  });

  const tokens = await exchangeCode(code);
  const urn = await tryResolveUrn(tokens.access_token);

  console.log('');
  console.log('✅ Store these in Firebase Remote Config:');
  console.log(`LINKEDIN_MEMBER_ACCESS_TOKEN=${tokens.access_token}`);
  if (tokens.refresh_token) {
    console.log(`LINKEDIN_MEMBER_REFRESH_TOKEN=${tokens.refresh_token}`);
  } else {
    console.log('# no refresh_token returned — this app tier issues 60-day tokens only;');
    console.log('# re-run this helper before expiry, or ask LinkedIn to enable refresh.');
  }
  if (urn) {
    console.log(`LINKEDIN_MEMBER_URN=${urn}`);
  } else {
    console.log('# /v2/userinfo unavailable with w_member_social alone (expected).');
    console.log('# Set LINKEDIN_MEMBER_URN by hand — see the header of this file.');
  }
  console.log('');
  console.log(`expires_in: ${tokens.expires_in}s (~${Math.round(tokens.expires_in / 86400)} days)`);
  console.log(`scope granted: ${tokens.scope || SCOPE}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
