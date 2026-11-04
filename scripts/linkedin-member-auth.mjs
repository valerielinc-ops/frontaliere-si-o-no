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
 * The helper stores access and refresh credentials in the private server
 * Remote Config namespace. It never prints token values. A service-account
 * write preflight runs before the one-use OAuth code is requested.
 *
 * ── The person URN problem, read before running ──────────────────────────
 * Posting as a member requires the author URN `urn:li:person:<id>`. The only
 * API that returns it is /v2/userinfo (OIDC) or the legacy /v2/me, and BOTH
 * need a scope this app does not have: the app has ONLY w_member_social
 * ("Sign In with LinkedIn using OpenID Connect" is not an added product —
 * verified on the app's Products page 2026-08-24).
 *
 * This helper tries /v2/userinfo opportunistically. When the app does not
 * grant a profile-identity scope, it keeps any already configured URN and the
 * publisher remains held until a trusted member URN is available. Do not infer
 * an author identity from a different account or scrape a private profile.
 *
 * Exit code is 0 on the happy path and 1 only on an explicit auth failure —
 * this is an interactive one-shot tool, not a CI step.
 */

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import {
  persistSocialOAuthCredentials,
  readSocialOAuthStorageCredentials,
  validateSocialOAuthCredentialStorage,
} from './lib/social-oauth-credential-store.mjs';

const CLIENT_ID = process.env.LINKEDIN_MEMBER_CLIENT_ID || '78ikswckn74d2t';
const CLIENT_SECRET = process.env.LINKEDIN_MEMBER_CLIENT_SECRET || '';
const REDIRECT_URI =
  process.env.LINKEDIN_MEMBER_REDIRECT_URI || 'http://localhost:8080/callback';
const SCOPE = process.env.LINKEDIN_MEMBER_SCOPE || 'w_member_social r_member_postAnalytics r_member_profileAnalytics';
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
    throw new Error('LinkedIn token exchange failed (HTTP ' + res.status + ')');
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
  let storageCredentials = null;
  if (!urlOnly) {
    if (!CLIENT_SECRET) throw new Error('LINKEDIN_MEMBER_CLIENT_SECRET is not set');
    storageCredentials = readSocialOAuthStorageCredentials(process.env, 'linkedin-member');
    await validateSocialOAuthCredentialStorage({
      credentials: storageCredentials,
      platform: 'linkedin-member',
    });
  }

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

  const expiresIn = Number(tokens.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('LinkedIn did not return a verifiable access-token lifetime');
  }
  const parameters = {
    SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN: tokens.access_token,
    SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  const removeParameters = [];
  if (tokens.refresh_token) {
    parameters.SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN = tokens.refresh_token;
  } else {
    removeParameters.push('SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN');
  }
  if (urn) parameters.SERVER_LINKEDIN_MEMBER_URN = urn;
  const stored = await persistSocialOAuthCredentials({
    credentials: storageCredentials,
    platform: 'linkedin-member',
    parameters,
    removeParameters,
  });

  console.log('');
  console.log('✅ LinkedIn member OAuth credentials stored in the private server Remote Config namespace.');
  console.log('stored fields: ' + stored.parameterCount + '; access token lifetime: ' + expiresIn + 's');
  if (urn) {
    console.log('member URN resolved and stored privately.');
  } else {
    console.log('# /v2/userinfo unavailable with w_member_social alone (expected).');
    console.log('# Any existing configured member URN was retained.');
  }
  console.log('');
  console.log('scope granted: ' + (tokens.scope || SCOPE));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
