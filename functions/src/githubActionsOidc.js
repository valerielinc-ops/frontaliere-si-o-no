import { createPublicKey, verify } from 'node:crypto';

export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_ACTIONS_OIDC_JWKS_URL = `${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`;
export const GENERATION_SLOT_CLAIM_AUDIENCE = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/claimGenerationSlot';
export const GENERATION_CLAIM_REQUESTS_PER_IP = 20;
export const GENERATION_CLAIM_RATE_WINDOW_MS = 60_000;

const EXPECTED_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
const EXPECTED_WORKFLOW_REF = `${EXPECTED_REPOSITORY}/.github/workflows/generate-article.yml@refs/heads/main`;
const JWKS_CACHE_MS = 10 * 60_000;
const JWKS_TIMEOUT_MS = 5_000;
const MAX_RATE_BUCKETS = 2048;

let jwksCache = { keys: new Map(), expiresAt: 0 };
const rateBuckets = new Map();

function decodeJsonSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function loadJwks(fetchImpl, nowMs, forceRefresh = false) {
  if (!forceRefresh && jwksCache.expiresAt > nowMs && jwksCache.keys.size > 0) return jwksCache.keys;
  const response = await fetchImpl(GITHUB_ACTIONS_OIDC_JWKS_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('github_oidc_jwks_unavailable');
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body?.keys)) throw new Error('github_oidc_jwks_invalid');
  const keys = new Map(body.keys
    .filter((key) => key?.kty === 'RSA' && key?.alg === 'RS256' && key?.use === 'sig' && typeof key.kid === 'string')
    .map((key) => [key.kid, key]));
  if (keys.size === 0) throw new Error('github_oidc_jwks_empty');
  jwksCache = { keys, expiresAt: nowMs + JWKS_CACHE_MS };
  return keys;
}

/** Verify a GitHub Actions ID token for the corpus generator's main workflow. */
export async function verifyGithubActionsIdToken(token, {
  audience,
  now = Date.now(),
  fetchImpl = fetch,
} = {}) {
  if (typeof token !== 'string' || !audience) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = decodeJsonSegment(parts[0]);
  const claims = decodeJsonSegment(parts[1]);
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !claims) return null;

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return null;
  const nowSeconds = Math.floor(nowMs / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER
    || !audiences.includes(audience)
    || typeof claims.sub !== 'string'
    || !claims.sub.startsWith('repo:')
    || !claims.sub.endsWith(':ref:refs/heads/main')
    || claims.repository !== EXPECTED_REPOSITORY
    || claims.ref !== 'refs/heads/main'
    || claims.workflow_ref !== EXPECTED_WORKFLOW_REF
    || claims.event_name !== 'workflow_dispatch'
    || !/^\d{1,24}$/u.test(String(claims.run_id ?? ''))
    || !Number.isFinite(claims.exp) || claims.exp < nowSeconds - 30
    || !Number.isFinite(claims.iat) || claims.iat < nowSeconds - 600 || claims.iat > nowSeconds + 60
    || (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds + 60)) return null;

  try {
    let keys = await loadJwks(fetchImpl, nowMs);
    let jwk = keys.get(header.kid);
    if (!jwk) {
      keys = await loadJwks(fetchImpl, nowMs, true);
      jwk = keys.get(header.kid);
    }
    if (!jwk) return null;
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    const signedContent = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    return verify('RSA-SHA256', signedContent, publicKey, signature) ? claims : null;
  } catch {
    return null;
  }
}

/** Small per-instance guard; the function's maxInstances bounds total exposure. */
export function allowGenerationClaimRequest(req, {
  now = Date.now(),
  limit = GENERATION_CLAIM_REQUESTS_PER_IP,
  windowMs = GENERATION_CLAIM_RATE_WINDOW_MS,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs) || !Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
    return false;
  }
  const address = String(req?.socket?.remoteAddress || req?.ip || 'unknown').slice(0, 128);
  let bucket = rateBuckets.get(address);
  if (!bucket || bucket.resetAt <= nowMs) {
    bucket = { count: 0, resetAt: nowMs + windowMs };
    rateBuckets.set(address, bucket);
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;

  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [key, value] of rateBuckets) {
      if (value.resetAt <= nowMs) rateBuckets.delete(key);
      if (rateBuckets.size <= MAX_RATE_BUCKETS) break;
    }
    while (rateBuckets.size > MAX_RATE_BUCKETS) rateBuckets.delete(rateBuckets.keys().next().value);
  }
  return true;
}

export function resetGithubActionsOidcStateForTests() {
  jwksCache = { keys: new Map(), expiresAt: 0 };
  rateBuckets.clear();
}
