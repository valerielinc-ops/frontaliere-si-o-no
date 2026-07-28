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

/**
 * Exchange a signed assertion for an access token.
 * @param {string} assertion
 * @returns {Promise<string>} access token
 */
export async function exchangeAssertionForToken(assertion) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  if (!data?.access_token) throw new Error('OAuth response missing access_token');
  return data.access_token;
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
