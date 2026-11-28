#!/usr/bin/env node
/**
 * Weekly audit of the locale-router's Workers Logs.
 *
 * The other Cloudflare monitors read Analytics (status counts). This one reads
 * the logs themselves, the only source that says WHO generates the volume: the
 * ten findings of the 2026-10-30 audit became the ten checks below. Each failing
 * check opens one backlog issue with a stable title; a green run closes it.
 *
 * Counts come back from a sampled log store. Absolute thresholds are compared
 * after dividing by `head_sampling_rate`, while shares need no correction.
 */
import { createGithubIssue, resolveGithubIssue } from './lib/github-issue-creator.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';

export const WORKER_NAME = 'frontaliere-locale-router';
export const ISSUE_TITLE_PREFIX = 'Cloudflare observability: ';
export const SAMPLING_CUTOVER = '2026-12-01';
export const WINDOW_DAYS = 7;
// The receipt needs one rate-bearing settings mutation before its seven-day
// window to establish the state at the left boundary. Locale-router deploys
// normally provide several such records; without one the receipt fails closed.
export const SAMPLING_HISTORY_LOOKBACK_DAYS = 30;
// First full window after the fixes of 2026-10-30 are live. Earlier runs only
// print: the window still holds the old traffic, and each issue would start an
// autonomous fix for a problem already solved.
export const FIRST_BACKLOG_RUN = '2026-11-09';
export const DRY_RUN_COMMAND =
  'node scripts/cf-observability-audit.mjs --dry-run';

// Cloudflare Observability paid allowances, per billing cycle.
const INCLUDED_INGEST_GB = 50;
const INCLUDED_STORAGE_GB_MONTH = 10;
const RETENTION_DAYS = 7;
const UTC_DAY_MS = 864e5;

const INTERNAL_CRAWLER_UA = 'frontaliere-bing-tree-crawler';
export const WAF_BLOCKED_UAS = ['Baiduspider', 'CorsairBot', 'Chrome/48.0.2564.116', 'Chrome/99.0.4844.51'];
// The WAF rule scopes the legacy Chrome signatures to Chinese source IPs. A
// Workers Log is an invocation that made it past the WAF, so counting those UAs
// without the same country predicate falsely reports legitimate old browsers
// outside China as a firewall leak.
const WAF_BLOCKED_UA_COUNTRY = new Map([
  ['Chrome/48.0.2564.116', 'CN'],
  ['Chrome/99.0.4844.51', 'CN'],
]);
const VERSION_PATHS = ['/commit-hash.txt', '/build-id.txt'];
const AUTOMATED_UA_RE = /bot|crawl|spider|python|curl|wget|scrapy|go-http|axios|java\//i;
const WELCOMED_UA_RE =
  /googlebot|bingbot|applebot|gptbot|oai-searchbot|chatgpt|claudebot|claude-user|perplexity|duckduck|yandex|exasearchbot|reflectionbot|shapbot|frontaliere/i;

const USER_AGENT = '$workers.event.request.headers.user-agent';
const REQUEST_COUNTRY = '$workers.event.request.cf.country';
const LOG_MESSAGE = '$metadata.message';
const STRUCTURED_EVENT = 'event';
const ORIGIN_FAILURE_EVENT = 'origin_failure';
const JOB_CANON_V2_SUCCESS_EVENT = 'job_canon_v2_success';
const JOB_CANON_V1_FALLBACK_EVENT = 'job_canon_v1_fallback';
// Cloudflare aggregate sample intervals can drift slightly above the configured
// full-sampling value because of floating-point serialization. Values below 1
// are partial samples and must remain blockers; accept only the observed
// upward noise, capped at 0.002%.
const FULL_SAMPLING_INTERVAL_MAX_NOISE = 2e-5;
const filter = (key, operation, value, type = 'string') => ({ key, operation, value, type });

export function isCloudflareFullSamplingInterval(interval) {
  return Number.isFinite(interval)
    && interval >= 1
    && interval <= 1 + FULL_SAMPLING_INTERVAL_MAX_NOISE;
}

// Workers Logs stores a structured `console.log({event, ...})` as an event of
// `$metadata.type = "cf-worker"` with an empty `$metadata.message`; the payload
// is indexed under the bare key `event` (probed live 2026-11-28: `event eq`
// matches, `source.event eq` matches nothing, and `$metadata.type =
// cf-worker-log` matches nothing). The type is therefore NOT filtered: the
// structured key or the legacy JSON-string message identifies the signal.
const STRUCTURED_LOG_EVENT_TYPES = new Set(['cf-worker', 'cf-worker-log']);

function buildStructuredLogFilters(eventName, legacyMessageToken) {
  return [
    {
      kind: 'group',
      filterCombination: 'or',
      filters: [
        filter(STRUCTURED_EVENT, 'eq', eventName),
        filter(LOG_MESSAGE, 'includes', legacyMessageToken),
      ],
    },
  ];
}

export function buildBlockedUaFilters(ua) {
  const filters = [filter(USER_AGENT, 'includes', ua)];
  const country = WAF_BLOCKED_UA_COUNTRY.get(ua);
  if (country) filters.push(filter(REQUEST_COUNTRY, 'eq', country));
  return filters;
}

export function buildOriginFailureLogFilters() {
  return buildStructuredLogFilters(ORIGIN_FAILURE_EVENT, '"event":"origin_failure"');
}

export function buildJobCanonV2SuccessLogFilters() {
  return buildStructuredLogFilters(JOB_CANON_V2_SUCCESS_EVENT, '"event":"job_canon_v2_success"');
}

export function buildJobCanonV1FallbackLogFilters() {
  return buildStructuredLogFilters(JOB_CANON_V1_FALLBACK_EVENT, '"event":"job_canon_v1_fallback"');
}

