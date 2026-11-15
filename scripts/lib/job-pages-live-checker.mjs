// Shared liveness contract for emails that contain links to job detail pages.
//
// The published-page manifest is authoritative when it is fresh and covers the
// sender inventory. If it cannot be trusted, callers fall back to the existing
// HTML check and its bounded fail-open rule for transient network failures.

import { runWithConcurrency, checkPageBodyLive } from './live-link-check.mjs';
import {
  loadJobPagesManifest,
  manifestCoverage,
  resolveLiveLinkManifestConfig,
} from './job-pages-manifest-client.mjs';

export const JOB_LIVE_CHECK_CONCURRENCY = 16;
export const JOB_LIVE_CHECK_FAIL_OPEN_MIN_SAMPLE = 4;
export const JOB_LIVE_CHECK_FAIL_OPEN_LIVE_RATIO = 0.34;

const NOOP_METRICS = Object.freeze({
  count() {},
  set() {},
});

export function normalizeLiveLinkResult(value) {
  if (typeof value === 'boolean') return { known: true, live: value };
  if (!value || typeof value !== 'object') return { known: false, live: false };
  return { known: value.known === true, live: value.live === true };
}

export function cachedLiveLinkResult(cache, url) {
  if (!url || !cache.has(url)) return null;
  const result = normalizeLiveLinkResult(cache.get(url));
  return result.known ? result : null;
}

export function isCachedDeadLiveLink(cache, url) {
  return cachedLiveLinkResult(cache, url)?.live === false;
}

/**
 * Resolve liveness for a bounded set of jobs, reusing results in `cache`.
 * `urlFor` is deliberately supplied by each sender so the URL checked is the
 * URL that sender actually embeds in its email.
 */
export async function inspectLiveJobs(
  jobs,
  locale,
  cache,
  {
    check = checkPageBodyLive,
    maxNewChecks = Number.POSITIVE_INFINITY,
    failOpen = true,
    urlFor = (job) => job?.url || null,
    onFailOpen = () => {},
    log = console.log,
    warn = console.warn,
  } = {},
) {
  const withUrls = jobs.map((job) => ({ job, url: urlFor(job, locale) }));
  const uniqueToCheck = [...new Set(
    withUrls
      .map(({ url }) => url)
      .filter((url) => url && !cachedLiveLinkResult(cache, url)),
  )];
  const checkBudget = Number.isFinite(maxNewChecks)
    ? Math.max(0, Math.trunc(maxNewChecks))
    : uniqueToCheck.length;
  const urlsToCheck = uniqueToCheck.slice(0, checkBudget);
  if (urlsToCheck.length > 0) {
    await runWithConcurrency(urlsToCheck, JOB_LIVE_CHECK_CONCURRENCY, async (url) => {
      const result = normalizeLiveLinkResult(await check(url));
      if (result.known) cache.set(url, result);
    });
  }

  const results = withUrls.map(({ job, url }) => {
    const cached = cachedLiveLinkResult(cache, url);
    const known = !url || cached !== null;
    return { job, url, known, live: known && (!url || cached.live) };
  });
  // A URL-less board fallback is intentionally sendable: it points to the
  // canton board rather than a detail page. It is not an HTTP/manifest check,
  // so it must not inflate either side of the fail-open ratio.
  const checkedResults = results.filter((result) => result.url && result.known);
  const knownLiveJobs = results.filter((result) => result.live).map((result) => result.job);
  const unknownJobs = results.filter((result) => !result.known).map((result) => result.job);
  const checked = checkedResults.length;
  const liveCount = checkedResults.filter((result) => result.live).length;

  // An HTTP outage must not turn an entire campaign into an empty email. A
  // manifest response is local and deterministic, so callers pass false there
  // and a low live ratio remains a real filtering decision.
  if (failOpen && checked >= JOB_LIVE_CHECK_FAIL_OPEN_MIN_SAMPLE
    && liveCount / checked < JOB_LIVE_CHECK_FAIL_OPEN_LIVE_RATIO) {
    onFailOpen({ checked, liveCount, unknownJobs });
    warn(`   ⚠️  Live-link check: only ${liveCount}/${checked} job page(s) resolved live — suspected transient network issue, failing open (sending unfiltered) rather than emptying the email`);
    return { jobs, knownLiveJobs, unknownJobs, failOpen: true };
  }

  const deadCount = checked - liveCount;
  if (deadCount > 0) {
    log(`   🔗 Live-link check: ${deadCount}/${checked} job(s) filtered out (dead link — pulled/expired or not yet deployed)`);
  }
  return { jobs: knownLiveJobs, knownLiveJobs, unknownJobs, failOpen: false };
}

/**
 * Select the answer source for «is this published job page live?». The
 * manifest path is local and fail-closed; the HTTP path retains the sender's
 * bounded fail-open protection for an outage on the checking side.
 */
export async function createPublishedJobPageChecker({
  config = resolveLiveLinkManifestConfig(),
  inventory = [],
  datasetAtMs,
  fetchImpl = globalThis.fetch,
  metrics = NOOP_METRICS,
  log = console.log,
  warn = console.warn,
  urlFor = (job) => job?.url || null,
  check = checkPageBodyLive,
} = {}) {
  const count = (name) => metrics?.count?.(name);
  const set = (name, value) => metrics?.set?.(name, value);
  const httpCheck = async (url) => {
    count('liveLinkHttpRequests');
    return check(url);
  };
  const http = (reason) => {
    set('liveLinkSource', `http:${reason}`);
    return { source: 'http', reason, check: httpCheck, failOpen: true };
  };
  if (config.mode === 'off') return http('disabled');

  const loaded = await loadJobPagesManifest({
    url: config.url,
    fetchImpl,
    datasetAtMs,
    maxAgeHours: config.maxAgeHours,
    onRequest: () => count('liveLinkHttpRequests'),
  });
  if (!loaded.usable) {
    warn(`   ⚠️  Job-pages manifest unusable (${loaded.reason}${loaded.detail ? ` ${loaded.detail}` : ''}) — falling back to the per-page HTTP live-link check`);
    return http(loaded.reason);
  }

  const coverage = manifestCoverage(loaded.lookup, inventory, (job) => urlFor(job, 'it'));
  if (coverage.ratio < config.minCoverage) {
    warn(`   ⚠️  Job-pages manifest covers only ${(coverage.ratio * 100).toFixed(1)}% of ${coverage.checked} sampled open listings (< ${(config.minCoverage * 100).toFixed(0)}%) — falling back to the per-page HTTP live-link check`);
    return http('low-coverage');
  }

  log(`   📇 Live-link via job-pages manifest: ${loaded.lookup.pageCount} active pages in ${loaded.lookup.sectionCount} sections, ${loaded.ageHours.toFixed(1)} h old, covers ${(coverage.ratio * 100).toFixed(1)}% of ${coverage.checked} sampled open listings`);
  set('liveLinkSource', 'manifest');
  set('liveLinkManifestPages', loaded.lookup.pageCount);
  return {
    source: 'manifest',
    reason: 'ok',
    check: async (url) => {
      count('liveLinkManifestResolved');
      return { known: true, live: loaded.lookup.has(url) };
    },
    failOpen: false,
    checkBudget: Number.POSITIVE_INFINITY,
  };
}
