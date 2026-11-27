import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { cancelReaderWithDeadline } from './lib/boundedReaderCleanup.js';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'frontaliere-jobs-source-relay';
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
export const MAX_RELAY_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_RELAY_REDIRECTS = 3;
export const RELAY_TIMEOUT_MS = 15_000;
export const RELAY_MAX_REQUESTS_PER_HOUR = 300;
export const RELAY_MIN_INTERVAL_MS = 1_000;
export const RELAY_MAX_UPSTREAM_PER_DAY = 400;
// Workday tenants (#20279) have their own daily ledger so a burst of Workday
// fallbacks can never starve the three original relay sources, and vice versa.
// Calibration: ~39 tenants x (1-3 listing pages + <=40 details) bounded by the
// client budgets (scripts/lib/ats-clients/workday-client.mjs), a few runs/day.
export const RELAY_WORKDAY_MAX_UPSTREAM_PER_DAY = 3_000;
export const RELAY_MAX_REQUEST_BODY_BYTES = 4_096;

const ALLOWED_REPOSITORIES = new Set([
  'nanakokyobashi-rgb/frontaliere-articles',
  'valerielinc-ops/frontaliere-si-o-no',
]);
const ALLOWED_CONTENT_TYPES = new Set(['text/html', 'application/json']);
const WORKDAY_HOST_RE = /^[a-z0-9][a-z0-9-]*\.wd\d{1,3}\.myworkdayjobs\.com$/u;
const WORKDAY_LISTING_PATH_RE = /^\/wday\/cxs\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/jobs$/u;
const WORKDAY_DETAIL_PATH_RE =
  /^\/wday\/cxs\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/job(?:\/[A-Za-z0-9_.,~%()+-]+)+$/u;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const RELAY_USER_AGENT = 'FrontaliereJobsSourceRelay/1.0';

let jwksCache = { expiresAt: 0, keys: new Map() };
let jwksFetchPromise = null;

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function decodeJsonPart(value, label) {
  try {
    return JSON.parse(base64UrlDecode(value).toString('utf8'));
  } catch {
    throw new Error(`invalid_jwt_${label}`);
  }
}