export function isOriginFailureLogEvent(event) {
  if (!STRUCTURED_LOG_EVENT_TYPES.has(event?.$metadata?.type)) return false;
  const structuredNames = [
    event?.event,
    typeof event?.source === 'object' && event.source !== null ? event.source.event : undefined,
  ].filter((value) => typeof value === 'string');
  if (structuredNames.length > 0) {
    return structuredNames.every((value) => value === ORIGIN_FAILURE_EVENT);
  }
  return typeof event?.$metadata?.message === 'string'
    && event.$metadata.message.includes('"event":"origin_failure"');
}

const share = (part, total) => (total > 0 ? part / total : 0);
const pct = (value) => `${(value * 100).toFixed(1)}%`;

export function estimateMonthlyLogVolume({ events, avgEventBytes }) {
  const ingestGb = (events * avgEventBytes * (30 / WINDOW_DAYS)) / 1e9;
  return { ingestGb, storageGbMonth: (ingestGb / 30) * RETENTION_DAYS };
}

// Largest per-day sampleInterval at which "zero v1 fallbacks observed" still
// counts as evidence. 10 covers the Worker head sampling of 0.1 (from
// SAMPLING_CUTOVER) and the adaptive sampling Workers Observability applies to
// queries. A coarser interval (the live 7-day grouped query returns 100) says
// almost nothing about absence, so it blocks instead of being averaged away.
export const JOB_CANON_MAX_SAMPLE_INTERVAL = 10;
const JOB_CANON_CDN_BASE = 'https://cdn.frontaliereticino.ch';
const JOB_CANON_V2_SHARD_COUNT = 4096;
const PARITY_MISMATCH_EXAMPLES = 20;
const PARITY_FETCH_CONCURRENCY = 16;
const PARITY_FETCH_TIMEOUT_MS = 20_000;

// Mirror of jobCanonV2ShardKey in infra/cloudflare-worker/locale-router.js
// (a test pins the two together); the worker module is not imported because it
// carries Cloudflare-only dependencies.
export function jobCanonV2ShardKey(slug) {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = ((h * 33) ^ slug.charCodeAt(i)) >>> 0;
  return (h % JOB_CANON_V2_SHARD_COUNT).toString(16).padStart(3, '0');
}

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * Structural proof that every slug of the published v1 shards is also in the v2
 * shards with the same redirect semantics (same entry: section prefix per
 * locale and `alias` paths). `v1Shards`/`v2Shards` map a shard key to the parsed
 * object, or null when the shard does not exist. A v1 slug whose v2 shard is
 * missing or lacks it, or holds a different entry, is a mismatch.
 */
export function evaluateJobCanonParity({ v1Shards, v2Shards, buildId = null, paritySource = null }) {
  const mismatches = [];
  let mismatchCount = 0;
  let checkedV1Slugs = 0;
  const note = (slug, reason) => {
    mismatchCount += 1;
    if (mismatches.length < PARITY_MISMATCH_EXAMPLES) mismatches.push({ slug, reason });
  };
  for (const [shardKey, shard] of Object.entries(v1Shards ?? {})) {
    if (shard === null || shard === undefined) continue;
    if (typeof shard !== 'object' || Array.isArray(shard)) {
      note(`v1:${shardKey}`, 'v1-shard-malformed');
      continue;
    }
    for (const [slug, entry] of Object.entries(shard)) {
      checkedV1Slugs += 1;
      const v2Key = jobCanonV2ShardKey(slug);
      const v2Shard = v2Shards?.[v2Key];
      if (v2Shard === null || v2Shard === undefined) note(slug, `v2-shard-missing:${v2Key}`);
      else if (typeof v2Shard !== 'object' || !Object.hasOwn(v2Shard, slug)) note(slug, `v2-slug-missing:${v2Key}`);
      else if (stableJson(v2Shard[slug]) !== stableJson(entry)) note(slug, `entry-differs:${v2Key}`);
    }
  }
  return {
    v1SubsetOfV2: mismatchCount === 0,
    paritySource,
    buildId,
    checkedV1Slugs,
    mismatchCount,
    mismatches,
  };
}

async function fetchShard(url, fetchImpl) {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(PARITY_FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'frontaliere-cf-observability-audit/1.0' },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const json = await res.json();
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`malformed shard ${url}`);
  return json;
}

async function mapLimited(items, limit, task) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index]);
    }
  }));
  return out;
}

/**
 * Reads the job-canon release the Worker is serving (the `/cdn-build-id.txt`
 * marker, then `/job-canon/releases/<buildId>/...`, exactly like the Worker)
 * and compares v1 against v2. No durable v1/v2 parity receipt exists at publish
 * time (the publish receipt/handshake prove identity and byte equality of the
 * shards, not v1 vs v2), so the live release is read. Any read failure yields
 * `v1SubsetOfV2: false` with `error`: absence of proof never reads as parity.
 */
export async function collectJobCanonParity({ fetchImpl = fetch, base = JOB_CANON_CDN_BASE } = {}) {
  try {
    const markerRes = await fetchImpl(`${base}/cdn-build-id.txt`, {
      signal: AbortSignal.timeout(PARITY_FETCH_TIMEOUT_MS),
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'frontaliere-cf-observability-audit/1.0' },
    });
    if (!markerRes.ok) throw new Error(`build marker HTTP ${markerRes.status}`);
    const buildId = (await markerRes.text()).trim();
    if (!/^\d{1,20}$/.test(buildId)) throw new Error('build marker is not a numeric build id');
    const root = `${base}/job-canon/releases/${buildId}`;
    const alnum = [...'abcdefghijklmnopqrstuvwxyz0123456789_'];
    const v1Keys = alnum.flatMap((a) => alnum.map((b) => `${a}${b}`));
    const v1List = await mapLimited(v1Keys, PARITY_FETCH_CONCURRENCY, (key) => fetchShard(`${root}/${key}.json`, fetchImpl));
    const v1Shards = Object.fromEntries(v1Keys.map((key, i) => [key, v1List[i]]));
    const needed = new Set();
    for (const shard of v1List) {
      for (const slug of Object.keys(shard ?? {})) needed.add(jobCanonV2ShardKey(slug));
    }
    const v2Keys = [...needed].sort();
    const v2List = await mapLimited(v2Keys, PARITY_FETCH_CONCURRENCY, (key) => fetchShard(`${root}/v2/${key}.json`, fetchImpl));
    const v2Shards = Object.fromEntries(v2Keys.map((key, i) => [key, v2List[i]]));
    return evaluateJobCanonParity({
      v1Shards,
      v2Shards,
      buildId,
      paritySource: `live-release:${base}/job-canon/releases/${buildId}`,
    });
  } catch (error) {
    return {
      v1SubsetOfV2: false,
      paritySource: 'unavailable',
      buildId: null,
      checkedV1Slugs: 0,
      mismatchCount: 0,
      mismatches: [],
      error: String(error?.message ?? error).slice(0, 200),
    };
  }
}

