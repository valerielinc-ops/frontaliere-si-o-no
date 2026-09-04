/**
 * check-border-data-health.mjs — Watchdog for LIVE border data integrity.
 *
 * The owner requires that the cross-border funnel ALWAYS serves live data: if
 * the wait-time snapshot goes stale, or the live routing provider silently
 * falls back to mock/estimate sources, or a Canton Ticino webcam breaks, it must
 * surface as a GitHub issue — never sit dormant.
 *
 * SCOPE (deliberately complementary to traffic-data-freshness.yml):
 *   - traffic-data-freshness.yml already debounces wait-time STALENESS on an
 *     hourly cadence (90-min threshold, peak-hours window) and self-heals by
 *     dispatching traffic-scheduler. This watchdog does NOT duplicate that fast
 *     loop. It owns two gaps that workflow does not cover:
 *       (a) WEBCAM HEALTH — every borderCrossings[].webcams[].imageUrl is
 *           HTTP-checked (the GIF must actually load at full size).
 *       (b) ALL-MOCK SOURCE — if every crossing's `source` is `mock`, the live
 *           routing provider failed and the page is serving estimates only.
 *   - A COARSE staleness backstop (default 6h, env STALE_HOURS) is included so a
 *     totally-frozen pipeline still trips this watchdog even if the hourly
 *     freshness check is itself broken. It is intentionally looser than the
 *     90-min fast loop to avoid double-paging on a transient blip.
 *
 * Exit code: non-zero if anything is stale/all-mock/broken; 0 if all healthy.
 * The CLI prints a human-readable summary the workflow embeds in the issue body.
 *
 * The webcam check copies the F5 BIG-IP cookie-jar + browser-header pattern from
 * scripts/analyze-webcam-frame.mjs so www4.ti.ch does not 403 the request.
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { buildCookieHeader, updateCookieJar } from './lib/tiChCookieJar.mjs';
import { WAF_IP_BLOCK_STATUS } from './lib/transient-fetch.mjs';

// ── Tunables ────────────────────────────────────────────────────────
const DEFAULT_STALE_HOURS = 6;
// A healthy Ticino webcam GIF is ~250KB+. F5/error pages return tiny HTML or a
// few-KB placeholder. Anything under this is treated as a broken feed.
const MIN_WEBCAM_BYTES = 10 * 1024;
const WEBCAM_FETCH_TIMEOUT_MS = 15000;
// HTTP statuses that an access-control / rate-limit / geo-block layer returns and
// that commonly DISCRIMINATE BY CLIENT IP — a residential browser (the real
// frontaliere user) gets 200 while a cloud/datacenter runner gets blocked. Seeing
// one of these from the monitor's single cloud vantage is INDETERMINATE, exactly
// like a TCP-level failure (see `networkError` below): it does not prove the feed
// is broken FOR END USERS, so it must not page. A feed that is genuinely gone
// returns 404/410, a server fault returns 5xx, and a stub returns a tiny body —
// all of which remain confirmed-broken signals that DO page.
//
// The anti-bot/WAF subset (403 forbidden, 406 not-acceptable, 415 unsupported-
// media-type, 451 legal-block) is reused from the SINGLE source of truth
// `WAF_IP_BLOCK_STATUS` in lib/transient-fetch.mjs (AGENTS.md #6: no copy-pasted
// status set that can drift). #3098: comune.cannobio.vb.it returned a LiteSpeed
// 415 to the GitHub Actions runner while serving a healthy 200/62KB webp to real
// users — 415 was missing here and the feed (mis)paged as confirmed-broken. We
// UNION that WAF class with the auth / proxy-auth / rate-limit codes (401/407/429)
// that likewise hit only the monitor's single cloud IP.
const IP_DISCRIMINATING_STATUSES = new Set([...WAF_IP_BLOCK_STATUS, 401, 407, 429]);

// ── Pure logic (unit-tested; NO network/IO) ─────────────────────────

/**
 * Decide whether the wait-time snapshot is stale.
 * @param {{updatedAt?: string, perCrossing?: Record<string, {lastUpdate?: string}>}} doc
 * @param {number} nowMs   current time in ms (injected for testability)
 * @param {number} staleHours threshold in hours
 * @returns {{stale: boolean, ageMinutes: number|null, timestamp: string|null, reason: string|null}}
 */
