/**
 * Traffic-weighted ordering + queue-age metrics for the retranslation queue.
 *
 * PURE MODULE — no filesystem access at module scope and none in any exported
 * function. Every input arrives as an argument. That is deliberate: the
 * observer (tests/relocalize-traffic-priority.test.ts) has to import this from
 * a SPARSE worktree, where `data/` does not exist. A module that read
 * `data/job-popularity.json` at import time would be red locally and green in
 * CI, which is the failure shape this repo already pays for elsewhere.
 *
 * ── Why traffic, and which traffic ────────────────────────────────────────
 *
 * The retranslation queue is a moving window: the corpus grew 22.690 → 26.924
 * jobs (+18,5%) while the queue fell 14.041 → 10.192 (2026-08-11 → 2026-08-14).
 * A cap that drains 100/run out of 10.192 will never empty it, so WHICH 100 it
 * drains is the whole decision — and a job in the queue serves its description
 * in the source language on a page of another locale, so the cost of leaving it
 * there is paid per pageview.
 *
 * The traffic source is `data/job-popularity.json`: a { slug: views } map
 * exported daily from the Firestore `job_views` collection by
 * scripts/fetch-job-popularity.mjs (workflow refresh-job-popularity.yml, cron
 * 05:00 UTC). It is REAL per-job traffic — the site's own pageview counter,
 * keyed by the same slugs the jobs carry — not a proxy and not a guess.
 * It is NOT GA4: GA4 (property 524485296) reports by pagePath and would need a
 * live API call plus a path→slug reconstruction inside the translation run,
 * while this file is already committed in the repo and refreshed daily.
 *
 * Measured on the live queue (2026-08-14, 10.192 flagged jobs):
 *   - 6.820 of them (66,9%) carry a non-zero view count;
 *   - the top 100 by traffic hold 2.985 of the queue's 15.946 views (18,7%);
 *   - the top 100 by the PREVIOUS ordering hold 171 views (1,1%).
 * i.e. ×17,5 more served traffic repaired per unit of cap.
 *
 * ── Why the previous ordering was worse than it looked ────────────────────
 *
 * It sorted by `datePosted` descending. `datePosted` is present on 223 of the
 * 10.192 flagged jobs — 2,2%. The other 97,8% all evaluated to 0 and the sort
 * degenerated to slice-iteration order, so "most recent first" was not a weak
 * priority, it was almost no priority at all. The date signal that DOES have
 * full coverage is `firstSeenAt` (10.192/10.192), which is what
 * `jobQueuedAtMs()` reads.
 *
 * ── Why an oldest-first reserve ───────────────────────────────────────────
 *
 * Ranking by traffic alone starves the tail: old jobs accumulate less traffic
 * precisely because they are old, so a pure traffic order can leave the oldest
 * jobs in the queue forever while the headline count still falls. A fixed
 * share of every batch (RESERVE_FOR_OLDEST) is therefore drawn oldest-first
 * regardless of traffic. Without it the queue-age alert below would be a
 * detector for a starvation this file itself created.
 */

/** Path of the traffic source, as a string. Never opened here — see the header. */
export const TRAFFIC_SOURCE_PATH = 'data/job-popularity.json';

/**
 * Share of each capped batch drawn oldest-first instead of highest-traffic
 * first. 0.2 → every 5th slot. Set to 0 to disable the reserve entirely (the
 * pure-traffic order), which the observer forbids for the shipped default.
 */
export const RESERVE_FOR_OLDEST = 0.2;

/**
 * Age in days at which the oldest job still in the queue is reported as an
 * ALERT rather than as a number. Sits above the live maximum measured on
 * 2026-08-14 (123,2 days) so the flag means "the tail got OLDER than it has
 * ever been", not "the tail exists". A ratchet, not a threshold to tune down.
 */
export const QUEUE_AGE_ALERT_DAYS = 150;

const MS_PER_DAY = 86_400_000;