const isSampleInterval = (value) => Number.isFinite(value) && value >= 1;
const round = (value, digits = 6) => Number(value.toFixed(digits));

/**
 * Probability that a v1 fallback that really happened would have gone unseen,
 * given the per-day sample intervals of the v2 stream. Each stored event is one
 * of `sampleInterval` real ones, so a single event is observed with probability
 * 1/interval. A fallback is as likely on any request, so the per-event miss
 * probability weights each day by its estimated v2 volume (count x interval).
 * `ifNEvents` assumes independent sampling: n fallbacks all go unseen with
 * probability p^n. This is a declared residual risk, never a proof of absence.
 */
export function estimateFallbackMissProbability(days) {
  const usable = days.filter((d) => isSampleInterval(d.sampleInterval) && d.count > 0);
  const volume = usable.reduce((sum, d) => sum + d.count * d.sampleInterval, 0);
  if (usable.length === 0 || volume === 0) return null;
  const perEvent = usable.reduce(
    (sum, d) => sum + d.count * d.sampleInterval * (1 - 1 / d.sampleInterval),
    0,
  ) / volume;
  return {
    perEvent: round(perEvent),
    ifNEvents: Object.fromEntries([1, 10, 100].map((n) => [n, round(perEvent ** n)])),
    basis: 'v2-volume-weighted per-day sampleInterval; independent sampling assumed',
  };
}

export function evaluateJobCanonV1Retirement(snapshot) {
  const expectedSamplingDays = Array.isArray(snapshot.workerLogSamplingExpectedDays)
    ? snapshot.workerLogSamplingExpectedDays
    : [];
  const v2Daily = (Array.isArray(snapshot.jobCanonV2Daily) ? snapshot.jobCanonV2Daily : [])
    .filter((d) => typeof d?.day === 'string' && d.count > 0);
  const observedDays = [...new Set(v2Daily.map((d) => d.day))].sort();
  const queryWindowDays = Number.isFinite(snapshot.queryWindowDays) ? snapshot.queryWindowDays : 0;
  const windowComplete = queryWindowDays >= WINDOW_DAYS && observedDays.length >= WINDOW_DAYS;
  const streamSamplingBuckets = Array.isArray(snapshot.workerLogSamplingBuckets)
    ? snapshot.workerLogSamplingBuckets
    : [];
  const streamSamplingBlockers = [];
  if (expectedSamplingDays.length === 0) streamSamplingBlockers.push('coverage:unknown');
  const bucketsByDay = new Map();
  for (const bucket of streamSamplingBuckets) {
    if (typeof bucket?.day !== 'string' || bucketsByDay.has(bucket.day)) {
      streamSamplingBlockers.push('shape:duplicate-or-unknown-day');
      continue;
    }
    bucketsByDay.set(bucket.day, bucket);
  }
  for (const day of expectedSamplingDays) {
    const bucket = bucketsByDay.get(day);
    if (!bucket) {
      streamSamplingBlockers.push(`coverage:${day}:missing`);
      continue;
    }
    if (bucket.rows !== 1 || !Number.isFinite(bucket.count) || bucket.count <= 0) {
      streamSamplingBlockers.push(`coverage:${day}:empty-or-ambiguous`);
    }
  }
  for (const day of bucketsByDay.keys()) {
    if (!expectedSamplingDays.includes(day)) streamSamplingBlockers.push(`coverage:${day}:unexpected`);
  }
  const v2SuccessLogs = Number.isFinite(snapshot.jobCanonV2SuccessLogs)
    ? snapshot.jobCanonV2SuccessLogs
    : 0;
  const v1FallbackLogs = Number.isFinite(snapshot.jobCanonV1FallbackLogs)
    ? snapshot.jobCanonV1FallbackLogs
    : 0;
  const blockers = [];
  if (!windowComplete) blockers.push(`v2-days:${observedDays.length}/${WINDOW_DAYS}`);
  // Partial sampling is admitted: the effective interval is recorded below.
  // Only a missing or malformed interval is ambiguous and blocks.
  const badV2Intervals = v2Daily.filter((d) => !isSampleInterval(d.sampleInterval));
  if (badV2Intervals.length > 0) {
    blockers.push(`sampling-signal:invalid:${badV2Intervals.map((d) => d.day).join(',')}`);
  }
  // Partial sampling is admitted only up to JOB_CANON_MAX_SAMPLE_INTERVAL.
  for (const d of v2Daily) {
    if (isSampleInterval(d.sampleInterval) && d.sampleInterval > JOB_CANON_MAX_SAMPLE_INTERVAL) {
      blockers.push(`sampling-interval-too-coarse:${d.day}:${d.sampleInterval}`);
    }
  }
  const parity = snapshot.jobCanonParity ?? null;
  if (parity?.v1SubsetOfV2 !== true) {
    blockers.push(parity?.error || !parity
      ? `v1-parity:unverified:${parity?.error ?? 'missing'}`
      : `v1-parity:mismatch:${parity.mismatchCount ?? parity.mismatches?.length ?? 'unknown'}`);
  }
  const badStreamIntervals = streamSamplingBuckets.filter(
    (bucket) => bucket?.count > 0 && !isSampleInterval(bucket.sampleInterval),
  );
  if (badStreamIntervals.length > 0) {
    blockers.push(`sampling-stream:invalid:${badStreamIntervals.map((b) => b.day).join(',')}`);
  }
  for (const blocker of streamSamplingBlockers) blockers.push(`sampling-stream:${blocker}`);
  if (v2SuccessLogs === 0) blockers.push('v2-success:0');
  if (v1FallbackLogs !== 0) blockers.push(`v1-fallback:${v1FallbackLogs}`);

  const sampleIntervalsByDay = Object.fromEntries(
    v2Daily.map((d) => [d.day, d.sampleInterval ?? null]),
  );
  return {
    schemaVersion: 4,
    windowDays: WINDOW_DAYS,
    queryWindowDays,
    observedV2Days: observedDays.length,
    firstV2Day: observedDays[0] ?? null,
    lastV2Day: observedDays.at(-1) ?? null,
    v2SuccessLogs,
    v1FallbackLogs,
    samplingRate: snapshot.samplingRate ?? null,
    // Informational: the receipt no longer requires full sampling.
    sampleIntervalsByDay,
    v2Daily,
    v1Daily: Array.isArray(snapshot.jobCanonV1Daily) ? snapshot.jobCanonV1Daily : [],
    maxSampleInterval: JOB_CANON_MAX_SAMPLE_INTERVAL,
    fallbackMissProbability: estimateFallbackMissProbability(v2Daily),
    v1SubsetOfV2: parity?.v1SubsetOfV2 === true,
    paritySource: parity?.paritySource ?? null,
    parityBuildId: parity?.buildId ?? null,
    checkedV1Slugs: parity?.checkedV1Slugs ?? 0,
    mismatches: Array.isArray(parity?.mismatches) ? parity.mismatches.slice(0, PARITY_MISMATCH_EXAMPLES) : [],
    parityError: parity?.error ?? null,
    workerLogSamplingExpectedDays: expectedSamplingDays,
    workerLogSamplingBuckets: streamSamplingBuckets,
    samplingHistory: snapshot.samplingHistory ?? null,
    ready: blockers.length === 0,
    blockers,
  };
}

