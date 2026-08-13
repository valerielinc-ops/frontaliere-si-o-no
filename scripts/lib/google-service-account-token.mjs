/**
 * Google service-account OAuth2: sign a JWT assertion, exchange it for an
 * access token. No external dependencies — `node:crypto` only.
 *
 * Extracted (#4837) because the same twenty lines existed in
 * scripts/lib/indexing-api.mjs and were then copy-pasted into
 * scripts/load-rc-env.mjs's dependency-free Remote Config path. Two literal
 * copies of a credential-signing routine is exactly the drift AGENTS.md
 * Non-Negotiable #6 forbids: a fix to one (clock skew, token lifetime, error
 * handling) would silently not reach the other.
 *
 * Callers differ only by OAuth scope.
 */
import { createSign } from 'node:crypto';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Build a signed JWT assertion for the given service account and scope.
 * @param {{client_email: string, private_key: string}} creds
 * @param {string} scope - OAuth2 scope URL
 * @returns {string} signed JWT
 */
export function createJwtAssertion(creds, scope) {
  if (!creds?.client_email || !creds?.private_key) {
    throw new Error('service account credentials missing client_email/private_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({
      iss: creds.client_email,
      scope,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + TOKEN_LIFETIME_SECONDS,
    }),
  ].join('.');

  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign(creds.private_key, 'base64url')}`;
}

// Kept in lockstep with RC_FETCH_ATTEMPTS in load-rc-env.mjs (issue #263):
// same backoff formula, same credential chain, so a per-minute quota
// rejection on this hop needs the same ~63s retry budget to reach the next
// quota window instead of exhausting itself inside the one already spent.
const TOKEN_EXCHANGE_ATTEMPTS = 7;

// Wall-clock cap per attempt (follow-up #199 to #173/#198): neither `fetch`
// call here nor its sibling in load-rc-env.mjs's `fetchTemplateViaRest` had
// ANY timeout — only a status-based retry. A slow-but-never-erroring Google
// endpoint (no 429/5xx, just no response) hung the awaited `fetch()` forever,
// so the retry loop's attempt cap never even got a chance to kick in. 30s
// matches the per-request timeout already used for other Google API calls on
// this same credential chain (FETCH_TIMEOUT_MS in refresh-daily-brief-data.mjs).
export const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * Exchange a signed assertion for an access token.
 *
 * Retries 429/5xx: this call sits directly upstream of the Remote Config
 * fetch in load-rc-env.mjs's REST fallback, and a single transient failure
 * here produces the exact same symptom as one in the RC fetch itself — see
 * isRetryableRcFetchStatus in load-rc-env.mjs, which retries the sibling call.
 * @param {string} assertion
 * @returns {Promise<string>} access token
 */
export async function exchangeAssertionForToken(assertion) {
  let lastErr;
  for (let attempt = 1; attempt <= TOKEN_EXCHANGE_ATTEMPTS; attempt++) {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = await res.json();
      if (!data?.access_token) throw new Error('OAuth response missing access_token');
      return data.access_token;
    }
    const text = await res.text();
    lastErr = new Error(`OAuth token exchange failed: ${res.status} ${text}`);
    if (res.status !== 429 && res.status < 500) throw lastErr;
    if (attempt < TOKEN_EXCHANGE_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

/**
 * Convenience: creds + scope -> access token.
 * @param {{client_email: string, private_key: string}} creds
 * @param {string} scope
 * @returns {Promise<string>}
 */
export async function getServiceAccountAccessToken(creds, scope) {
  return exchangeAssertionForToken(createJwtAssertion(creds, scope));
}