export function evaluateStaleness(doc, nowMs, staleHours = DEFAULT_STALE_HOURS) {
  if (!doc || typeof doc !== 'object') {
    return { stale: true, ageMinutes: null, timestamp: null, reason: 'Snapshot missing or not an object' };
  }
  // Prefer the top-level updatedAt; fall back to the newest per-crossing lastUpdate.
  let ts = typeof doc.updatedAt === 'string' ? doc.updatedAt : null;
  if (!ts && doc.perCrossing && typeof doc.perCrossing === 'object') {
    const stamps = Object.values(doc.perCrossing)
      .map((c) => (c && typeof c.lastUpdate === 'string' ? Date.parse(c.lastUpdate) : NaN))
      .filter((n) => Number.isFinite(n));
    if (stamps.length) ts = new Date(Math.max(...stamps)).toISOString();
  }
  if (!ts) {
    return { stale: true, ageMinutes: null, timestamp: null, reason: 'No updatedAt / lastUpdate timestamp found' };
  }
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) {
    return { stale: true, ageMinutes: null, timestamp: ts, reason: `Unparseable timestamp "${ts}"` };
  }
  const ageMinutes = Math.round((nowMs - parsed) / 60000);
  const thresholdMin = staleHours * 60;
  if (ageMinutes > thresholdMin) {
    return {
      stale: true,
      ageMinutes,
      timestamp: ts,
      reason: `Wait-time snapshot is ${ageMinutes} min old (threshold ${thresholdMin} min / ${staleHours}h)`,
    };
  }
  return { stale: false, ageMinutes, timestamp: ts, reason: null };
}

// Active window (UTC) during which a fresh wait-time snapshot is GUARANTEED to
// exist, so the coarse staleness backstop can page without false positives.
// Outside it the snapshot is legitimately old (overnight or expected scheduling
// gap), and webcam-health + all-mock checks are time-independent so they always
// run.
//
// The START is set to 11:00 UTC for two compounding reasons:
//
//   REASON 1 — overnight false-positive guard (issue #2587):
//     GitHub Actions delivers scheduled runs LATE (top-of-hour crons routinely
//     lag 10–60+ min), so a delayed 00:00 watchdog run (executed at 05:05)
//     would see the prior evening's ~19:00 snapshot (>6h old) and falsely page.
//
//   REASON 2 — morning scheduling-gap false-positive guard (issue #4229):
//     The traffic-scheduler's morning peak cron ends at 07:30 UTC (`*/30 4-7`);
//     the next scheduled run is the midday check at 11:00 UTC (`0 11 * * 1-5`).
//     This 3.5-hour gap exceeds the 90-min freshness threshold, so data is
//     EXPECTED to be stale during 08:00–10:59 UTC on weekdays. A stale reading
//     at (e.g.) 10:47 UTC is not a real freeze — it is predictable schedule lag.
//     The fast freshness loop (traffic-data-freshness.yml) self-heals via
//     dispatch during this window (STALE ≠ PAGEABLE), so data is refreshed even
//     without paging. GitHub cron skips (on both the scheduler AND the hourly
//     freshness check) can prevent a pending issue from auto-closing before the
//     next stale reading, triggering a false confirmation.
//
// Arming at 11:00 UTC:
//   - Clears the overnight false-positive window (00:00–07:59) — same as before.
//   - ALSO clears the morning gap window (08:00–10:59): expected staleness there
//     self-heals silently; real freezes are caught when the window opens at 11:00.
//   - The 6h coarse backstop (border-live-data-watchdog.yml, runs at 12/18 UTC)
//     is unaffected: both run hours remain ≥ 11.
//   - A real morning freeze (scheduler broken from ~06:00) is caught at 11:00
//     by the 90-min fast loop (data >210 min old → STALE + PAGEABLE), or at
//     12:00 by the 6h backstop if the freeze is older than 6h.
// If the scheduler's morning peak cron moves past 09:30 UTC, revisit this constant.
const STALE_ACTIVE_START_UTC_HOUR = 11;
const STALE_ACTIVE_END_UTC_HOUR = 20; // exclusive