/**
 * Traffic for one job, in pageviews.
 *
 * A job is reachable under its source slug AND under one localized slug per
 * locale, and `job_views` counts each of those separately. We take the MAX
 * rather than the sum: the sum would double-count a job whose localized slugs
 * are byte-identical to the source slug (common — slug localization only
 * changes the slug when the title actually translated), which would then
 * outrank a genuinely more popular job. Max is monotone in real popularity and
 * immune to that.
 *
 * @param {object} job
 * @param {Record<string, number>} popularity  { slug: views }
 * @returns {number} views, 0 when the job has no entry
 */
export function jobTrafficScore(job, popularity) {
  if (!job || !popularity) return 0;
  let best = 0;
  const consider = (slug) => {
    if (!slug) return;
    const v = popularity[slug];
    if (typeof v === 'number' && Number.isFinite(v) && v > best) best = v;
  };
  consider(job.slug);
  const byLocale = job.slugByLocale;
  if (byLocale && typeof byLocale === 'object') {
    for (const slug of Object.values(byLocale)) consider(slug);
  }
  return best;
}

/**
 * When this job entered the corpus, in epoch ms, or NaN when unknown.
 *
 * `firstSeenAt` first because it is the only timestamp with full coverage on
 * the live queue (10.192/10.192 on 2026-08-14). `postedDate` and `crawledAt`
 * are fallbacks for jobs a future crawler writes without it. `datePosted` is
 * deliberately LAST: it is the field the previous ordering used and it covers
 * 2,2% of the queue.
 *
 * @param {object} job
 * @returns {number} epoch ms, or NaN
 */
