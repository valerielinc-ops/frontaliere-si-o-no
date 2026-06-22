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
const IP_DISCRIMINATING_STATUSES = new Set([401, 403, 407, 429, 451]);

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
// Outside it the snapshot is legitimately old (scheduler idle overnight), and
// webcam-health + all-mock checks are time-independent so they always run.
//
// The START is deliberately LATER than the traffic-scheduler's first morning
// cron, not aligned to it. The scheduler's morning ramp is `*/30 4-7` UTC
// (weekday) / `0 6,…` (weekend), but two effects make data NOT reliably fresh
// at 05:00:
//   1. GitHub Actions delivers scheduled runs LATE (top-of-hour crons routinely
//      lag 10–60+ min), so the 04:00/04:30 collections may not have LANDED yet.
//   2. isStalenessCheckActive() is evaluated at EXECUTION time, not the nominal
//      cron time — so a delayed *overnight* watchdog run (e.g. the 00:00 cron
//      delivered at 05:05) leaks into the window while the freshest snapshot is
//      still the prior evening's ~19:00 collection (>6h old → false page).
// Both bit us in issue #2587 (00:00 run executed 05:05 Mon, snapshot 591 min
// old). Arming at 08:00 clears the entire morning ramp + cron-lag margin: by
// then the 04:00–07:30 weekday (or 06:00 weekend) collections have certainly
// landed, so any snapshot older than the 6h threshold is a REAL freeze. The
// fast 90-min freshness loop (traffic-data-freshness.yml) still covers the
// commute window, and this backstop only needs to catch a fully-frozen pipeline
// — which the 12:00/18:00 runs still detect. If the scheduler's morning cron
// moves, revisit this constant.
const STALE_ACTIVE_START_UTC_HOUR = 8;
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
  // An access-control / rate-limit / geo-block status (401/403/407/429/451) from
  // the monitor's single cloud IP is INDETERMINATE for the same reason a TCP
  // failure is: such layers routinely block datacenter ranges while serving
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
 * @param {Array<{name?: string, webcams?: Array<{imageUrl?: string, label?: string}>}>} crossings
 * @returns {Map<string, {url: string, crossings: string[], label: string|null}>}
 */
export function collectWebcamUrls(crossings) {
  const map = new Map();
  for (const c of crossings || []) {
    for (const w of c?.webcams || []) {
      const url = w?.imageUrl;
      if (!url) continue;
      if (!map.has(url)) map.set(url, { url, crossings: [], label: w?.label ?? null });
      map.get(url).crossings.push(c?.name ?? '(unnamed)');
    }
  }
  return map;
}

// ── Network (not unit-tested; exercised live) ───────────────────────

// F5 BIG-IP ASM on www4.ti.ch sets session cookies on the first response;
// subsequent cookieless requests from the same IP get 403. The shared cookie-jar
// (scripts/lib/tiChCookieJar.mjs) re-uses cookies across requests, same as
// scripts/analyze-webcam-frame.mjs.

/**
 * Fetch a webcam URL and return {ok, status, bytes}. GET (not HEAD) because the
 * F5 stack and the GIF size check both need the real body. Follows redirects.
 */
async function fetchWebcam(url) {
  // Retry once on a CONNECTION-level failure (DNS/TLS/timeout/reset). Such errors
  // are ambiguous from a single cloud runner — some publisher feeds reach end
  // users fine but block/aren't routable from GitHub-hosted IPs — so a bare
  // network failure must NOT be reported as a confirmed-broken feed (see
  // `networkError` handling in evaluateWebcamResult). An HTTP error status
  // (4xx/5xx) IS a definitive signal and is returned immediately.
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
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
      return { ok: true, status: res.status, bytes: buf.byteLength };
    } catch (err) {
      lastErr = err;
    }
  }
  // Both attempts hit a connection-level error → indeterminate, not confirmed broken.
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
  let indeterminateWebcams = 0;
  for (const { url, crossings: served, label } of webcamUrls.values()) {
    const result = await fetchWebcam(url);
    const verdict = evaluateWebcamResult(result);
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