function getResponseHeader(response, name) {
  if (response?.headers?.get) return response.headers.get(name);
  const headers = response?.headers;
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function getRequestHeader(req, name) {
  if (typeof req?.get === 'function') {
    const value = req.get(name);
    if (value !== undefined && value !== null) return Array.isArray(value) ? value[0] : value;
  }
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function requestQueryValue(req, name) {
  const value = req?.query?.[name];
  return typeof value === 'string' ? value : null;
}

function describeTarget(rawUrl) {
  try {
    const target = new URL(String(rawUrl || ''));
    return { host: target.hostname.toLowerCase(), path: target.pathname };
  } catch {
    return { host: 'unknown', path: 'unknown' };
  }
}

function logRelayRequest({ host, path, status, bytes = 0, caller = 'unknown' }) {
  // Keep the fields flat so Cloud Logging can index the audit dimensions
  // without ever receiving the source URL query string or the bearer token.
  console.log(JSON.stringify({
    severity: 'INFO',
    message: 'jobsSourceRelay',
    host,
    path,
    status,
    bytes,
    caller,
  }));
}

function responseStatus(res, status) {
  if (typeof res?.status === 'function') return res.status(status);
  if (res) res.statusCode = status;
  return res;
}

function responseHeader(res, name, value) {
  if (typeof res?.set === 'function') res.set(name, value);
  else if (typeof res?.setHeader === 'function') res.setHeader(name, value);
}

function sendBody(res, status, body, contentType, extraHeaders = {}) {
  const target = responseStatus(res, status);
  responseHeader(target, 'Content-Type', contentType);
  responseHeader(target, 'X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(extraHeaders)) responseHeader(target, name, value);
  if (typeof target?.send === 'function') return target.send(body);
  if (typeof target?.end === 'function') return target.end(body);
  return undefined;
}

function sendJson(res, status, error, extraHeaders = {}) {
  return sendBody(res, status, JSON.stringify({ error }), 'application/json; charset=utf-8', extraHeaders);
}

// Marks a response whose status/body come from the upstream source, so a
// caller can tell a relayed Workday 404/429 from the relay's own errors.
const UPSTREAM_MARKER = { 'X-Relay-Source': 'upstream' };

// Auth rejections carry a stable code plus NON-sensitive observed values
// (iss/aud/repository/kid/timestamps), never the token or its signature.
function authError(message, observed) {
  const error = new Error(message);
  error.observed = observed;
  return error;
}

function safeClaim(value) {
  if (typeof value === 'string') return value.slice(0, 120);
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => String(item).slice(0, 120));
  return typeof value;
}

const AUTH_REJECTION_CODES = new Map([
  ['missing_authorization', 'missing_authorization'],
  ['missing_bearer_token', 'bad_scheme'],
  ['invalid_jwt_shape', 'bad_shape'],
  ['invalid_jwt_header', 'bad_header'],
  ['invalid_jwt_payload', 'bad_payload'],
  ['invalid_jwt_issuer', 'bad_iss'],
  ['invalid_jwt_audience', 'bad_aud'],
  ['invalid_jwt_repository', 'bad_repository'],
  ['invalid_repository', 'bad_repository'],
  ['expired_jwt', 'expired'],
  ['not_yet_valid_jwt', 'not_yet_valid'],
  ['invalid_verifier_clock', 'bad_clock'],
  ['unknown_jwt_key', 'kid_unknown'],
  ['invalid_jwt_signature', 'bad_signature'],
]);

function classifyAuthRejection(error) {
  const message = String(error?.message || '');
  if (AUTH_REJECTION_CODES.has(message)) return AUTH_REJECTION_CODES.get(message);
  if (message.startsWith('github_oidc_jwks_')) return 'jwks_fetch_failed';
  if (error?.name === 'AbortError' || /fetch failed|abort|timeout|ENOTFOUND|ECONN|ETIMEDOUT/iu.test(message)) {
    return 'jwks_fetch_failed';
  }
  return 'auth_unknown';
}

function logAuthRejection({ req, error, authorization, target }) {
  const names = Object.keys(req?.headers && typeof req.headers === 'object' ? req.headers : {});
  console.warn(JSON.stringify({
    severity: 'WARNING',
    message: 'jobsSourceRelayAuthRejected',
    reason: classifyAuthRejection(error),
    detail: String(error?.message || '').slice(0, 120),
    cause: error?.cause?.code ? String(error.cause.code).slice(0, 60) : undefined,
    authorizationPresent: authorization.length > 0,
    authorizationScheme: authorization ? authorization.split(/\s+/u)[0].slice(0, 16).toLowerCase() : null,
    serverlessAuthorizationPresent: Boolean(getRequestHeader(req, 'x-serverless-authorization')),
    headerNames: names.map((name) => name.toLowerCase()).sort().slice(0, 40),
    host: target.host,
    path: target.path,
    ...(error?.observed || {}),
  }));
}

function allowedAudience(aud) {
  return aud === GITHUB_OIDC_AUDIENCE
    || (Array.isArray(aud) && aud.length === 1 && aud[0] === GITHUB_OIDC_AUDIENCE);
}

async function fetchGithubJwks(fetchImpl, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && jwksCache.expiresAt > now && jwksCache.keys.size > 0) {
    return jwksCache.keys;
  }
  if (jwksFetchPromise) return jwksFetchPromise;

  jwksFetchPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(GITHUB_OIDC_JWKS_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response?.ok) throw new Error(`github_oidc_jwks_${response?.status || 'unavailable'}`);
      const payload = await response.json();
      const keys = new Map();
      for (const jwk of Array.isArray(payload?.keys) ? payload.keys : []) {
        if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.n || !jwk.e) continue;
        try {
          keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          // Ignore malformed rotated keys; a valid key for this token may still exist.
        }
      }
      if (keys.size === 0) throw new Error('github_oidc_jwks_empty');
      jwksCache = { expiresAt: Date.now() + JWKS_CACHE_TTL_MS, keys };
      return keys;
    } finally {
      clearTimeout(timer);
      jwksFetchPromise = null;
    }
  })();

  return jwksFetchPromise;
}