/**
 * Whether the staleness backstop should be evaluated at this instant.
 * @param {number} nowMs current time in ms (injected for testability)
 * @returns {boolean}
 */
export function isStalenessCheckActive(nowMs) {
  const hour = new Date(nowMs).getUTCHours();
  return hour >= STALE_ACTIVE_START_UTC_HOUR && hour < STALE_ACTIVE_END_UTC_HOUR;
}

// The fast freshness loop's threshold (traffic-data-freshness.yml) was sized for
// the weekday peak cadence (`*/30 4-7`/`*/30 14-17`, i.e. a run every 30 min).
// On weekends traffic-scheduler.yml collapses to `0 6,10,14,18 * * 0,6` — one
// run every 4h (240 min) to conserve HERE quota. A flat 90-min threshold on
// that cadence guarantees a false "stale" reading ~90 min after every single
// weekend run, all day — the same false-positive shape as the already-fixed
// weekday morning gap (see STALE_ACTIVE_START_UTC_HOUR above, #4229), just
// recurring every ~4h instead of once. Each false positive burns an unwanted
// HERE self-heal dispatch plus a throwaway pending issue (observed #5960 and
// its predecessors, one nearly every weekend day/slot).
const WEEKDAY_STALE_THRESHOLD_MIN = 90;
// 240-min actual gap + up to ~60min of documented GitHub cron delivery lag
// (see the PAGEABLE comment below) = 300, so a healthy weekend run never trips
// this. A genuinely frozen weekend pipeline is still caught by the 6h coarse
// backstop (DEFAULT_STALE_HOURS above / border-live-data-watchdog.yml).
const WEEKEND_STALE_THRESHOLD_MIN = 300;

/**
 * Freshness threshold (minutes) for the fast loop, matched to the actual
 * traffic-scheduler.yml cadence for the day of week.
 * @param {number} nowMs current time in ms (injected for testability)
 * @returns {number}
 */
export function staleThresholdMinutesFor(nowMs) {
  const day = new Date(nowMs).getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6 ? WEEKEND_STALE_THRESHOLD_MIN : WEEKDAY_STALE_THRESHOLD_MIN;
}

/**
 * Decide whether the live routing provider has fully fallen back to mock data.
 * Only trips when EVERY crossing's source is `mock` (a partial fallback is
 * tolerated — some crossings legitimately lack live coverage).
 * @param {{perCrossing?: Record<string, {source?: string}>}} doc
 * @returns {{allMock: boolean, total: number, mock: number, reason: string|null}}
 */
export function evaluateAllMockSource(doc) {
  const per = doc && typeof doc === 'object' ? doc.perCrossing : null;
  if (!per || typeof per !== 'object') {
    return { allMock: false, total: 0, mock: 0, reason: null };
  }
  const sources = Object.values(per).map((c) => (c && typeof c.source === 'string' ? c.source : null));
  const total = sources.length;
  if (total === 0) return { allMock: false, total: 0, mock: 0, reason: null };
  const mock = sources.filter((s) => s === 'mock').length;
  if (mock === total) {
    return {
      allMock: true,
      total,
      mock,
      reason: `All ${total} crossings report source=mock — live routing provider failed; page is serving estimates only`,
    };
  }
  return { allMock: false, total, mock, reason: null };
}

/**
 * Decide whether a single webcam fetch result indicates a broken feed.
 * @param {{ok: boolean, status: number|string, bytes: number}} result
 * @param {number} minBytes
 * @returns {{broken: boolean, reason: string|null}}
 */
