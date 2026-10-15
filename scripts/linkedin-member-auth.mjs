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
 * ── The person URN problem, read before running ──────────────────────────
 * Posting as a member requires the author URN `urn:li:person:<id>`. The only
 * API that returns it is /v2/userinfo (OIDC) or the legacy /v2/me, and BOTH
 * need a scope this app does not have: the app has ONLY w_member_social
 * ("Sign In with LinkedIn using OpenID Connect" is not an added product —
 * verified on the app's Products page 2026-08-24).
 *
 * So this helper tries /v2/userinfo opportunistically and, when it 403s as
 * expected, tells the owner to supply LINKEDIN_MEMBER_URN by hand. Two ways
 * to get it without adding a product:
 *   - open your own LinkedIn profile, View source, search "urn:li:fsd_profile:"
 *   - or add the "Sign In with LinkedIn using OpenID Connect" product (self
 *     serve, instant) and re-run this helper with SCOPE including `openid`.
 * The posting script treats a missing URN as a soft skip, never a crash.
 *
 * Exit code is 0 on the happy path and 1 only on an explicit auth failure —
 * this is an interactive one-shot tool, not a CI step.
 */

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

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
      const got = reqUrl.searchParams.get('code');
      const gotState = reqUrl.searchParams.get('state');
      const err = reqUrl.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (err) {
        res.end(`LinkedIn returned an error: ${err}. You can close this tab.`);
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