/**
 * Verify the GitHub Actions OIDC token used by the source relay.
 *
 * The verifier deliberately accepts only the issuer, audience, repositories,
 * and RSA algorithm used by the second-step workflows. No shared secret is
 * kept in Firebase or passed through a crawler environment.
 */
export async function verifyGithubOidcToken(token, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid_jwt_shape');

  const header = decodeJsonPart(parts[0], 'header');
  const claims = decodeJsonPart(parts[1], 'payload');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('invalid_jwt_header');
  if (claims.iss !== GITHUB_OIDC_ISSUER) {
    throw authError('invalid_jwt_issuer', { iss: safeClaim(claims.iss) });
  }
  if (!allowedAudience(claims.aud)) throw authError('invalid_jwt_audience', { aud: safeClaim(claims.aud) });
  if (!ALLOWED_REPOSITORIES.has(claims.repository)) {
    throw authError('invalid_jwt_repository', {
      repository: safeClaim(claims.repository),
      jobWorkflowRef: safeClaim(claims.job_workflow_ref),
    });
  }

  const nowSeconds = Math.floor(Number(now()) / 1000);
  if (!Number.isFinite(nowSeconds)) throw new Error('invalid_verifier_clock');
  if (typeof claims.exp !== 'number' || claims.exp < nowSeconds - 60) {
    throw authError('expired_jwt', { exp: safeClaim(claims.exp), nowSeconds });
  }
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + 60) {
    throw authError('not_yet_valid_jwt', { nbf: claims.nbf, nowSeconds });
  }

  let keys = await fetchGithubJwks(fetchImpl);
  let publicKey = keys.get(header.kid);
  if (!publicKey) {
    keys = await fetchGithubJwks(fetchImpl, true);
    publicKey = keys.get(header.kid);
  }
  if (!publicKey) throw authError('unknown_jwt_key', { kid: safeClaim(header.kid), jwksKeyCount: keys.size });

  const valid = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    base64UrlDecode(parts[2]),
  );
  if (!valid) throw new Error('invalid_jwt_signature');

  return {
    repository: claims.repository,
    subject: typeof claims.sub === 'string' ? claims.sub : null,
  };
}

/**
 * The host/path rules are intentionally kept next to the relay handler; the
 * same parser is applied again after every redirect. Keep each source narrow:
 * the relay is a clean-egress escape hatch, not a general proxy.
 */
export function parseAllowedRelayTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2_048) return null;
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    target.protocol !== 'https:'
    || target.username
    || target.password
    || target.port
  ) return null;

  const host = target.hostname.toLowerCase();

  // Workday CXS API (#20279): the listing is a POST of a validated JSON body,
  // the job detail a GET. Both stay under /wday/cxs/<tenant>/<site>/ of a
  // *.wdN.myworkdayjobs.com host, with no query string or fragment: this is a
  // clean-egress path for the public career-site JSON, not a general proxy.
  if (WORKDAY_HOST_RE.test(host)) {
    if (target.search || target.hash) return null;
    if (WORKDAY_LISTING_PATH_RE.test(target.pathname)) {
      return { url: target, host, path: target.pathname, methods: ['POST'], upstream: 'workday' };
    }
    if (WORKDAY_DETAIL_PATH_RE.test(target.pathname)) {
      return { url: target, host, path: target.pathname, methods: ['GET'], upstream: 'workday' };
    }
    return null;
  }

  const isChurJob = host === 'jobs.chur.ch' && /^\/[^/]+-de-j\d+\.html$/u.test(target.pathname);
  const isHasJob = host === 'e-lavoro.ch' && /^\/node\/\d+$/u.test(target.pathname);
  const isAltenListing = host === 'www.alten.ch' && target.pathname === '/career/jobs/';
  const isAltenJob = host === 'www.alten.ch'
    && /^\/jobs\/\d+-[a-z0-9]+(?:-[a-z0-9]+)*\/$/u.test(target.pathname);
  if (!isChurJob && !isHasJob && !isAltenListing && !isAltenJob) return null;
  return { url: target, host, path: target.pathname, methods: ['GET'], upstream: 'static' };
}

/**
 * Validate and re-serialize the Workday listing body. Only the four fields the
 * crawler sends survive, with bounded sizes: nothing the caller supplies
 * beyond that shape is forwarded to the tenant.
 */