export function evaluateWebcamResult(result, minBytes = MIN_WEBCAM_BYTES) {
  // Connection-level failure (DNS/TLS/timeout) from this single monitor vantage
  // is INDETERMINATE — the feed may still serve end users fine (publisher blocks
  // cloud IPs, transient route). Don't page on it; only HTTP-error / tiny-body
  // are confirmed-broken signals.
  if (result && result.networkError === true) {
    return { broken: false, indeterminate: true, reason: `unreachable from monitor (${result.status}) — not confirmed broken` };
  }
  // An access-control / rate-limit / geo-block / anti-bot status (401/403/406/
  // 407/415/429/451 — see IP_DISCRIMINATING_STATUSES) from the monitor's single
  // cloud IP is INDETERMINATE for the same reason a TCP failure is: such layers
  // routinely block datacenter ranges (e.g. LiteSpeed 415, #3098) while serving
  // residential browsers (the real users) a healthy 200. Don't page; report it.
  if (result && result.ok !== true && IP_DISCRIMINATING_STATUSES.has(result.status)) {
    return { broken: false, indeterminate: true, reason: `blocked from monitor (HTTP ${result.status}) — likely cloud-IP block, not confirmed broken` };
  }
  if (!result || result.ok !== true) {
    return { broken: true, reason: `HTTP ${result?.status ?? 'error'}` };
  }
  if (typeof result.bytes !== 'number' || result.bytes < minBytes) {
    return {
      broken: true,
      reason: `Body too small (${result?.bytes ?? 0} bytes < ${minBytes}) — likely error/placeholder page`,
    };
  }
  return { broken: false, reason: null };
}

/**
 * Collect the unique webcam image URLs (with the crossings each serves) from the
 * borderCrossings registry. Pure: takes the array, returns a dedup map.
 * @param {Array<{name?: string, webcams?: Array<{imageUrl?: string, label?: string, minBytes?: number}>}>} crossings
 * @returns {Map<string, {url: string, crossings: string[], label: string|null, minBytes: number|undefined}>}
 */
export function collectWebcamUrls(crossings) {
  const map = new Map();
  for (const c of crossings || []) {
    for (const w of c?.webcams || []) {
      const url = w?.imageUrl;
      if (!url) continue;
      if (!map.has(url)) map.set(url, { url, crossings: [], label: w?.label ?? null, minBytes: w?.minBytes });
      map.get(url).crossings.push(c?.name ?? '(unnamed)');
    }
  }
  return map;
}

// ── Per-webcam status across runs (issue #6644) ──────────────────────
// The watchdog was STATELESS between runs: every verdict was thrown away at
// process exit, so an offline→online transition on a SINGLE feed was
// unobservable. The only recovery signal was the aggregate one (the canonical
// issue closes when EVERYTHING is healthy), which stays silent while another
// feed is still broken — exactly the window in which "this camera is back"
// is the useful news. Persisting `{status, lastCheckedAt, lastOnlineAt}` per
// URL makes the transition computable on the next run.
const WEBCAM_STATUS_FILE = 'data/webcam-status.json';

/**
 * Fold this run's webcam verdicts into the persisted per-webcam state and
 * report which feeds came back online since the previous run. Pure: takes the
 * previous state + this run's observations + a clock, returns the next state.
 *
 * INDETERMINATE verdicts (cloud-IP block, unreachable from the monitor — see
 * `evaluateWebcamResult`) are NOT evidence about the feed: they carry the
 * previous status forward untouched. Treating them as offline would fabricate
 * a downtime, and treating them as online would fabricate a recovery.
 *
 * @param {Record<string, {status?: string, lastCheckedAt?: string, lastOnlineAt?: string|null}>} previous
 * @param {Array<{url: string, label?: string|null, served?: string[], verdict: {broken?: boolean, indeterminate?: boolean}}>} observations
 * @param {number} nowMs
 * @returns {{state: Record<string, {status: string, lastCheckedAt: string, lastOnlineAt: string|null}>, recovered: Array<{url: string, label: string|null, served: string[], offlineForMs: number|null}>}}
 */
