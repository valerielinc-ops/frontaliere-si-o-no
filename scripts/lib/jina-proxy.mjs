/**
 * Jina Reader egress proxy for IP-blocked crawler sources.
 *
 * Some career sites (e.g. cambiavalute.ch, #1363/#1417) sit behind a WAF that
 * serves a challenge / empty page to GitHub Actions datacenter IPs, even when
 * the UA + headers are a perfect browser match — the block is on the egress IP
 * reputation, which no header tweak can fix. The jobs ARE reachable from a
 * residential / clean IP.
 *
 * Jina Reader (https://r.jina.ai) fetches a URL with a real browser from its own
 * (non-blocked) IP pool and, with `X-Return-Format: html`, returns the raw HTML.
 * Routing the blocked host's requests through it transparently yields the real
 * page so the existing parsers work unchanged. Free, no key required for the
 * handful of requests a dedicated crawler makes per run (an optional
 * `JINA_API_KEY` raises the rate limit if ever needed).
 *
 * Opt-in only: the shared crawler applies this when `JOBS_CRAWLER_FETCH_PROXY`
 * lists the request's host, so the default path for the other ~400 crawlers is
 * completely untouched.
 */

export const JINA_READER_BASE = 'https://r.jina.ai/';

/* ── Per-run egress circuit breaker (#1461 item 2) ──────────────────────────
 * Post-#1454 every connection-level fetch failure routes through a Jina retry
 * helper that spends up to (retries+1) attempts × timeoutMs + exponential
 * backoff (~tens of seconds/URL at defaults). Under a BROAD egress outage —
 * when every host in a wave fails at once — that per-URL tax is paid serially
 * on every failing URL, converting a fast-fail wave into a slow-timeout wave
 * that can exhaust the GitHub Actions job timeout → incomplete data collection
 * instead of a clean fast-fail with the prior dataset intact (the pre-#1454
 * behaviour).
 *
 * The breaker tells "one flaky fetch" (rescue it — the #1454 value) apart from
 * "the whole egress is down" (stop paying the tax): it counts CONSECUTIVE Jina
 * exhaustions and trips once they reach the threshold, after which every later
 * fallback call in the run fast-fails with NO attempt. A single successful
 * rescue resets the counter, so sprinkled/non-consecutive flakiness never trips
 * it. Run-scoped (each crawler is its own node process); reset between tests via
 * __resetJinaBreaker(). Tunable / disable (0) via JOBS_JINA_BREAKER_THRESHOLD. */
let jinaConsecutiveFailures = 0;
let jinaBreakerTripped = false;

function jinaBreakerThreshold() {
  const v = Number(process.env.JOBS_JINA_BREAKER_THRESHOLD);
  // Default 8: a normal wave's connection-level failures are rare (~1-3%) and
  // non-consecutive, so 8 in a row with no success in between is an unambiguous
  // broad-outage signal, not sprinkled flakiness.
  return Number.isFinite(v) && v >= 0 ? v : 8;
}

/**
 * Is the Jina egress breaker open (broad outage → fast-fail without attempting)?
 * Trips and logs once when the consecutive-failure count reaches the threshold;
 * stays open for the rest of the run. A threshold of 0 disables the breaker.
 */
export function jinaBreakerOpen() {
  const threshold = jinaBreakerThreshold();
  if (threshold === 0) return false;
  if (jinaBreakerTripped) return true;
  if (jinaConsecutiveFailures >= threshold) {
    jinaBreakerTripped = true;
    console.warn(
      `⚠️ Jina egress circuit breaker tripped after ${jinaConsecutiveFailures} consecutive failures — broad egress outage detected; skipping the Jina fallback for the rest of this run to fail fast (prior data preserved).`,
    );
    return true;
  }
  return false;
}

/** A clean rescue: reset the consecutive-failure run (isolated flakiness). */
function recordJinaSuccess() {
  jinaConsecutiveFailures = 0;
}

/** An exhausted Jina attempt sequence: advance the breaker toward tripping. */
function recordJinaFailure() {
  jinaConsecutiveFailures += 1;
}

/** Test-only: reset breaker state between runs (module state persists per process). */
export function __resetJinaBreaker() {
  jinaConsecutiveFailures = 0;
  jinaBreakerTripped = false;
}

/**
 * Build the Jina-proxied request (URL + headers) for a target URL.
 * `format` defaults to 'html' (raw HTML, matching a direct fetch) — pass
 * 'markdown' for callers written against Jina's own default Markdown
 * rendering instead (e.g. google-switzerland-job-parser.mjs).
 */