export function sanitizeWorkdayListingBody(raw) {
  let payload = raw;
  if (Buffer.isBuffer(payload)) payload = payload.toString('utf8');
  if (typeof payload === 'string') {
    if (Buffer.byteLength(payload, 'utf8') > RELAY_MAX_REQUEST_BODY_BYTES) return null;
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const allowed = new Set(['appliedFacets', 'limit', 'offset', 'searchText']);
  if (Object.keys(payload).some((key) => !allowed.has(key))) return null;
  const { appliedFacets = {}, limit = 20, offset = 0, searchText = '' } = payload;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) return null;
  if (typeof searchText !== 'string' || searchText.length > 200) return null;
  if (!appliedFacets || typeof appliedFacets !== 'object' || Array.isArray(appliedFacets)) return null;
  const facetEntries = Object.entries(appliedFacets);
  if (facetEntries.length > 20) return null;
  const facets = {};
  for (const [name, values] of facetEntries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(name)) return null;
    if (!Array.isArray(values) || values.length > 50) return null;
    if (values.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 200)) return null;
    facets[name] = values;
  }
  const body = JSON.stringify({ appliedFacets: facets, limit, offset, searchText });
  return Buffer.byteLength(body, 'utf8') > RELAY_MAX_REQUEST_BODY_BYTES ? null : body;
}

export function createHostRateLimiter({
  now = Date.now,
  minIntervalMs = RELAY_MIN_INTERVAL_MS,
  maxPerHour = RELAY_MAX_REQUESTS_PER_HOUR,
} = {}) {
  const buckets = new Map();
  return {
    allow(host) {
      const nowMs = Number(now());
      const current = buckets.get(host) || { lastAt: null, timestamps: [] };
      current.timestamps = current.timestamps.filter((timestamp) => nowMs - timestamp < 60 * 60 * 1000);
      if (current.lastAt !== null && nowMs - current.lastAt < minIntervalMs) {
        buckets.set(host, current);
        return false;
      }
      if (current.timestamps.length >= maxPerHour) {
        buckets.set(host, current);
        return false;
      }
      current.lastAt = nowMs;
      current.timestamps.push(nowMs);
      buckets.set(host, current);
      return true;
    },
  };
}

export function createDailyUpstreamCap({
  now = Date.now,
  maxPerDay = RELAY_MAX_UPSTREAM_PER_DAY,
} = {}) {
  let dayKey = null;
  let count = 0;
  const resetForToday = () => {
    const currentDayKey = new Date(Number(now())).toISOString().slice(0, 10);
    if (currentDayKey !== dayKey) {
      dayKey = currentDayKey;
      count = 0;
    }
  };
  const isExhausted = () => {
    resetForToday();
    return count >= maxPerDay;
  };

  return {
    isExhausted,
    tryAcquire() {
      if (isExhausted()) return false;
      count += 1;
      return true;
    },
  };
}

async function readResponseBodyLimited(response, maxBytes, signal) {
  const contentLength = Number.parseInt(getResponseHeader(response, 'content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { tooLarge: true, bytes: contentLength };
  }

  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('upstream_timeout');
  };
  const chunks = [];
  let bytes = 0;
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const tooLarge = new Error('upstream_response_too_large');
    const cancelOnAbort = () => {
      void cancelReaderWithDeadline(reader);
    };
    signal?.addEventListener('abort', cancelOnAbort, { once: true });
    try {
      while (true) {
        throwIfAborted();
        const { done, value } = await reader.read();
        throwIfAborted();
        if (done) break;
        // A copy, never a view: over a bare ArrayBuffer `Buffer.from(value)`
        // shares the producer's memory, which a reader may reuse.
        const chunk = Buffer.from(value instanceof ArrayBuffer
          ? value.slice(0)
          : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        bytes += chunk.length;
        if (bytes > maxBytes) {
          throw tooLarge;
        }
        chunks.push(chunk);
      }
    } catch (error) {
      await cancelReaderWithDeadline(reader);
      if (error === tooLarge) return { tooLarge: true, bytes };
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancelOnAbort);
      try { reader.releaseLock?.(); } catch { /* the read verdict stays authoritative */ }
    }
    return { tooLarge: false, bytes, body: Buffer.concat(chunks, bytes) };
  }

  if (typeof response?.arrayBuffer === 'function') {
    throwIfAborted();
    const body = Buffer.from(await response.arrayBuffer());
    throwIfAborted();
    return body.length > maxBytes
      ? { tooLarge: true, bytes: body.length }
      : { tooLarge: false, bytes: body.length, body };
  }

  if (typeof response?.text === 'function') {
    throwIfAborted();
    const body = Buffer.from(await response.text(), 'utf8');
    throwIfAborted();
    return body.length > maxBytes
      ? { tooLarge: true, bytes: body.length }
      : { tooLarge: false, bytes: body.length, body };
  }

  throw new Error('upstream_body_unreadable');
}