export function applyWebcamStatus(previous, observations, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const state = {};
  const recovered = [];
  for (const obs of observations || []) {
    if (!obs?.url) continue;
    const prev = previous?.[obs.url] ?? null;
    const prevOnlineAt = prev?.lastOnlineAt ?? null;
    const verdict = obs.verdict ?? {};
    if (verdict.indeterminate === true) {
      state[obs.url] = {
        status: prev?.status ?? 'unknown',
        lastCheckedAt: nowIso,
        lastOnlineAt: prevOnlineAt,
      };
      continue;
    }
    if (verdict.broken === true) {
      state[obs.url] = { status: 'offline', lastCheckedAt: nowIso, lastOnlineAt: prevOnlineAt };
      continue;
    }
    if (prev?.status === 'offline') {
      const since = prevOnlineAt ? Date.parse(prevOnlineAt) : NaN;
      recovered.push({
        url: obs.url,
        label: obs.label ?? null,
        served: obs.served ?? [],
        offlineForMs: Number.isFinite(since) ? Math.max(0, nowMs - since) : null,
      });
    }
    state[obs.url] = { status: 'online', lastCheckedAt: nowIso, lastOnlineAt: nowIso };
  }
  // Rebuilt from THIS run's observations only, so a URL dropped from the
  // registry disappears from the file instead of accumulating forever.
  return { state, recovered };
}

/**
 * Human-readable downtime for a recovery alert. `null` (no `lastOnlineAt` ever
 * recorded — first run after the feed was already down) reads as unknown
 * rather than as zero, which would understate a real outage.
 * @param {number|null} ms
 * @returns {string}
 */
export function formatDowntime(ms) {
  if (ms === null || !Number.isFinite(ms)) return 'durata sconosciuta';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}min` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}g ${restHours}h` : `${days}g`;
}

function loadWebcamStatus() {
  const file = path.resolve(process.cwd(), WEBCAM_STATUS_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt state file must never take the watchdog down: the worst case is
    // one missed recovery alert while the file is rewritten from scratch.
    console.warn(`[check-border-data-health] ${WEBCAM_STATUS_FILE} unreadable — restarting from empty state`);
    return {};
  }
}