export function jobQueuedAtMs(job) {
  if (!job) return NaN;
  for (const field of ['firstSeenAt', 'postedDate', 'crawledAt', 'datePosted']) {
    const raw = job[field];
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

/**
 * Queue-age metrics for the jobs currently flagged for retranslation.
 *
 * Answers the question the plain count cannot: a drain that works and a drain
 * that spins produce the SAME falling count while the corpus grows underneath
 * them, but only the one that works stops the oldest job from getting older.
 *
 * `oldestAgeDays` is measured from `jobQueuedAtMs()`, i.e. from when the job
 * entered the corpus, NOT from when it was flagged — no field records the
 * latter today. It is therefore an UPPER bound on time-in-queue, and it is
 * reported under a name that says so. It is still the right signal for the
 * starvation question, because a job that keeps being re-flagged never resets
 * it either way.
 *
 * @param {object[]} jobs  jobs currently flagged (the caller filters)
 * @param {{ now?: number, alertDays?: number }} [opts]
 * @returns {{count:number, withTimestamp:number, oldestAgeDays:number|null,
 *            p50AgeDays:number|null, p90AgeDays:number|null,
 *            buckets:Record<string, number>, alert:boolean, alertDays:number}}
 */
export function summarizeQueueAge(jobs, { now = Date.now(), alertDays = QUEUE_AGE_ALERT_DAYS } = {}) {
  const ages = [];
  for (const job of jobs || []) {
    const t = jobQueuedAtMs(job);
    if (!Number.isFinite(t)) continue;
    ages.push((now - t) / MS_PER_DAY);
  }
  ages.sort((a, b) => a - b);

  // `0-1d`, `1-2d` and `2-7d` are a SUBDIVISION of `0-7d`, which is kept and
  // still counts all three, so the 200 committed history rows stay comparable
  // against new ones on the key they already carry. The overlap is deliberate:
  // dropping `0-7d` would silently break every reader of the old series.
  //
  // The fine buckets exist because the map's 24-hour target is invisible at
  // 7-day resolution — on 2026-09-04 `0-7d` held 4.360 jobs, of which 1.308
  // were younger than a day. Without `0-1d` a change that fixes the freshest
  // cohort and a change that does nothing trace the same number.
  const buckets = {
    '0-1d': 0, '1-2d': 0, '2-7d': 0,
    '0-7d': 0, '7-30d': 0, '30-90d': 0, '90-180d': 0, '180d+': 0,
  };
  for (const a of ages) {
    if (a < 7) {
      buckets['0-7d']++;
      if (a < 1) buckets['0-1d']++;
      else if (a < 2) buckets['1-2d']++;
      else buckets['2-7d']++;
    } else if (a < 30) buckets['7-30d']++;
    else if (a < 90) buckets['30-90d']++;
    else if (a < 180) buckets['90-180d']++;
    else buckets['180d+']++;
  }

  const at = (q) => (ages.length === 0 ? null
    : round1(ages[Math.min(ages.length - 1, Math.floor(q * ages.length))]));
  const oldest = ages.length === 0 ? null : round1(ages[ages.length - 1]);

  return {
    count: (jobs || []).length,
    withTimestamp: ages.length,
    oldestAgeDays: oldest,
    p50AgeDays: at(0.5),
    p90AgeDays: at(0.9),
    buckets,
    // The starvation detector. True means the tail of the queue is now older
    // than it has ever been measured — i.e. the drain is working on the head
    // and the head only.
    alert: oldest !== null && oldest >= alertDays,
    alertDays,
  };
}

function round1(n) { return Math.round(n * 10) / 10; }

/**
 * Order the pending queue so the capped batch repairs the most served traffic,
 * without letting the oldest jobs starve.
 *
 * Returns a FULL ordering of every input job (not a slice), so the caller keeps
 * owning the cap. Slot i of the output is drawn oldest-first when
 * `(i + 1) % round(1 / reserve) === 0`, and highest-traffic-first otherwise;
 * whichever list runs out first, the other one supplies the remainder. With
 * reserve = 0.2 that is 4 traffic picks then 1 age pick, repeating.
 *
 * @param {object[]} pending
 * @param {Record<string, number>} popularity
 * @param {{ reserveForOldest?: number, now?: number }} [opts]
 * @returns {{ order: object[], stats: object }}
 */
export function buildTrafficPriority(pending, popularity, { reserveForOldest = RESERVE_FOR_OLDEST, now = Date.now() } = {}) {
  const jobs = Array.isArray(pending) ? pending : [];
  const pop = popularity && typeof popularity === 'object' ? popularity : {};

  const scored = jobs.map((job, index) => ({
    job,
    index,
    views: jobTrafficScore(job, pop),
    // Unknown timestamp sorts as "newest" so a job with no date can never
    // occupy an oldest-first reserve slot it did not earn.
    queuedAt: Number.isFinite(jobQueuedAtMs(job)) ? jobQueuedAtMs(job) : Infinity,
  }));

  const matched = scored.filter((s) => s.views > 0).length;
  const trafficEntries = Object.keys(pop).length;

  // Highest traffic first; ties broken OLDEST first (not by array order) so the
  // 33% of the queue with zero recorded traffic still drains front-to-back
  // instead of in whatever order the slices happened to be read.
  const byTraffic = [...scored].sort((a, b) =>
    b.views - a.views || a.queuedAt - b.queuedAt || a.index - b.index);
  const byAge = [...scored].sort((a, b) =>
    a.queuedAt - b.queuedAt || b.views - a.views || a.index - b.index);

  const order = [];
  const taken = new Set();
  const stride = reserveForOldest > 0 ? Math.max(2, Math.round(1 / reserveForOldest)) : 0;
  let ti = 0;
  let ai = 0;
  const nextFrom = (list, cursor) => {
    let i = cursor;
    while (i < list.length && taken.has(list[i].index)) i++;
    return i;
  };
  for (let slot = 0; slot < scored.length; slot++) {
    const wantsAge = stride > 0 && (slot + 1) % stride === 0;
    let pickedFromAge = false;
    let entry = null;
    if (wantsAge) {
      ai = nextFrom(byAge, ai);
      if (ai < byAge.length) { entry = byAge[ai]; pickedFromAge = true; }
    }
    if (!entry) {
      ti = nextFrom(byTraffic, ti);
      if (ti < byTraffic.length) entry = byTraffic[ti];
    }
    if (!entry) {
      // Traffic list exhausted on a non-reserve slot — fall back to the age list.
      ai = nextFrom(byAge, ai);
      if (ai >= byAge.length) break;
      entry = byAge[ai];
      pickedFromAge = true;
    }
    taken.add(entry.index);
    order.push(entry.job);
    if (pickedFromAge) ai++; else ti++;
  }

  const totalViews = scored.reduce((s, x) => s + x.views, 0);
  return {
    order,
    stats: {
      queued: scored.length,
      trafficEntries,
      matched,
      matchRate: scored.length === 0 ? 0 : matched / scored.length,
      totalViews,
      reserveForOldest,
      age: summarizeQueueAge(jobs, { now }),
    },
  };
}

/**
 * Refuse to run on an unusable traffic source instead of quietly falling back
 * to the previous ordering.
 *
 * A guard that degrades in SILENCE when its source is empty is the exact defect
 * that hid a dead PostHog for three weeks in this workspace: everything stayed
 * green, the ordering just stopped being an ordering. So an empty
 * `job-popularity.json` (or one with zero overlap against the queue) throws,
 * the Phase 2b step fails, and translate-pending.yml's report-failure action
 * opens an issue. Nothing is lost by failing here: the Phase 2c local-MT mop-up
 * and every commit step are `always()`-guarded, so the run still drains and
 * still commits.
 *
 * Escape hatch for a deliberate run without traffic data:
 * RELOCALIZE_ALLOW_NO_TRAFFIC=1.
 *
 * @param {object} stats  the `stats` half of buildTrafficPriority()
 * @param {{ allowEmpty?: boolean }} [opts]
 * @throws {Error} when the traffic source cannot order anything
 */
export function assertTrafficPriorityUsable(stats, { allowEmpty = false } = {}) {
  if (allowEmpty) return;
  if (!stats || stats.queued === 0) return; // nothing to order — not a source failure
  if (stats.trafficEntries === 0) {
    throw new Error(
      `traffic priority unusable: ${TRAFFIC_SOURCE_PATH} loaded 0 entries. ` +
      'Ordering the retranslation queue by traffic is not possible and silently ' +
      'falling back to the previous order would hide the outage. Check ' +
      'refresh-job-popularity.yml (Firestore job_views export), or set ' +
      'RELOCALIZE_ALLOW_NO_TRAFFIC=1 to run without traffic priority on purpose.',
    );
  }
  if (stats.matched === 0) {
    throw new Error(
      `traffic priority unusable: ${TRAFFIC_SOURCE_PATH} has ${stats.trafficEntries} ` +
      `entries but NONE of the ${stats.queued} queued jobs matches one. This is a ` +
      'key-shape mismatch (slug scheme drift), not an empty source — ordering by ' +
      'traffic would be ordering by nothing. Set RELOCALIZE_ALLOW_NO_TRAFFIC=1 to ' +
      'run without traffic priority on purpose.',
    );
  }
}

/**
 * One-line-per-fact console block for the run log. Pure — returns lines.
 * @param {object} stats
 * @returns {string[]}
 */
export function formatPriorityReport(stats) {
  const a = stats.age;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    '',
    '🎯 Retranslation queue priority',
    `   Traffic source:       ${TRAFFIC_SOURCE_PATH} (${stats.trafficEntries} entries, Firestore job_views)`,
    `   Queued:               ${stats.queued}`,
    `   With traffic > 0:     ${stats.matched} (${pct(stats.matchRate)})`,
    `   Views held by queue:  ${stats.totalViews}`,
    `   Oldest-first reserve: ${pct(stats.reserveForOldest)} of each batch`,
    `   Queue age (from first-seen, upper bound on time-in-queue):`,
    `     oldest ${a.oldestAgeDays ?? 'n/a'}d · p50 ${a.p50AgeDays ?? 'n/a'}d · p90 ${a.p90AgeDays ?? 'n/a'}d` +
      ` · dated ${a.withTimestamp}/${a.count}`,
    `     buckets ${Object.entries(a.buckets).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  ];
  if (a.alert) {
    lines.push(`   ⚠️ QUEUE AGE ALERT — oldest job in queue is ${a.oldestAgeDays}d, at or past the ${a.alertDays}d ratchet.`);
    lines.push('      The drain is clearing the head and leaving the tail. Raise RESERVE_FOR_OLDEST or the cap.');
  }
  return lines;
}
