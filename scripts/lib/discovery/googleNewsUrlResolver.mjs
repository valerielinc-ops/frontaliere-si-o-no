// scripts/lib/discovery/googleNewsUrlResolver.mjs
//
// Resolve a Google News RSS wrapper link
// (https://news.google.com/rss/articles/<token>?...) to the REAL publisher
// article URL, so the article generator can fetch the source content and
// regenerate a news article from it.
//
// WHY (run 29142084681, 2026-07-11): create-article.mjs' Google News handling
// only fuzzy-matched the RSS headline against the direct-source proven scan
// (resolveGoogleNewsHeadline). News that lives ONLY on Google News (e.g. the
// whole "disoccupazione dei frontalieri" story — the single most relevant
// frontaliere topic that week) never matched a direct-scan headline, so ~219
// candidates/run were dropped as "non risolto a fonte diretta" and the run
// fell back to a generic evergreen. Decoding the real URL unlocks those.
//
// TWO wrapper formats exist:
//   • OLD: the token after /articles/ is base64url of a small protobuf whose
//     body contains the real URL as a plain UTF-8 string. Decodable OFFLINE.
//   • NEW (2024+, current): the token is opaque (starts AU_yqL… once decoded)
//     and the real URL must be fetched from Google's `batchexecute` RPC using
//     a signature+timestamp scraped from the wrapper HTML. Verified working
//     2026-07-11 against a live RSI link.
//
// Everything here is DEFENSIVE: any failure (network, format change, timeout)
// returns null, and the caller keeps its existing fuzzy-match/skip behaviour.
// A single format change on Google's side degrades to "same as before this
// module existed", never worse.

const BATCHEXECUTE_URL =
  'https://news.google.com/_/DotsSplashUi/data/batchexecute';

const DEFAULT_TIMEOUT_MS = 12000;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Process-lifetime memo so the same wrapper is never decoded twice in a run
// (the ranker may re-encounter a candidate across attempts). Keyed by the
// wrapper token. Value is the resolved URL or null (negative caching).
const _decodeCache = new Map();

/**
 * Validate a decoded URL: parseable, http(s), a real publisher host (has a
 * dot, not google). Rejects truncated/garbage matches so a slightly different
 * RPC payload degrades to a clean null (→ caller fallback) instead of feeding
 * a partial URL downstream. Returns the normalised URL string or null.
 */
function validateRealUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) return null;
  // Reject bare IPs — a real publisher article URL always has a domain host.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;
  if (host === 'google.com' || host === 'news.google.com' || host.endsWith('.google.com')) return null;
  return u.toString();
}

/** True when `rawUrl` is a Google News RSS article wrapper link. */
export function isGoogleNewsRssUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (
      u.hostname === 'news.google.com' &&
      u.pathname.startsWith('/rss/articles/')
    );
  } catch {
    return false;
  }
}

/** Extract the opaque article token from a wrapper link. */
function extractToken(gnUrl) {
  const m = String(gnUrl).match(/\/rss\/articles\/([^?/]+)/);
  return m ? m[1] : null;
}

/**
 * Fetch a URL and read its body text under ONE AbortController deadline.
 *
 * CRITICAL (hotfix 2026-07-12, run 29202963318 hung 2h42m): the previous
 * helper timed out only the fetch() (up to response headers) and returned the
 * Response, so the caller's separate `await res.text()` ran with NO timeout.
 * When news.google.com sent headers but then stalled the body, `.text()` hung
 * forever — and the article generator's wall-clock budget can't interrupt a
 * single in-flight await, so the whole run sat in "Generate article" until the
 * 6h job timeout, blocking the concurrency-1 chain. Reading the body inside the
 * same abort scope means a stalled body aborts at `timeoutMs` too. Returns the
 * body text, or null on any non-ok/abort/error (caller falls back cleanly).
 */