/**
 * The ten checks. Pure: `s` is the snapshot built by collectSnapshot.
 * Returns only the failing ids' findings plus the list of all ids.
 */
export function evaluateChecks(s, now = new Date()) {
  const samplingKnown = Number.isFinite(s.samplingRate) && s.samplingRate > 0;
  const scale = samplingKnown ? 1 / s.samplingRate : 1;
  const volume = estimateMonthlyLogVolume({ events: s.total, avgEventBytes: s.avgEventBytes });
  const blocked = Object.values(s.blockedRequests).reduce((sum, n) => sum + n, 0);
  const unknownBots = s.topUserAgents.filter(
    ({ ua, count }) => AUTOMATED_UA_RE.test(ua) && !WELCOMED_UA_RE.test(ua) && share(count, s.total) > 0.05,
  );
  const checks = [
    {
      id: '5xx-burst',
      title: 'burst di 503 sul router',
      failed: s.max503PerBucket * scale >= 500,
      value: `${Math.round(s.max503PerBucket * scale)} 503 in un bucket (totale ${Math.round(s.count503 * scale)})`,
      target: 'meno di 500 per bucket',
      fix: 'Leggere le righe `origin_failure` del periodo per causa e path, poi correggere l\'origine o estendere lo stale-if-error.',
    },
    {
      id: 'origin-failure-cause',
      title: 'segnale origin_failure assente durante i 503',
      failed: s.count503 * scale >= 50 && s.originFailureLogs === 0,
      value: `${s.count503} eventi di invocazione 503 e ${s.originFailureLogs} eventi log origin_failure strutturati (aggregati separati)`,
      target: 'con 503 nel periodo, almeno un log origin_failure strutturato; nessuna pretesa di copertura 1:1 senza join per invocazione',
      fix: 'Verificare che i percorsi di errore chiamino `logEdgeFailure` e classificare separatamente gli eventi `cf-worker-log`.',
    },
    {
      id: 'internal-crawler-share',
      title: 'crawler interno oltre il 25% del traffico',
      failed: share(s.internalCrawlerRequests, s.total) > 0.25,
      value: pct(share(s.internalCrawlerRequests, s.total)),
      target: 'massimo 25%',
      fix: 'Controllare la cadenza settimanale del tree crawl in bing-seo-loop.yml.',
    },
    {
      id: '404-share',
      title: '404 oltre il 5% delle richieste',
      failed: share(s.count404, s.total) > 0.05,
      value: pct(share(s.count404, s.total)),
      target: 'massimo 5%',
      fix: 'Raggruppare i path 404 per famiglia e ricreare le pagine di ricerca o correggere i link che li generano.',
    },
    {
      id: 'version-files-share',
      title: 'file di versione oltre il 3% delle richieste',
      failed: share(s.versionRequests, s.total) > 0.03,
      value: pct(share(s.versionRequests, s.total)),
      target: 'massimo 3%',
      fix: 'Controllare chi chiama /commit-hash.txt e /build-id.txt: il client deve farlo solo con il badge visibile.',
    },
    {
      id: 'blocked-bot-leak',
      title: 'bot bloccati ancora serviti dal Worker',
      failed: blocked * scale >= 1000,
      value: JSON.stringify(s.blockedRequests),
      target: 'meno di 1000 a settimana',
      fix: 'Verificare la regola locale-bot-throttle in scripts/cf-locale-failover-setup.mjs e la sua applicazione alla zona.',
    },
    {
      id: 'unknown-bot-share',
      title: 'bot sconosciuto oltre il 5% del traffico',
      failed: unknownBots.length > 0,
      value: unknownBots.map(({ ua, count }) => `${ua.slice(0, 80)}: ${pct(share(count, s.total))}`).join('; ') || 'nessuno',
      target: 'nessun bot non governato sopra il 5%',
      fix: 'Decidere se accoglierlo in WELCOMED_UA_RE o bloccarlo in BLOCKED_CRAWLER_UAS.',
    },
    {
      id: 'googlebot-301-share',
      title: 'Googlebot spreca oltre il 10% del crawl in 301',
      // Baseline 8%, measured 2026-10-30: job URLs under a former canton that Google
      // re-checks. Only 15 of 11,355 were still in the sitemaps, so it decays alone.
      failed: share(s.googlebot301, s.googlebotTotal) > 0.1,
      value: pct(share(s.googlebot301, s.googlebotTotal)),
      target: 'massimo 10%',
      fix: 'Raggruppare i path 301 di Googlebot e aggiornare sitemap o link interni alla destinazione finale.',
    },
    {
      id: 'log-privacy-settings',
      title: 'query string non oscurate nei log',
      failed: s.redactQueryString !== true,
      value: `redact_query_string=${s.redactQueryString}`,
      target: 'redact_query_string=true',
      fix: 'Rieseguire scripts/cf-worker-observability-settings.mjs e verificare il passo in deploy-worker.yml.',
    },
    {
      id: 'log-budget',
      title: 'volume log oltre l\'allowance Cloudflare',
      // Volume is free before the cutover, and the owner keeps 100% sampling until
      // then: an earlier issue would invite an autonomous fix to lower it too soon.
      failed:
        now.toISOString().slice(0, 10) >= SAMPLING_CUTOVER &&
        (!samplingKnown ||
          volume.ingestGb > INCLUDED_INGEST_GB ||
          volume.storageGbMonth > INCLUDED_STORAGE_GB_MONTH ||
          s.samplingRate > 0.1),
      value: `~${volume.ingestGb.toFixed(0)} GB/mese, ~${volume.storageGbMonth.toFixed(1)} GB-mese, sampling ${s.samplingRate ?? 'unknown'}`,
      target: `massimo ${INCLUDED_INGEST_GB} GB e ${INCLUDED_STORAGE_GB_MONTH} GB-mese; sampling massimo 0.1 dal ${SAMPLING_CUTOVER}`,
      fix: 'Controllare la PR del cutover del sampling, poi ridurre il traffico che genera eventi prima di abbassare ancora il rate.',
    },
  ];
  return checks;
}