/**
 * Percent-encode the query-string delimiters of the TARGET url so Jina's own
 * API-parameter parser cannot consume them. Without this, a target like
 * `...job-finder?page=0` reaches r.jina.ai as literal `?page=0` and Jina's
 * validator treats `page` as ITS OWN parameter (min 1 → HTTP 400) instead of
 * forwarding it (found live on swatchgroup.com, omega crawler). Idempotent:
 * a URL already encoded this way has no raw `?` left and passes through.
 */
export function encodeJinaTargetUrl(targetUrl = '') {
  const str = String(targetUrl);
  const i = str.indexOf('?');
  if (i === -1) return str;
  const query = str.slice(i + 1).replace(/&/g, '%26').replace(/=/g, '%3D').replace(/#/g, '%23');
  return `${str.slice(0, i)}%3F${query}`;
}

export function jinaProxiedRequest(targetUrl, { format = 'html' } = {}) {
  const headers = {
    // Return the page's raw HTML (not Jina's default markdown) so downstream
    // HTML/JSON-LD parsers see exactly what a direct fetch would have returned.
    'X-Return-Format': format,
  };
  const key = (process.env.JINA_API_KEY || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return { url: `${JINA_READER_BASE}${encodeJinaTargetUrl(targetUrl)}`, headers };
}

/**
 * Fetch a URL through the Jina proxy with an AbortController timeout, so a slow
 * or hanging Jina request can never stall a crawler run until the global job
 * timeout. Returns the raw `Response`. Used by dedicated crawlers that fetch
 * outside the shared `fetchWithTimeout` chokepoint (discovery / single-page).
 */
export async function fetchViaJina(
  targetUrl,
  { timeoutMs = 30000, fetchImpl = fetch, format } = {},
) {
  const { url, headers } = jinaProxiedRequest(targetUrl, { format });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL through the Jina proxy, retrying on a fresh Jina egress IP when the
 * response is a WAF challenge / non-target page (not the real page).
 *
 * Why this exists: the IP-reputation WAF (SiteGround sgcaptcha, cambiavalute.ch
 * #1363) flags a *subset* of Jina Reader's IP pool. A SINGLE `fetchViaJina` call
 * therefore succeeds ~80% of the time and lands on a blocked IP the other ~20%,
 * getting an HTTP 200 with a challenge body → `detectJinaErrorBody` flags it but
 * the single-shot callers could only log + skip → 0 jobs on an unlucky run even
 * though the source is live. Jina rotates its egress IP per request, so simply
 * retrying picks a fresh IP: 4 attempts at ~80%/try ≈ 99.8% success. Each retry
 * is a brand-new request (no IP affinity to pin), which is the whole point.
 *
 * Returns a fresh, unconsumed `Response` (body already validated and re-wrapped,
 * so callers can still `.text()` it). On exhaustion it returns the LAST response
 * shape (status + body) unchanged, so every caller's existing
 * `res.ok` / `detectJinaErrorBody` graceful-skip path runs as before — this never
 * throws of its own accord and never converts a dead source into a hard failure.
 */
export async function fetchViaJinaWithRetry(
  targetUrl,
  { timeoutMs = 30000, attempts = 4, retryDelayMs = 800, fetchImpl = fetch, format } = {},
) {
  // Broad egress outage already detected this run → fast-fail with the same
  // exhausted-response shape (no attempt), so the caller's graceful-skip path
  // runs without paying the retry tax. (#1461 item 2)
  if (jinaBreakerOpen()) {
    return new Response('', {
      status: 502,
      headers: { 'content-type': 'text/html', 'x-jina-retry-reason': 'circuit-breaker-open' },
    });
  }
  let lastBody = '';
  let lastStatus = 0;
  let lastReason = 'no attempt made';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchViaJina(targetUrl, { timeoutMs, fetchImpl, format });
      lastStatus = res.status;
      if (!res.ok) {
        // Jina's own non-2xx (rate limit / upstream) — a fresh IP may fare better.
        // Cancel (don't read) the unused body so undici releases the connection
        // before retrying; otherwise N abandoned streams pile up under concurrent
        // proxied fetches. cancel() (vs arrayBuffer()) avoids reading an error body
        // unbounded — fetchViaJina already disarmed its timeout, so there is no
        // AbortSignal left to cap a slow/large drain — and signals undici to reclaim
        // the socket deterministically.
        try { await res.body?.cancel(); } catch { /* already aborted/closed */ }
        lastBody = '';
        lastReason = `HTTP ${res.status}`;
      } else {
        const body = await res.text();
        lastBody = body;
        const reason = detectJinaErrorBody(body);
        if (!reason) {
          // Real target page from a non-blocked Jina IP.
          recordJinaSuccess();
          return new Response(body, {
            status: 200,
            headers: { 'content-type': res.headers.get('content-type') || 'text/html' },
          });
        }
        lastReason = reason;
      }
    } catch (err) {
      lastReason = err?.message || String(err);
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  // Every attempt hit a blocked IP / error. Count it toward the breaker, then
  // hand back the last response shape so the caller's unchanged graceful-skip
  // path takes over (no false failure).
  recordJinaFailure();
  return new Response(lastBody, {
    status: lastStatus || 502,
    headers: {
      'content-type': 'text/html',
      'x-jina-retry-reason': String(lastReason).slice(0, 120),
    },
  });
}

/**
 * Jina answers HTTP 200 even when it could not actually serve the target page:
 * an upstream failure (target unreachable from Jina, a challenge/error page, or
 * a rate-limit notice) comes back as a 200 with a non-target body. `res.ok` is
 * then `true` and the downstream parser silently receives a non-job page → 0
 * links/roles → a graceful skip that is indistinguishable from "the source is
 * genuinely empty" (#1422 item 1). This inspects a proxied 200 body and returns
 * a short human-readable reason string when it does NOT look like a real target
 * page (so the caller can log an explicit "200-but-not-target" warning), or
 * `null` when the body looks like a genuine page.
 *
 * Conservative by design — it only flags a body that is empty / suspiciously
 * short or that carries an unambiguous Jina/WAF error-or-challenge marker, so a
 * real (if unusual) target page is never misclassified. Detection is advisory:
 * callers log and continue (the downstream parser still yields 0 and skips), it
 * never blocks publishing data.
 */
export function detectJinaErrorBody(body, { minLength = 200 } = {}) {
  const text = typeof body === 'string' ? body : '';
  const trimmed = text.trim();
  if (!trimmed) return 'empty body';
  if (trimmed.length < minLength) {
    return `body too short (${trimmed.length} < ${minLength} chars)`;
  }
  // Unambiguous "this is not the target page" markers: Jina's own
  // failure-to-fetch envelope and the standard WAF/anti-bot challenge banners a
  // proxied fetch can still land on. Kept narrow to avoid false positives on a
  // real jobs page.
  const lower = trimmed.toLowerCase();
  const ERROR_MARKERS = [
    'failed to fetch the target url',
    'target url returned error',
    'this site can’t be reached',
    "this site can't be reached",
    'just a moment...',
    'attention required!',
    'checking your browser before accessing',
    'enable javascript and cookies to continue',
    // SiteGround "sgcaptcha" IP-reputation challenge (cambiavalute.ch, #1363):
    // a meta-refresh to /.well-known/sgcaptcha/?…&y=ipr:<ip> served to blocked
    // egress IPs. Jina's IP pool is mostly clean but ~1-in-5 attempts land on a
    // flagged IP and get this page on a 200. Explicit marker so a long variant
    // (over the too-short floor) is still flagged → fetchViaJinaWithRetry rotates
    // to a fresh Jina IP instead of silently parsing the challenge as 0 jobs.
    'sgcaptcha',
    // BotGuard-style JS fingerprint checkpoint (ergolz.cardiance.com, #6693):
    // an HTTP 200 "One moment, please..." page that self-reloads after a
    // webdriver/plugin/mimeType fingerprint check — no cf/incapsula marker,
    // so it needs its own signature.
    'please wait while your request is being verified',
  ];
  const hit = ERROR_MARKERS.find((m) => lower.includes(m));
  return hit ? `error/challenge marker: "${hit}"` : null;
}

/**
 * Does `url`'s host match any entry in the comma-separated `listCsv`
 * (`JOBS_CRAWLER_FETCH_PROXY`)? Matches the host exactly or as a subdomain.
 */
export function hostMatchesProxyList(url, listCsv) {
  if (!listCsv) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return String(listCsv)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((h) => host === h || host.endsWith(`.${h}`));
}
const jinaSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a URL's HTML through the Jina proxy WITH retries. Returns the target's
 * HTML on success, or `null` if every attempt failed / was non-target (the
 * caller then safe-fails by re-throwing the original error).
 *
 * Why retry the proxy (not the flaky origin egress): Jina's OWN egress IP can be
 * transiently rate-limited (HTTP 429) or soft-blocked by the target's WAF, in
 * which case it answers HTTP 200 with a challenge / empty body. A retry usually
 * lands on a DIFFERENT Jina egress IP, so re-attempting often succeeds where the
 * first call was blocked. Retries on: proxy throw (abort/network), non-ok
 * status, and a 200-but-not-target body (detectJinaErrorBody). Exponential
 * backoff + jitter. Tunable via JOBS_JINA_RETRIES / JOBS_JINA_RETRY_BASE_MS.
 */
export async function fetchHtmlViaJinaWithRetry(
  targetUrl,
  { timeoutMs = 30000, retries, retryBaseMs } = {},
) {
  // Broad egress outage already detected this run → fast-fail (null) with no
  // attempt, so the caller's safe-fail (re-throw / skip, prior data preserved)
  // runs without paying the retry tax on every URL in the wave. (#1461 item 2)
  if (jinaBreakerOpen()) return null;
  // Distinguishes "env var absent/non-numeric" (falls back to default) from
  // "env var explicitly set to 0" (honors the 0) — `Number(envVal) || fallback`
  // would silently discard an explicit 0 since `0 || fallback` is `fallback`.
  const pickEnvNumber = (override, envVal, fallback) => {
    if (Number.isFinite(override)) return override;
    const env = Number(envVal);
    return Number.isFinite(env) ? env : fallback;
  };
  const maxRetries = Math.max(0, pickEnvNumber(retries, process.env.JOBS_JINA_RETRIES, 2));
  const baseMs = Math.max(
    0,
    pickEnvNumber(retryBaseMs, process.env.JOBS_JINA_RETRY_BASE_MS, 1000),
  );
  let lastReason = 'unknown';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetchViaJina(targetUrl, { timeoutMs });
      if (res.ok) {
        const html = await res.text();
        const reason = detectJinaErrorBody(html);
        if (!reason) {
          recordJinaSuccess();
          return html;
        }
        lastReason = reason;
      } else {
        // Cancel (don't read) the unused non-2xx body so undici releases the
        // connection before retrying (same leak fixed in fetchViaJinaWithRetry
        // above; cancel() avoids reading a slow/large error body unbounded now
        // that fetchViaJina's timeout is disarmed).
        try { await res.body?.cancel(); } catch { /* already aborted/closed */ }
        lastReason = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastReason = err?.message || String(err);
    }
    if (attempt < maxRetries) {
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
      console.warn(
        `⚠️ Jina egress attempt ${attempt + 1}/${maxRetries + 1} for ${targetUrl} not usable (${lastReason}); retrying in ${delay}ms…`,
      );
      await jinaSleep(delay);
    }
  }
  console.warn(`⚠️ Jina egress exhausted ${maxRetries + 1} attempt(s) for ${targetUrl} (last: ${lastReason}).`);
  recordJinaFailure();
  return null;
}

// Unambiguous WAF anti-bot challenge banners served on an HTTP 200 to a blocked
// egress IP (the "200-but-not-the-page" case). Distinct from detectJinaErrorBody:
// this list is MARKER-ONLY (no short/empty heuristic), so it is high-precision
// and safe to run on EVERY successful direct fetch across all crawlers without
// false-positiving a real (possibly short) jobs page. Covers SiteGround sgcaptcha
// (#1363), Cloudflare, and Incapsula — the cambiavalute IP-reputation class.
const ANTI_BOT_CHALLENGE_MARKERS = [
  'sgcaptcha',
  'just a moment...',
  'attention required!',
  'checking your browser before accessing',
  'enable javascript and cookies to continue',
  'cf-browser-verification',
  'cf_chl_',
  '_incapsula_resource',
  // BotGuard-style JS fingerprint checkpoint (ergolz.cardiance.com, #6693).
  'please wait while your request is being verified',
];

/**
 * Does `body` look like a WAF anti-bot challenge page (served on a 200 to a
 * blocked egress IP), rather than the real target page? Marker-only → no false
 * positives on a genuine page. Used to decide whether a successful-but-wrong
 * direct fetch should be re-routed through the clean-IP Jina proxy.
 */
export function looksLikeAntiBotChallenge(body) {
  const lower = String(body || '').toLowerCase();
  return ANTI_BOT_CHALLENGE_MARKERS.some((m) => lower.includes(m));
}

/**
 * Shared "200-but-challenge → Jina rescue" used at every direct-fetch chokepoint
 * (crawler-template fetchHtml, the SAP SuccessFactors family, hospital helpers).
 *
 * If `html` is a genuine page → returns it unchanged (zero cost, the common
 * path). If it is a WAF challenge (IP-reputation block that answered 200), it
 * re-fetches `url` through the Jina Reader proxy (clean IP, retried across Jina's
 * IP pool) and returns the real page. If Jina is also blocked/unavailable →
 * returns the ORIGINAL `html` so the caller's existing 0-result /
 * 0-total-preserves-data path runs unchanged. Never throws → no regression vs.
 * today for any crawler that wasn't already being silently fed a challenge.
 */
export async function rescueHtmlIfChallenged(html, url, { timeoutMs } = {}) {
  if (!looksLikeAntiBotChallenge(html)) return html;
  const rescued = await fetchHtmlViaJinaWithRetry(url, { timeoutMs });
  if (rescued != null && !looksLikeAntiBotChallenge(rescued)) return rescued;
  console.warn(`   ⚠️ Jina rescue exhausted for ${url} — still a challenge page, returning original HTML unchanged.`);
  return html;
}