function saveWebcamStatus(state) {
  const file = path.resolve(process.cwd(), WEBCAM_STATUS_FILE);
  // Sorted keys so the committed diff shows real status changes, not key churn.
  const sorted = Object.fromEntries(Object.keys(state).sort().map((k) => [k, state[k]]));
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

// ── Network (not unit-tested; exercised live) ───────────────────────

// F5 BIG-IP ASM on www4.ti.ch sets session cookies on the first response;
// subsequent cookieless requests from the same IP get 403. The shared cookie-jar
// (scripts/lib/tiChCookieJar.mjs) re-uses cookies across requests, same as
// scripts/analyze-webcam-frame.mjs.

const WEBCAM_TINY_BODY_RETRY_DELAY_MS = 5000;
// A single tiny-body retry (one extra 5s-delayed read) is not always enough:
// issue #5431 recurred TWICE on the same slow-refresh feed (webcamdtl.it,
// refreshIntervalMs 300000) with a tiny body surviving both the first read AND
// the one retry (4344 bytes on 2026-08-09, 8688 bytes on 2026-08-22), while a
// direct re-fetch immediately after each incident confirmed the feed healthy
// (200, ~200KB+). The upstream file-replacement window on a slow-refresh
// source can outlast a single 5s-delayed retry. Two retries (three total
// reads) meaningfully lowers the odds of hitting that window on every attempt
// while staying well inside the shared run budget below.
const WEBCAM_TINY_BODY_MAX_RETRIES = 2;
// Hard cap on the TOTAL extra time this run will spend on tiny-body retries,
// tracked as a MUTABLE remaining-ms budget shared across the whole webcam loop
// (see `retryBudget` in `main()`), decremented only when a retry actually
// sleeps. The webcam loop already runs sequentially over every registered feed
// inside the CI job's fixed wall-clock budget; a single transient mid-capture
// glitch (the real #4958 case — one webcam) costs one retry and is worth
// absorbing, but a CORRELATED outage across many feeds at once (shared
// upstream widget/CDN serving tiny placeholders) must not compound into
// unbounded added latency that risks the job hitting its timeout before it can
// report — once the budget is exhausted, remaining webcams skip the retry and
// are judged on the first read, same as pre-retry behavior.
//
// This MUST be a budget of time actually spent retrying, not an absolute
// wall-clock deadline from loop start: the loop also spends unrelated time on
// large image downloads and on connection-error retries for OTHER webcams
// (fetchWebcam retries once even on a networkError, see the outer for-loop
// below). An absolute deadline conflates that unrelated latency with the
// retry budget, so a webcam positioned late in the (large, growing) registry
// can silently lose its one-retry protection purely from loop position, even
// though it never itself consumed a retry — issue #5431 (santamariamaggiore.jpg,
// #15 of ~24 feeds, judged broken on a single tiny-body read because ~8
// unreachable feeds earlier in the loop had already burned the deadline).
const WEBCAM_TINY_BODY_RETRY_BUDGET_MS = 60000;

/**
 * Fetch a webcam URL and return {ok, status, bytes}. GET (not HEAD) because the
 * F5 stack and the GIF size check both need the real body. Follows redirects.
 * @param {{remainingMs: number}} [retryBudget] mutable shared budget; a
 *   tiny-body retry only fires while `remainingMs` still covers the retry
 *   delay, and is decremented by that delay when it does (see budget comment
 *   above) — NOT an absolute deadline, so unrelated loop latency (other
 *   webcams' downloads/connection retries) never eats into it.
 */
async function fetchWebcam(url, minBytes = MIN_WEBCAM_BYTES, retryBudget = { remainingMs: WEBCAM_TINY_BODY_RETRY_BUDGET_MS }) {
  // Retry once on a CONNECTION-level failure (DNS/TLS/timeout/reset). Such errors
  // are ambiguous from a single cloud runner — some publisher feeds reach end
  // users fine but block/aren't routable from GitHub-hosted IPs — so a bare
  // network failure must NOT be reported as a confirmed-broken feed (see
  // `networkError` handling in evaluateWebcamResult). An HTTP error status
  // (4xx/5xx) IS a definitive signal and is returned immediately.
  let lastErr = null;
  let tinyResult = null;
  let connectionAttempts = 0;
  let tinyBodyRetries = 0;
  // Connection-level failures get exactly one retry; a tiny body can
  // separately consume up to WEBCAM_TINY_BODY_MAX_RETRIES retries of its own
  // — the two counters are independent so a tiny-body retry never eats into
  // the connection-failure retry allowance or vice versa.
  for (;;) {
    try {
      const cookieHeader = buildCookieHeader();
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Referer': 'https://www4.ti.ch/',
          'Accept': 'image/gif,image/avif,image/webp,image/*,*/*;q=0.8',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        signal: AbortSignal.timeout(WEBCAM_FETCH_TIMEOUT_MS),
      });
      updateCookieJar(res);
      if (!res.ok) {
        // Drain body so the socket frees up.
        await res.arrayBuffer().catch(() => {});
        return { ok: false, status: res.status, bytes: 0 };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const result = { ok: true, status: res.status, bytes: buf.byteLength };
      // A live camera feed can transiently serve a blank/corrupt tiny frame mid-
      // capture (the same single-vantage-point ambiguity as a connection-level
      // error above) and recover on a later fetch. Give it a few more chances
      // (WEBCAM_TINY_BODY_MAX_RETRIES) before treating a tiny body as
      // confirmed-broken, instead of paging on unlucky reads.
      if (
        result.bytes < minBytes &&
        tinyBodyRetries < WEBCAM_TINY_BODY_MAX_RETRIES &&
        retryBudget.remainingMs >= WEBCAM_TINY_BODY_RETRY_DELAY_MS
      ) {
        tinyResult = result;
        tinyBodyRetries++;
        retryBudget.remainingMs -= WEBCAM_TINY_BODY_RETRY_DELAY_MS;
        await new Promise((resolve) => setTimeout(resolve, WEBCAM_TINY_BODY_RETRY_DELAY_MS));
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      connectionAttempts++;
      if (connectionAttempts >= 2) break;
    }
  }
  // A retried tiny body still counts as a real (if unlucky) result, not a
  // connection failure — prefer it over the generic networkError fallback.
  if (tinyResult) return tinyResult;
  // Ran out of connection-level retries → indeterminate, not confirmed broken.
  return { ok: false, status: `error: ${lastErr?.message ?? 'network'}`, bytes: 0, networkError: true };
}

/** Dynamically load the borderCrossings registry from the .ts source (run via tsx). */
async function loadBorderCrossings() {
  const tsPath = path.resolve(process.cwd(), 'data', 'borderCrossings.ts');
  const mod = await import(pathToFileURL(tsPath).href);
  return mod.borderCrossings;
}

function loadCurrentSnapshot() {
  const file = path.resolve(process.cwd(), 'data', 'border-wait-current.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── Orchestration ───────────────────────────────────────────────────

async function main() {
  const staleHours = Number(process.env.STALE_HOURS || DEFAULT_STALE_HOURS);
  const problems = [];
  const lines = [];

  // 1. Staleness backstop.
  const doc = loadCurrentSnapshot();
  if (!doc) {
    problems.push('data/border-wait-current.json is missing');
    lines.push('❌ data/border-wait-current.json missing');
  } else {
    const stale = evaluateStaleness(doc, Date.now(), staleHours);
    const stalenessActive = isStalenessCheckActive(Date.now());
    if (stale.stale && stalenessActive) {
      problems.push(stale.reason);
      lines.push(`❌ STALE: ${stale.reason}`);
    } else if (stale.stale) {
      // Outside the scheduler's active window (overnight): the snapshot is
      // expected to be old, so the backstop is informational only — never
      // pages — to avoid nightly false-positive alert fatigue.
      lines.push(
        `ℹ️ Staleness skipped (outside active window ${STALE_ACTIVE_START_UTC_HOUR}:00–${STALE_ACTIVE_END_UTC_HOUR}:00 UTC); snapshot ${stale.ageMinutes ?? '?'} min old`,
      );
    } else {
      lines.push(`✅ Freshness OK: snapshot ${stale.ageMinutes} min old (threshold ${staleHours}h)`);
    }

    // 2. All-mock source (time-independent — always evaluated).
    const mockEval = evaluateAllMockSource(doc);
    if (mockEval.allMock) {
      problems.push(mockEval.reason);
      lines.push(`❌ ALL-MOCK: ${mockEval.reason}`);
    } else if (mockEval.total > 0) {
      lines.push(`✅ Source OK: ${mockEval.mock}/${mockEval.total} crossings on mock (not all)`);
    }
  }

  // 3. Webcam health.
  let crossings = [];
  try {
    crossings = await loadBorderCrossings();
  } catch (err) {
    problems.push(`Could not load borderCrossings.ts: ${err.message}`);
    lines.push(`❌ Could not load borderCrossings registry: ${err.message}`);
  }
  const webcamUrls = collectWebcamUrls(crossings);
  if (webcamUrls.size === 0 && crossings.length > 0) {
    lines.push('ℹ️ No webcams configured in registry');
  }
  const brokenWebcams = [];
  const webcamObservations = [];
  let indeterminateWebcams = 0;
  // Shared once for the whole loop (not renewed per webcam) so the tiny-body
  // retry budget is a hard cap on TOTAL time actually spent retrying across
  // this run, not a per-webcam allowance — see WEBCAM_TINY_BODY_RETRY_BUDGET_MS
  // comment. Mutable object (not an absolute deadline) so unrelated loop
  // latency never depletes it.
  const retryBudget = { remainingMs: WEBCAM_TINY_BODY_RETRY_BUDGET_MS };
  for (const { url, crossings: served, label, minBytes } of webcamUrls.values()) {
    const result = await fetchWebcam(url, minBytes ?? MIN_WEBCAM_BYTES, retryBudget);
    const verdict = evaluateWebcamResult(result, minBytes ?? MIN_WEBCAM_BYTES);
    webcamObservations.push({ url, label, served, verdict });
    if (verdict.broken) {
      brokenWebcams.push({ url, served, label, reason: verdict.reason });
      lines.push(`❌ WEBCAM BROKEN: ${url} (${verdict.reason}) — serves: ${served.join(', ')}`);
    } else if (verdict.indeterminate) {
      indeterminateWebcams++;
      lines.push(`⚠️ Webcam UNREACHABLE from monitor (not paged): ${url} (${verdict.reason}) — serves: ${served.join(', ')}`);
    } else {
      lines.push(`✅ Webcam OK: ${url} (${(result.bytes / 1024).toFixed(0)}KB) — serves: ${served.join(', ')}`);
    }
  }
  if (brokenWebcams.length > 0) {
    problems.push(`${brokenWebcams.length} broken webcam(s): ${brokenWebcams.map((b) => b.url).join(', ')}`);
  }
  if (indeterminateWebcams > 0) {
    lines.push(`ℹ️ ${indeterminateWebcams} webcam(s) unreachable from the monitor's IP but not confirmed broken (no page).`);
  }

  // 3b. Post-downtime recovery alert (issue #6644). Computed against the state
  // the PREVIOUS run persisted, so a feed that comes back while another one is
  // still broken is announced instead of being swallowed by the aggregate
  // "all healthy -> close the issue" signal. Never a `problem`: a recovery must
  // not page, it must be VISIBLE — the lines below ride along in the health
  // report that the workflow embeds in the canonical issue comment.
  const recoveredLines = [];
  if (webcamObservations.length > 0) {
    const { state, recovered } = applyWebcamStatus(loadWebcamStatus(), webcamObservations, Date.now());
    saveWebcamStatus(state);
    for (const r of recovered) {
      const line = `🔄 WEBCAM RECOVERED: ${r.url} — back online after ${formatDowntime(r.offlineForMs)}${r.served.length ? ` — serves: ${r.served.join(', ')}` : ''}`;
      recoveredLines.push(line);
      lines.push(line);
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    // Emitted on healthy runs too (the `summary` output below is degraded-only),
    // so the workflow can surface a recovery even when nothing is broken. Same
    // backtick/quote sanitation as `summary`: it lands in a bash heredoc too.
    const recoveredOut = recoveredLines.join('\n').replace(/[`"]/g, "'");
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `recovered<<EOF_RECOVERED\n${recoveredOut}\nEOF_RECOVERED\n`,
    );
  }

  // ── Summary ──
  const healthy = problems.length === 0;
  console.log('── Border live-data health report ──');
  for (const l of lines) console.log(l);
  console.log('────────────────────────────────────');
  if (healthy) {
    console.log(`✅ ALL HEALTHY (${webcamUrls.size} webcam URLs checked)`);
    process.exit(0);
  }
  console.log(`❌ DEGRADED — ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  • ${p}`);
  // Emit a machine-readable summary for the workflow to slot into the issue body.
  if (process.env.GITHUB_OUTPUT) {
    // Strip backticks and double-quotes: the workflow embeds this summary inside
    // a bash double-quoted heredoc (`--description "... ${HEALTH_SUMMARY} ..."`),
    // where a `"` would close the string and a backtick would trigger command
    // substitution. URLs/reasons don't contain them today, but sanitize defensively.
    const summary = lines.join('\n').replace(/[`"]/g, "'");
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `summary<<EOF_SUMMARY\n${summary}\nEOF_SUMMARY\n`,
    );
  }
  process.exit(1);
}

// Run only when invoked directly (not when imported by the test).
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[check-border-data-health] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