async function fetchText(fetchImpl, url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  if (t && typeof t.unref === 'function') t.unref();
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    if (!res || res.ok === false) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * OFFLINE decode for the legacy format: base64url-decode the token and look
 * for a plain http(s) URL in the bytes. Returns null for the opaque new
 * format (no readable URL present).
 */
export function decodeOfflineBase64(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    let t = token;
    // Legacy tokens are commonly prefixed with "CBMi" (protobuf framing).
    if (t.startsWith('CBMi')) t = t.slice(4);
    const b64 = t.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    const s = buf.toString('utf8');
    const m = s.match(/https?:\/\/[^\s\x00-\x1f"'\\<>]+/);
    if (!m) return null;
    return validateRealUrl(m[0]);
  } catch {
    return null;
  }
}

/**
 * ONLINE decode for the current opaque format via Google's batchexecute RPC.
 * Two requests: (1) GET the wrapper to scrape data-n-a-sg / data-n-a-ts,
 * (2) POST batchexecute with the token to receive the real URL.
 */
async function decodeViaBatchExecute(gnUrl, token, fetchImpl, timeoutMs) {
  // Step 1 — scrape signature + timestamp from the wrapper HTML.
  const html = await fetchText(
    fetchImpl,
    gnUrl,
    { headers: { 'User-Agent': USER_AGENT } },
    timeoutMs,
  );
  if (!html) return null;
  const sg = html.match(/data-n-a-sg="([^"]+)"/);
  const ts = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) return null;

  // Step 2 — batchexecute RPC. The inner payload shape mirrors Google's
  // `Fbv4je`/`garturlreq` request (verified live 2026-07-11).
  const inner = JSON.stringify([
    'garturlreq',
    [
      ['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
      'X',
      'X',
      1,
      [1, 1, 1],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    token,
    Number(ts[1]),
    sg[1],
  ]);
  const body =
    'f.req=' +
    encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));

  const raw = await fetchText(
    fetchImpl,
    BATCHEXECUTE_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': USER_AGENT,
      },
      body,
    },
    timeoutMs,
  );
  if (!raw) return null;
  // The RPC payload is JSON-inside-JSON: forward slashes may arrive plain or
  // escaped as \/ (and unicode-escaped as /). Normalise BEFORE matching
  // so the URL regex captures the whole path either way.
  const txt = raw.replace(/\\\//g, '/').replace(/\\u002f/gi, '/');
  const m = txt.match(/https?:\/\/(?!news\.google\.com)[^\s"\\]+/);
  if (!m) return null;
  // Validate: a slightly different payload could yield a truncated match —
  // reject it to a clean null instead of returning a partial URL.
  return validateRealUrl(m[0]);
}

/**
 * Resolve a Google News RSS wrapper link to the real publisher URL.
 * Returns the real URL string, or null on any failure (caller falls back).
 *
 * @param {string} gnUrl
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
export async function decodeGoogleNewsUrl(gnUrl, opts = {}) {
  if (!isGoogleNewsRssUrl(gnUrl)) return null;
  const token = extractToken(gnUrl);
  if (!token) return null;
  if (_decodeCache.has(token)) return _decodeCache.get(token);

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Number(opts.timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  let resolved = null;
  // Cheap offline attempt first (legacy format) — no network.
  resolved = decodeOfflineBase64(token);
  if (!resolved) {
    try {
      // Belt-and-suspenders total deadline: fetchText already bounds each
      // request+body, but a fetchImpl that ignores the abort signal could
      // still stall. Race the whole two-request decode against a hard cap so
      // decodeGoogleNewsUrl can NEVER hang the caller (article generator).
      const hardCapMs = timeoutMs * 2 + 5000;
      resolved = await Promise.race([
        decodeViaBatchExecute(gnUrl, token, fetchImpl, timeoutMs),
        new Promise((res) => {
          const t = setTimeout(() => res(null), hardCapMs);
          if (t && typeof t.unref === 'function') t.unref();
        }),
      ]);
    } catch {
      resolved = null;
    }
  }
  _decodeCache.set(token, resolved);
  return resolved;
}

/** Test-only: clear the process-lifetime decode cache. */
export function _resetDecodeCache() {
  _decodeCache.clear();
}

export default decodeGoogleNewsUrl;