export function issueTitle(check) {
  return `${ISSUE_TITLE_PREFIX}${check.title}`;
}

export function buildIssueBody(check) {
  return [
    `Rilevato dall'audit settimanale di Workers Logs su \`${WORKER_NAME}\` (ultimi ${WINDOW_DAYS} giorni).`,
    '',
    `- Valore misurato: ${check.value}`,
    `- Obiettivo: ${check.target}`,
    '',
    buildScheda({
      causa: `Il controllo \`${check.id}\` e' fuori soglia: va confermato nei log quale traffico lo genera.`,
      fix: check.fix,
      metrica: `prima=${check.value} atteso=${check.target}`,
      comando: DRY_RUN_COMMAND,
      osservatore: 'cf-observability-audit.yml: ogni settimana rimisura, commenta se resta rossa e chiude la issue quando torna verde.',
      fallimento: issueTitle(check),
    }),
  ].join('\n');
}

async function telemetry(body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/workers/observability/telemetry/query`;
  let lastError = 'no attempt';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (res.ok && json.success !== false) return json.result;
      lastError = `HTTP ${res.status} ${JSON.stringify(json.errors ?? [])}`;
    } catch {
      lastError = `HTTP ${res.status} non-JSON answer`;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
  }
  throw new Error(`telemetry query failed: ${lastError}`);
}

function logSamplingRate(value) {
  const rate = value?.observability?.logs?.head_sampling_rate;
  return Number.isFinite(rate) ? rate : null;
}

function auditMutationKind(entry) {
  const resourceType = entry?.resource?.type ?? '';
  const uri = entry?.raw?.uri?.split('?')[0] ?? '';
  if (resourceType === 'scripts.script-settings' || uri.endsWith(`/workers/scripts/${WORKER_NAME}/script-settings`)) {
    return 'settings';
  }
  if (resourceType === 'scripts.settings' || uri.endsWith(`/workers/scripts/${WORKER_NAME}/settings`)) {
    return 'settings';
  }
  if (resourceType === 'scripts.deployments' || uri.endsWith(`/workers/scripts/${WORKER_NAME}/deployments`)) {
    return 'deployment';
  }
  if (resourceType === 'scripts.versions' || uri.endsWith(`/workers/scripts/${WORKER_NAME}/versions`)) {
    return 'version';
  }
  return null;
}

function auditMutationTime(entry) {
  const timestamp = Date.parse(entry?.action?.time ?? '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function utcDaysInTimeframe(timeframe) {
  if (!Number.isFinite(timeframe?.from) || !Number.isFinite(timeframe?.to) || timeframe.from >= timeframe.to) {
    return [];
  }
  const days = [];
  for (let cursor = Math.floor(timeframe.from / UTC_DAY_MS) * UTC_DAY_MS; cursor < timeframe.to; cursor += UTC_DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

// The Workers Observability query API samples adaptively PER QUERY: the live
// 7-day grouped query returned sampleInterval 100 while a 24 h query of the
// same filter returned 10 and a 6 h one returned 1 (probed 2026-11-28). The
// retirement evidence is therefore queried one UTC day at a time, narrowing a
// day into 6 h and then 1 h windows while its interval stays above the
// threshold. The day's interval is the maximum over its final windows, so a
// coarse sub-window is never averaged away.
export const JOB_CANON_WINDOW_LADDER_MS = [UTC_DAY_MS, 6 * 36e5, 36e5];
// Declared request budget for both signals of one receipt: 8 UTC days at worst
// 1 + 4 + 24 = 29 v2 queries and as many v1 queries each would be 464, so the
// budget caps the total. When it runs out the day keeps its last (coarse)
// interval and the receipt blocks on it; it never throws or claims precision.
export const JOB_CANON_MAX_WINDOW_REQUESTS = 160;

/**
 * @param {(filters: object[], from: number, to: number) => Promise<{count: number, sampleInterval: number|null}>} measure
 */
export async function collectJobCanonDailyWindows({
  measure,
  v2Filters,
  v1Filters,
  timeframe,
  maxInterval = JOB_CANON_MAX_SAMPLE_INTERVAL,
  maxRequests = JOB_CANON_MAX_WINDOW_REQUESTS,
}) {
  let requests = 0;
  const bounded = async (filters, from, to) => {
    requests += 1;
    return measure(filters, from, to);
  };
  const v2Daily = [];
  const v1Daily = [];
  const windowsByDay = {};
  for (const day of utcDaysInTimeframe(timeframe)) {
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const from = Math.max(dayStart, timeframe.from);
    const to = Math.min(dayStart + UTC_DAY_MS, timeframe.to);
    // Returns the leaf windows with their measurement; splits while coarse.
    const narrow = async (a, b, level) => {
      if (requests >= maxRequests) return [{ from: a, to: b, count: 0, sampleInterval: null, exhausted: true }];
      const m = await bounded(v2Filters, a, b);
      const coarse = m.count > 0 && Number.isFinite(m.sampleInterval) && m.sampleInterval > maxInterval;
      const nextSize = JOB_CANON_WINDOW_LADDER_MS[level + 1];
      if (!coarse || nextSize === undefined) return [{ from: a, to: b, ...m }];
      const leaves = [];
      for (let t = a; t < b; t += nextSize) leaves.push(...await narrow(t, Math.min(t + nextSize, b), level + 1));
      return leaves;
    };
    const leaves = await narrow(from, to, 0);
    const count = leaves.reduce((sum, leaf) => sum + leaf.count, 0);
    const exhausted = leaves.some((leaf) => leaf.exhausted);
    // Budget exhaustion makes the day unmeasurable rather than silently clean.
    const intervals = leaves.filter((leaf) => leaf.count > 0 || leaf.exhausted).map((leaf) => leaf.exhausted ? Infinity : leaf.sampleInterval);
    const sampleInterval = exhausted
      ? maxInterval * 10
      : intervals.some((v) => !Number.isFinite(v)) ? null : Math.max(...intervals);
    windowsByDay[day] = leaves.length;
    if (count > 0 || exhausted) v2Daily.push({ day, count, sampleInterval });
    // v1 is probed on exactly the windows v2 needed, so absence is claimed at
    // the same granularity as presence.
    let v1Count = 0;
    let v1Interval = null;
    for (const leaf of leaves) {
      if (requests >= maxRequests) break;
      const m = await bounded(v1Filters, leaf.from, leaf.to);
      v1Count += m.count;
      if (m.count > 0 && Number.isFinite(m.sampleInterval)) v1Interval = Math.max(v1Interval ?? 0, m.sampleInterval);
    }
    if (v1Count > 0) v1Daily.push({ day, count: v1Count, sampleInterval: v1Interval });
  }
  return { v2Daily, v1Daily, requests, windowsByDay };
}

function workerLogSamplingBuckets(calculation) {
  if (!Array.isArray(calculation?.series)) return [];
  return calculation.series.map((series) => {
    const day = typeof series?.time === 'string'
      ? series.time.match(/^(\d{4}-\d{2}-\d{2}) 00:00:00$/)?.[1] ?? null
      : null;
    const rows = Array.isArray(series?.data) ? series.data : [];
    const row = rows.length === 1 ? rows[0] : null;
    return {
      day,
      rows: rows.length,
      count: Number.isFinite(row?.count) ? row.count : null,
      sampleInterval: Number.isFinite(row?.sampleInterval) ? row.sampleInterval : null,
    };
  });
}

export function evaluateSamplingHistory(entries, timeframe) {
  const blockers = [];
  const mutations = [];
  for (const entry of entries) {
    const kind = auditMutationKind(entry);
    if (!kind) continue;
    const actionType = entry?.action?.type;
    const method = entry?.raw?.method;
    const actionOperation = actionType === 'view'
      ? 'read'
      : ['create', 'update', 'delete'].includes(actionType)
        ? 'mutation'
        : 'unknown';
    const methodOperation = method === 'GET'
      ? 'read'
      : ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
        ? 'mutation'
        : 'unknown';
    const operations = [actionOperation, methodOperation];
    if (operations.includes('unknown')
      || (operations.includes('read') && operations.includes('mutation'))) {
      // The receipt may ignore only records whose two classifiers explicitly
      // identify a read. Missing, unknown, malformed, or conflicting values
      // can otherwise hide an unrecognized Worker mutation.
      blockers.push(`${kind}:ambiguous-operation`);
      continue;
    }
    if (operations.every((operation) => operation === 'read') || entry?.action?.result === 'failure') continue;
    if (entry?.action?.result !== 'success') {
      blockers.push(`${kind}:ambiguous-result`);
      continue;
    }
    const timestamp = auditMutationTime(entry);
    if (timestamp === null) {
      blockers.push(`${kind}:invalid-time`);
      continue;
    }
    const rate = kind === 'settings' ? logSamplingRate(entry.resource?.response) : null;
    mutations.push({ kind, timestamp, rate });
  }

  mutations.sort((a, b) => a.timestamp - b.timestamp);
  const settings = mutations.filter(({ kind }) => kind === 'settings');
  const baseline = settings.filter(({ timestamp }) => timestamp <= timeframe.from).at(-1) ?? null;
  if (!baseline) blockers.push('history:no-baseline');
  else if (baseline.rate !== 1) blockers.push(`history:baseline-rate:${baseline.rate ?? 'unknown'}`);

  const windowSettings = settings.filter(({ timestamp }) => timestamp > timeframe.from && timestamp <= timeframe.to);
  for (const mutation of windowSettings) {
    if (mutation.rate !== 1) blockers.push(`history:rate:${mutation.rate ?? 'unknown'}:${new Date(mutation.timestamp).toISOString()}`);
  }

  const windowDeployments = mutations.filter(
    ({ kind, timestamp }) => kind === 'deployment' && timestamp > timeframe.from && timestamp <= timeframe.to,
  );
  for (const deployment of windowDeployments) {
    const confirmed = windowSettings.some(({ timestamp, rate }) =>
      rate === 1 && timestamp >= deployment.timestamp && timestamp - deployment.timestamp <= 5 * 60e3,
    );
    if (!confirmed) blockers.push(`history:deployment-unconfirmed:${new Date(deployment.timestamp).toISOString()}`);
  }

  return {
    schemaVersion: 1,
    complete: blockers.length === 0,
    queryFrom: new Date(timeframe.auditFrom).toISOString(),
    windowFrom: new Date(timeframe.from).toISOString(),
    windowTo: new Date(timeframe.to).toISOString(),
    baselineAt: baseline ? new Date(baseline.timestamp).toISOString() : null,
    baselineRate: baseline?.rate ?? null,
    settingsMutations: windowSettings.length,
    versionUploads: mutations.filter(
      ({ kind, timestamp }) => kind === 'version' && timestamp > timeframe.from && timestamp <= timeframe.to,
    ).length,
    deployments: windowDeployments.length,
    blockers: [...new Set(blockers)],
  };
}

async function collectSamplingHistory(timeframe) {
  const entries = [];
  const seenCursors = new Set();
  const pageLimit = 1000;
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({
      since: new Date(timeframe.auditFrom).toISOString(),
      before: new Date(timeframe.to).toISOString(),
      direction: 'asc',
      limit: String(pageLimit),
      resource_id: WORKER_NAME,
      resource_product: 'workers',
    });
    if (cursor) params.set('cursor', cursor);
    // Audit Logs v2 carries the request/response of script-settings mutations.
    // The resource filters keep pagination bounded without assuming an action
    // name, which Cloudflare may change independently of the endpoint shape.
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/logs/audit?${params}`,
      { headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` } },
    );
    const json = await res.json();
    if (!res.ok || json.success === false || !Array.isArray(json.result)) {
      throw new Error(`audit-logs HTTP ${res.status} ${JSON.stringify(json.errors ?? [])}`);
    }
    entries.push(...json.result);
    pages += 1;
    const resultInfo = json.result_info;
    const rawCount = resultInfo?.count;
    const count = typeof rawCount === 'number'
      ? rawCount
      : typeof rawCount === 'string' && /^\d+$/.test(rawCount)
        ? Number(rawCount)
        : null;
    if (!resultInfo || typeof resultInfo !== 'object'
      || !Number.isSafeInteger(count) || count !== json.result.length) {
      throw new Error('audit-logs pagination metadata has an invalid count');
    }
    if (!Object.hasOwn(resultInfo, 'cursor')) {
      // The live terminal page omits cursor. Its count proves completeness
      // only when fewer records than the requested page limit were returned.
      if (count >= pageLimit) {
        throw new Error('audit-logs page reached its limit without a cursor');
      }
      cursor = null;
      continue;
    }
    const nextCursor = resultInfo.cursor;
    if (nextCursor === null) {
      cursor = null;
      continue;
    }
    if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
      throw new Error('audit-logs pagination returned an invalid cursor');
    }
    if (seenCursors.has(nextCursor)) throw new Error('audit-logs pagination returned a repeated cursor');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (pages >= 100) throw new Error('audit-logs pagination exceeded 100 pages');
  } while (cursor);

  const history = evaluateSamplingHistory(entries, timeframe);
  return { ...history, pages, records: entries.length };
}

const STATUS = '$workers.event.response.status';
const PATH = '$workers.event.path';

export async function collectSnapshot(now = Date.now()) {
  const timeframe = {
    auditFrom: now - (WINDOW_DAYS + SAMPLING_HISTORY_LOOKBACK_DAYS) * 864e5,
    from: now - WINDOW_DAYS * 864e5,
    to: now,
  };
  const service = filter('$metadata.service', 'eq', WORKER_NAME);
  let id = 0;
  const query = async (filters, groupBy, limit = 50) => {
    const result = await telemetry({
      queryId: `cf-observability-audit-${++id}`,
      view: 'calculations',
      limit,
      timeframe: { from: timeframe.from, to: timeframe.to },
      parameters: {
        datasets: [],
        filters: [service, ...filters],
        calculations: [{ operator: 'count' }],
        limit,
        groupBys: groupBy ? [{ type: 'string', value: groupBy }] : [],
        ...(groupBy ? { orderBy: { value: 'count', order: 'desc' } } : {}),
      },
    });
    return result.calculations?.[0] ?? {};
  };
  const count = async (...filters) => (await query(filters)).aggregates?.[0]?.value ?? 0;

  const all503 = await query([filter(STATUS, 'eq', 503, 'number')]);
  const buckets = (all503.series ?? []).map((point) =>
    (point.data ?? []).reduce((sum, row) => sum + (row.value ?? 0), 0),
  );
  const blockedRequests = {};
  for (const ua of WAF_BLOCKED_UAS) blockedRequests[ua] = await count(...buildBlockedUaFilters(ua));
  let versionRequests = 0;
  for (const path of VERSION_PATHS) versionRequests += await count(filter(PATH, 'eq', path));
  // Job-canon evidence is queried per UTC-day window (see
  // collectJobCanonDailyWindows), not as one 7-day grouped query.
  const windowMeasure = async (filters, from, to) => {
    const result = await telemetry({
      queryId: `cf-observability-audit-job-canon-window-${++id}`,
      view: 'calculations',
      limit: 1,
      timeframe: { from, to },
      parameters: {
        datasets: [],
        filters: [service, ...filters],
        calculations: [{ operator: 'count' }],
        limit: 1,
        groupBys: [],
      },
    });
    const row = result.calculations?.[0]?.aggregates?.[0];
    return {
      count: Number.isFinite(row?.value) ? row.value : 0,
      sampleInterval: Number.isFinite(row?.sampleInterval) ? row.sampleInterval : null,
    };
  };
  const { v2Daily: jobCanonV2Daily, v1Daily: jobCanonV1Daily, requests: jobCanonWindowRequests } =
    await collectJobCanonDailyWindows({
      measure: windowMeasure,
      v2Filters: buildJobCanonV2SuccessLogFilters(),
      v1Filters: buildJobCanonV1FallbackLogFilters(),
      timeframe,
    });
  // Cloudflare accepts granularity as a millisecond bucket width and returns
  // these daily series aligned to 00:00:00 UTC. The aggregate is deliberately
  // ignored: each intersecting day must independently prove exact ingestion.
  const workerLogSampling = await telemetry({
    queryId: 'cf-observability-audit-worker-log-sampling',
    view: 'calculations',
    granularity: UTC_DAY_MS,
    limit: 1,
    timeframe: { from: timeframe.from, to: timeframe.to },
    parameters: {
      datasets: [],
      filters: [service],
      calculations: [{ operator: 'count' }],
      limit: 1,
      groupBys: [],
    },
  });
  const workerLogSamplingCalculation = workerLogSampling.calculations?.[0] ?? null;
  const samplingHistory = await collectSamplingHistory(timeframe);

  const events = await telemetry({
    queryId: 'cf-observability-audit-size',
    view: 'events',
    limit: 100,
    timeframe: { from: now - 36e5, to: now },
    parameters: { datasets: [], filters: [service], calculations: [], groupBys: [] },
  });
  const sizes = (events.events?.events ?? []).map((e) => e.$metadata?.eventSize).filter(Number.isFinite);

  const settingsRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/script-settings`,
    { headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` } },
  );
  const settings = await settingsRes.json();
  if (!settingsRes.ok || settings.success === false) throw new Error(`script-settings HTTP ${settingsRes.status}`);
  const observability = settings.result?.observability ?? {};

  return {
    total: await count(),
    count503: all503.aggregates?.[0]?.value ?? 0,
    max503PerBucket: Math.max(0, ...buckets),
    count404: await count(filter(STATUS, 'eq', 404, 'number')),
    // Invocation rows carry request-line messages (for example `GET https://…`),
    // while console.error rows are separate `cf-worker-log` events. The query
    // therefore measures the structured signal only; it cannot claim a 1:1
    // relationship with the independently aggregated response-status rows.
    originFailureLogs: await count(...buildOriginFailureLogFilters()),
    jobCanonV2SuccessLogs: jobCanonV2Daily.reduce((sum, row) => sum + row.count, 0),
    jobCanonV2Daily,
    jobCanonV1FallbackLogs: jobCanonV1Daily.reduce((sum, row) => sum + row.count, 0),
    jobCanonV1Daily,
    jobCanonWindowRequests,
    workerLogSamplingExpectedDays: utcDaysInTimeframe(timeframe),
    workerLogSamplingBuckets: workerLogSamplingBuckets(workerLogSamplingCalculation),
    jobCanonParity: await collectJobCanonParity(),
    samplingHistory,
    queryWindowDays: (timeframe.to - timeframe.from) / 864e5,
    internalCrawlerRequests: await count(filter(USER_AGENT, 'includes', INTERNAL_CRAWLER_UA)),
    versionRequests,
    blockedRequests,
    topUserAgents: ((await query([], USER_AGENT)).aggregates ?? []).map((row) => ({ ua: row.groupKey ?? '', count: row.value })),
    googlebotTotal: await count(filter(USER_AGENT, 'includes', 'Googlebot')),
    googlebot301: await count(filter(USER_AGENT, 'includes', 'Googlebot'), filter(STATUS, 'eq', 301, 'number')),
    avgEventBytes: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : 0,
    samplingRate: Number.isFinite(observability.logs?.head_sampling_rate)
      ? observability.logs.head_sampling_rate
      : null,
    redactQueryString: observability.redact_query_string,
  };
}

export function isReportOnly(now = new Date()) {
  return now.toISOString().slice(0, 10) < FIRST_BACKLOG_RUN;
}

export async function main({ dryRun = process.argv.includes('--dry-run') || isReportOnly() } = {}) {
  if (!process.env.CF_API_TOKEN || !process.env.CF_ACCOUNT_ID) {
    throw new Error('CF_API_TOKEN / CF_ACCOUNT_ID missing');
  }
  const snapshot = await collectSnapshot();
  if (snapshot.total === 0) throw new Error('no events in the window: refusing a green run without data');
  const jobCanonReceipt = evaluateJobCanonV1Retirement(snapshot);
  console.log(`[cf-observability-audit] receipt job-canon-v1-retirement ${JSON.stringify(jobCanonReceipt)}`);
  const checks = evaluateChecks(snapshot);
  for (const check of checks) {
    console.log(`[cf-observability-audit] ${check.failed ? 'FAIL' : 'ok  '} ${check.id}: ${check.value}`);
    if (dryRun) continue;
    if (check.failed) {
      await createGithubIssue({
        title: issueTitle(check),
        description: buildIssueBody(check),
        priority: check.id === '5xx-burst' ? 2 : 3,
        labels: ['monitoring', 'cloudflare-observability'],
        workflow: 'Cloudflare Observability Audit',
        exactTitle: true,
      });
    } else {
      resolveGithubIssue(issueTitle(check), { exactTitle: true, workflow: 'Cloudflare Observability Audit' });
    }
  }
  return checks;
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
