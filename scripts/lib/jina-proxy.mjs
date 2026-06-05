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

/** Build the Jina-proxied request (URL + headers) for a target URL. */
export function jinaProxiedRequest(targetUrl) {
  const headers = {
    // Return the page's raw HTML (not Jina's default markdown) so downstream
    // HTML/JSON-LD parsers see exactly what a direct fetch would have returned.
    'X-Return-Format': 'html',
  };
  const key = (process.env.JINA_API_KEY || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return { url: `${JINA_READER_BASE}${targetUrl}`, headers };
}

/**
 * Fetch a URL through the Jina proxy with an AbortController timeout, so a slow
 * or hanging Jina request can never stall a crawler run until the global job
 * timeout. Returns the raw `Response`. Used by dedicated crawlers that fetch
 * outside the shared `fetchWithTimeout` chokepoint (discovery / single-page).
 */
export async function fetchViaJina(targetUrl, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const { url, headers } = jinaProxiedRequest(targetUrl);
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
  { timeoutMs = 30000, attempts = 4, retryDelayMs = 800, fetchImpl = fetch } = {},
) {
  let lastBody = '';
  let lastStatus = 0;
  let lastReason = 'no attempt made';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchViaJina(targetUrl, { timeoutMs, fetchImpl });
      lastStatus = res.status;
      if (!res.ok) {
        // Jina's own non-2xx (rate limit / upstream) — a fresh IP may fare better.
        // Drain the unused body so undici reclaims the connection before retrying;
        // otherwise N abandoned streams pile up under concurrent proxied fetches.
        try { await res.arrayBuffer(); } catch { /* already aborted/closed */ }
        lastBody = '';
        lastReason = `HTTP ${res.status}`;
      } else {
        const body = await res.text();
        lastBody = body;
        const reason = detectJinaErrorBody(body);
        if (!reason) {
          // Real target page from a non-blocked Jina IP.
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
  // Every attempt hit a blocked IP / error. Hand back the last response shape so
  // the caller's unchanged graceful-skip path takes over (no false failure).
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
  const maxRetries = Math.max(
    0,
    Number.isFinite(retries) ? retries : Number(process.env.JOBS_JINA_RETRIES) || 2,
  );
  const baseMs = Math.max(
    0,
    Number.isFinite(retryBaseMs) ? retryBaseMs : Number(process.env.JOBS_JINA_RETRY_BASE_MS) || 1000,
  );
  let lastReason = 'unknown';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetchViaJina(targetUrl, { timeoutMs });
      if (res.ok) {
        const html = await res.text();
        const reason = detectJinaErrorBody(html);
        if (!reason) return html;
        lastReason = reason;
      } else {
        // Drain the unused non-2xx body so undici reclaims the connection before
        // retrying (same leak fixed in fetchViaJinaWithRetry above).
        try { await res.arrayBuffer(); } catch { /* already aborted/closed */ }
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
  return null;
}