async function fetchAllowedTarget(initialTarget, {
  fetchImpl,
  rateLimiter,
  dailyUpstreamCap,
  workdayDailyUpstreamCap,
  method = 'GET',
  body: requestBody,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  const seenHosts = new Set();
  let target = initialTarget;
  let redirects = 0;

  try {
    while (true) {
      const cap = target.upstream === 'workday' ? workdayDailyUpstreamCap : dailyUpstreamCap;
      if (cap.isExhausted()) return { kind: 'daily_cap', host: target.host, path: target.path };
      if (!seenHosts.has(target.host)) {
        if (!rateLimiter.allow(target.host)) return { kind: 'rate_limited', host: target.host, path: target.path };
        seenHosts.add(target.host);
      }
      if (!cap.tryAcquire()) return { kind: 'daily_cap', host: target.host, path: target.path };

      const response = await fetchImpl(target.url, {
        method,
        redirect: 'manual',
        headers: {
          'User-Agent': RELAY_USER_AGENT,
          Accept: 'text/html, application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: requestBody } : {}),
        signal: controller.signal,
      });
      const status = Number(response?.status || 0);
      // The tenant's own rate limit, whatever its content type: surfaced as a
      // distinct, upstream-marked 429 so the caller stops instead of retrying.
      if (status === 429 && target.upstream === 'workday') {
        return { kind: 'upstream_rate_limited', target };
      }
      if (!REDIRECT_STATUSES.has(status)) {
        const contentType = String(getResponseHeader(response, 'content-type') || '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
          return { kind: 'unsupported_content_type', target };
        }
        const body = await readResponseBodyLimited(response, MAX_RELAY_RESPONSE_BYTES, controller.signal);
        if (body.tooLarge) return { kind: 'response_too_large', target, bytes: body.bytes };
        return { kind: 'response', response, target, body, contentType };
      }

      // A POST is never replayed against a redirect target.
      if (method === 'POST') return { kind: 'redirect_forbidden', target: describeTarget(String(getResponseHeader(response, 'location') || '')) };
      if (redirects >= MAX_RELAY_REDIRECTS) return { kind: 'too_many_redirects', target };
      const location = getResponseHeader(response, 'location');
      if (!location) return { kind: 'upstream_error', target };
      const redirectedUrl = new URL(location, target.url);
      const redirectedTarget = parseAllowedRelayTarget(redirectedUrl.toString());
      if (!redirectedTarget) {
        return { kind: 'redirect_forbidden', target: describeTarget(redirectedUrl.toString()) };
      }
      target = redirectedTarget;
      redirects += 1;
    }
  } catch (error) {
    if (controller.signal.aborted) return { kind: 'timeout', target };
    return { kind: 'upstream_error', target, error };
  } finally {
    clearTimeout(timer);
  }
}

export function createJobsSourceRelayHandler({
  fetchImpl = globalThis.fetch,
  verifyToken = (token) => verifyGithubOidcToken(token, { fetchImpl }),
  rateLimiter = createHostRateLimiter(),
  dailyUpstreamCap = createDailyUpstreamCap(),
  workdayDailyUpstreamCap = createDailyUpstreamCap({ maxPerDay: RELAY_WORKDAY_MAX_UPSTREAM_PER_DAY }),
} = {}) {
  return async function jobsSourceRelay(req, res) {
    const authorization = getRequestHeader(req, 'authorization') || '';
    const tokenMatch = authorization.match(/^Bearer\s+([^\s]+)$/iu);
    let claims;

    try {
      if (!authorization) throw new Error('missing_authorization');
      if (!tokenMatch) throw new Error('missing_bearer_token');
      claims = await verifyToken(tokenMatch[1]);
      if (!claims || !ALLOWED_REPOSITORIES.has(claims.repository)) throw new Error('invalid_repository');
    } catch (error) {
      const target = describeTarget(requestQueryValue(req, 'url'));
      logAuthRejection({ req, error, authorization, target });
      logRelayRequest({ ...target, status: 401, caller: 'unauthenticated' });
      return sendJson(res, 401, 'unauthorized');
    }

    const rawTarget = requestQueryValue(req, 'url');
    const describedTarget = describeTarget(rawTarget);
    const caller = claims.repository;
    if (req.method !== 'GET' && req.method !== 'POST') {
      logRelayRequest({ ...describedTarget, status: 405, caller });
      return sendJson(res, 405, 'method_not_allowed');
    }

    const target = parseAllowedRelayTarget(rawTarget);
    if (!target) {
      logRelayRequest({ ...describedTarget, status: 403, caller });
      return sendJson(res, 403, 'forbidden');
    }
    if (!target.methods.includes(req.method)) {
      logRelayRequest({ ...describedTarget, status: 405, caller });
      return sendJson(res, 405, 'method_not_allowed');
    }

    let upstreamBody;
    if (req.method === 'POST') {
      upstreamBody = sanitizeWorkdayListingBody(req.rawBody ?? req.body);
      if (upstreamBody === null) {
        logRelayRequest({ ...describedTarget, status: 400, caller });
        return sendJson(res, 400, 'invalid_body');
      }
    }

    const result = await fetchAllowedTarget(target, {
      fetchImpl,
      rateLimiter,
      dailyUpstreamCap,
      workdayDailyUpstreamCap,
      method: req.method,
      body: upstreamBody,
    });
    if (result.kind === 'upstream_rate_limited') {
      logRelayRequest({ host: result.target.host, path: result.target.path, status: 429, caller });
      return sendJson(res, 429, 'upstream_rate_limited', UPSTREAM_MARKER);
    }
    if (result.kind === 'daily_cap') {
      logRelayRequest({ host: result.host, path: result.path, status: 429, caller });
      return sendJson(res, 429, 'daily_cap');
    }
    if (result.kind === 'rate_limited') {
      logRelayRequest({ host: result.host, path: result.path, status: 429, caller });
      return sendJson(res, 429, 'rate_limited');
    }
    if (result.kind === 'redirect_forbidden') {
      logRelayRequest({ ...result.target, status: 403, caller });
      return sendJson(res, 403, 'forbidden');
    }
    if (result.kind === 'too_many_redirects') {
      logRelayRequest({ host: result.target.host, path: result.target.path, status: 502, caller });
      return sendJson(res, 502, 'too_many_redirects');
    }
    if (result.kind === 'unsupported_content_type') {
      logRelayRequest({ host: result.target.host, path: result.target.path, status: 415, caller });
      return sendJson(res, 415, 'unsupported_content_type');
    }
    if (result.kind === 'response_too_large') {
      logRelayRequest({ host: result.target.host, path: result.target.path, status: 413, bytes: result.bytes, caller });
      return sendJson(res, 413, 'response_too_large');
    }
    if (result.kind === 'timeout') {
      logRelayRequest({ host: target.host, path: target.path, status: 504, caller });
      return sendJson(res, 504, 'upstream_timeout');
    }
    if (result.kind !== 'response') {
      logRelayRequest({ host: target.host, path: target.path, status: 502, caller });
      return sendJson(res, 502, 'upstream_error');
    }

    const response = result.response;

    logRelayRequest({
      host: result.target.host,
      path: result.target.path,
      status: Number(response.status),
      bytes: result.body.bytes,
      caller,
    });
    return sendBody(
      res,
      Number(response.status),
      result.body.body,
      result.contentType,
      UPSTREAM_MARKER,
    );
  };
}

export const handleJobsSourceRelay = createJobsSourceRelayHandler();
