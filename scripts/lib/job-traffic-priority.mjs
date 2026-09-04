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

/**
 * The freshness window: a job first seen less recently than this is no longer
 * "new" and stops jumping the queue.
 *
 * 24 hours because that is the second condition of the translation map's
 * destination — «a new job gets all four languages within 24 hours of first
 * sighting» — not because 24 was tuned against anything. It is a definition
 * this code serves, so it is a constant here and NOT a knob: the one number
 * meant to be tuned in this module stays `RESERVE_FOR_OLDEST`, which is what a
 * feedback loop would have to move on its own.
 */
export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many slots of the batch go to the oldest-first stride: one age pick every
 * `strideForReserve(reserve)` slots. Extracted because the ordering loop and
 * `freshHeadCeiling()` below MUST agree on it — two copies of `round(1 /
 * reserve)` is a drift waiting to happen, and the ceiling's whole promise is
 * stated in units of this number.
 */
export function strideForReserve(reserveForOldest) {
  return reserveForOldest > 0 ? Math.max(2, Math.round(1 / reserveForOldest)) : 0;
}

/**
 * Largest freshness head that still leaves the oldest-first reserve some slots
 * inside `capSlots` — the slice the caller will actually take.
 *
 * WHY A CEILING AT ALL. The head has no quota by design (see the partition in
 * buildTrafficPriority()), and the argument for that is an INTAKE ratio
 * (~1.421 jobs/day against the cap), not an invariant of this code. Anything
 * that resets `firstSeenAt` in bulk — a full re-crawl, a dataset regeneration,
 * a backfill — makes the whole queue "fresh" at once, the head then covers
 * every slot of the cap, the stride never runs, and the reserve gets ZERO
 * slots for that pass: the exact starvation RESERVE_FOR_OLDEST exists to
 * prevent.
 *
 * WHY THIS SIZE, and not a flat share. A flat half was the first shape of this
 * ceiling and it was WRONG in a way worth recording: the mop-up's cap is 2.000
 * (LOCAL_MT_MAX_JOBS) while the measured fresh cohort on 2026-09-04 was 1.308,
 * so a 1.000-slot ceiling would have deferred ~308 jobs on every ORDINARY run —
 * a standing loss on the 24-hour destination, paid to prevent a starvation that
 * in that regime did not exist (head 1.308 of 2.000 leaves 692 stride slots and
 * ~138 age picks). A ceiling must bite ONLY in the degenerate case it is named
 * after, so it is derived from the thing it protects instead of being a second
 * tunable: leave the stride `max(stride, ceil(capSlots * reserve))` slots —
 * enough for the reserve's designed share of the batch, and never fewer than
 * one full stride period, or the reserve's share would round down to no age
 * pick at all on a small batch. At cap 2.000 / reserve 0,2 that is 400 slots
 * reserved and a ceiling of 1.600, comfortably above the 1.308 measured: in the
 * normal regime this function returns a number the cohort never reaches, and
 * `freshDeferred` stays 0.
 *
 * Jobs cut by the ceiling are NOT dropped — they fall back into the stride like
 * any other job (and, being the newest, never take a reserve slot they did not
 * earn) — and their count is reported as `freshDeferred`, so a truncation that
 * changes the ordering can never be silent.
 *
 * Not a knob: it is derived. The one number meant to be tuned in this module
 * stays `RESERVE_FOR_OLDEST`.
 */
export function freshHeadCeiling(capSlots, reserveForOldest = RESERVE_FOR_OLDEST) {
  // No reserve configured means no reserve to starve: the pure-traffic order
  // has nothing this ceiling could protect, so the head stays unbounded.
  if (!(reserveForOldest > 0)) return capSlots;
  const forStride = Math.max(
    strideForReserve(reserveForOldest),
    Math.ceil(capSlots * reserveForOldest),
  );
  // A batch too small to split still gets a lane: one slot, never zero.
  return Math.max(1, capSlots - forStride);
}

/**
 * Every key the `stats` half of `buildTrafficPriority()` returns.
 *
 * Exported for the same reason as QUEUE_AGE_BUCKET_KEYS below, and after the
 * same failure: `validTrafficStats()` in translation-shadow-preflight-v2.mjs
 * checks these EXACTLY, so a field added here and not there invalidates every
 * shadow preflight observation — silently, and on every run. A consumer that
 * keeps its own copy of this list is a consumer that will drift.
 */
export const TRAFFIC_STATS_KEYS = Object.freeze([
  'age', 'freshDeferred', 'freshFirst', 'freshFuture', 'freshHead', 'freshWindowMs',
  'matchRate', 'matched', 'queued', 'reserveForOldest', 'totalViews', 'trafficEntries',
]);

/**
 * The age buckets that PARTITION the dated queue: every dated job lands in
 * exactly one, so their sum is `withTimestamp`. Any consumer checking that
 * invariant must sum THESE, never `Object.values(buckets)`.
 *
 * @see QUEUE_AGE_BUCKET_KEYS for why the full set does not partition anything.
 */
export const QUEUE_AGE_DISJOINT_BUCKET_KEYS = Object.freeze(
  ['0-7d', '7-30d', '30-90d', '90-180d', '180d+'],
);

/**
 * Every key `summarizeQueueAge()` emits, in output order — the disjoint
 * partition above PLUS a finer subdivision of its first bucket.
 *
 * `0-1d`, `1-2d` and `2-7d` SUBDIVIDE `0-7d`, which is kept and still counts
 * all three. The overlap is deliberate: `data/translation-stats-history.json`
 * has 200 committed rows that read on `0-7d`, and dropping it would silently
 * break every reader of the old series. The fine buckets exist because the
 * translation map's 24-hour target is invisible at 7-day resolution — on
 * 2026-09-04 `0-7d` held 4.360 jobs, of which 1.308 were younger than a day,
 * so without `0-1d` a change that fixes the freshest cohort and a change that
 * does nothing trace the same number.
 *
 * The consequence is the trap this constant exists to close: **the full set
 * does not sum to `withTimestamp`** — it sums to `withTimestamp + buckets
 * ['0-7d']`. Both lists live here, next to the loop that fills them, so a
 * future bucket cannot be added to the implementation and missed by a
 * consumer; that is exactly how `translation-shadow-preflight-v2.mjs` was
 * broken in two places at once, 1.130 lines apart.
 */
export const QUEUE_AGE_BUCKET_KEYS = Object.freeze(
  ['0-1d', '1-2d', '2-7d', ...QUEUE_AGE_DISJOINT_BUCKET_KEYS],
);

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

  const buckets = Object.fromEntries(QUEUE_AGE_BUCKET_KEYS.map((k) => [k, 0]));
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
 * `freshFirst` puts every job younger than FRESH_WINDOW_MS at the head, in one
 * block, before that stride begins — see the comment at the partition. It is
 * OFF by default and belongs only to the FREE local-MT mop-up: the AI cascade
 * caps out at 53 jobs per 90-minute run, and 1.308 fresh jobs would eat every
 * one of those slots for a cohort twenty-five times larger than the cascade
 * can serve, starving traffic and backlog on the paid path for nothing.
 *
 * The head is bounded by freshHeadCeiling() against `cap` — how many of these
 * slots the caller will actually take — so that a queue that turns fresh all at
 * once cannot leave the oldest-first reserve with zero slots. The ceiling is
 * derived from `reserveForOldest` and sized to bite ONLY in that case; `cap` is
 * a HINT about the caller's own slice, never applied to the returned ordering.
 *
 * @param {object[]} pending
 * @param {Record<string, number>} popularity
 * @param {{ reserveForOldest?: number, now?: number, freshFirst?: boolean, cap?: number }} [opts]
 * @returns {{ order: object[], stats: object }}
 */
export function buildTrafficPriority(pending, popularity, { reserveForOldest = RESERVE_FOR_OLDEST, now = Date.now(), freshFirst = false, cap = null } = {}) {
  // A cap that is NaN, zero or negative would silently fall back to "no cap"
  // and take the ceiling with it — the lane would look bounded and not be.
  // `null` (the default) is the honest way to say "I take everything".
  if (cap !== null && !(Number.isInteger(cap) && cap > 0)) {
    throw new TypeError(`buildTrafficPriority: cap must be a positive integer or null, got ${JSON.stringify(cap)}`);
  }
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

  // ── The freshness lane ────────────────────────────────────────────────
  //
  // Jobs first seen less than FRESH_WINDOW_MS ago go FIRST, all of them, with
  // no quota up to the ceiling that keeps the reserve alive (freshHeadCeiling)
  // — and then the rest of the queue keeps exactly the stride it had.
  //
  // Why no quota. Three lanes cannot be interleaved by a single stride: that
  // needs two ratios, and the tunable here must stay ONE observable number,
  // because it is the lever a feedback loop has to be able to move on its own.
  // The fresh cohort does not need a ratio because it is SELF-LIMITING —
  // ~1.421 jobs arrive per day against a 6.000-job cap per run, five runs a
  // day — so it drains itself instead of starving traffic and backlog. That
  // ratio is a MEASUREMENT though, not an invariant, and a bulk reset of
  // `firstSeenAt` violates it; the ceiling above turns the promise into one
  // the code keeps on its own, without adding a second tunable. The 24-hour
  // threshold is fixed by the destination it serves, not tuned.
  //
  // Why the ordering is not enough on its own: measured 2026-09-04, 1.308 of
  // the 1.421 jobs seen in the last 24 hours were still pending — 92,0%. The
  // lane did not exist, so nothing served them while they were fresh.
  const freshCutoff = freshFirst ? now - FRESH_WINDOW_MS : -Infinity;
  // La corsia e' un INTERVALLO, non una semiretta. Con il solo limite inferiore
  // un `queuedAt` nel FUTURO — skew dell'orologio di un crawler, o una data mal
  // parsata: `jobQueuedAtMs()` accetta qualunque `Date.parse` finito di
  // `firstSeenAt`/`postedDate`/`crawledAt`/`datePosted` — soddisfa il predicato
  // a OGNI run, per sempre, e resta in testa alla coda finche' il job e'
  // pending: non e' fresco, e' solo non databile. Il job non sparisce, perde
  // solo la testa: cade nel `rest` e viene servito dallo stride come gli altri.
  const isFuture = (s) => Number.isFinite(s.queuedAt) && s.queuedAt > now;
  const isFresh = (s) => s.queuedAt >= freshCutoff && Number.isFinite(s.queuedAt) && !isFuture(s);
  // Contato, non solo scartato: una data futura e' un difetto a monte (crawler o
  // parser) che senza questo numero resterebbe muto — il job continuerebbe a
  // essere servito dallo stride e nessuno saprebbe mai perche' non e' in testa.
  const freshFuture = freshFirst ? scored.filter(isFuture).length : 0;
  // Within the head, highest traffic first: the cohort is served whole either
  // way, so its internal order only decides who is repaired first inside it.
  const freshCohort = freshFirst
    ? scored.filter(isFresh).sort((a, b) =>
      b.views - a.views || a.queuedAt - b.queuedAt || a.index - b.index)
    : [];
  // ...unless the cohort would cover the whole slice the caller takes, in which
  // case the head IS the batch and the stride below never runs — see
  // freshHeadCeiling(), which bites only in that degenerate case. A caller that
  // declares no cap takes the whole queue in one pass, so `jobs.length` IS its
  // cap and nobody starves.
  const capSlots = cap === null ? jobs.length : Math.min(cap, jobs.length);
  const freshHeadMax = freshHeadCeiling(capSlots, reserveForOldest);
  const freshHead = freshCohort.slice(0, freshHeadMax);
  // Cut from the head, NOT from the queue: these go back into the stride with
  // everybody else, where — being the newest jobs in it — they sort last on the
  // age list and cannot take a reserve slot they did not earn.
  const deferred = new Set(freshCohort.slice(freshHeadMax).map((s) => s.index));
  const rest = freshFirst
    ? scored.filter((s) => !isFresh(s) || deferred.has(s.index))
    : scored;

  // Highest traffic first; ties broken OLDEST first (not by array order) so the
  // 33% of the queue with zero recorded traffic still drains front-to-back
  // instead of in whatever order the slices happened to be read.
  const byTraffic = [...rest].sort((a, b) =>
    b.views - a.views || a.queuedAt - b.queuedAt || a.index - b.index);
  const byAge = [...rest].sort((a, b) =>
    a.queuedAt - b.queuedAt || b.views - a.views || a.index - b.index);

  const order = freshHead.map((s) => s.job);
  const taken = new Set();
  const stride = strideForReserve(reserveForOldest);
  let ti = 0;
  let ai = 0;
  const nextFrom = (list, cursor) => {
    let i = cursor;
    while (i < list.length && taken.has(list[i].index)) i++;
    return i;
  };
  // `rest.length`, not `scored.length`: the fresh head is already in `order`,
  // and the stride must count slots of the REMAINDER — counting them over the
  // whole queue would shift every oldest-first reserve slot by the size of the
  // head, silently changing the ordering the head was supposed to leave alone.
  for (let slot = 0; slot < rest.length; slot++) {
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
      // Quanti slot ha preso la testa fresca. Stampato dal report perche' e'
      // l'unico modo di vedere che la corsia esiste: l'ordinamento non lascia
      // altra traccia, e una corsia che smette di funzionare sarebbe muta.
      freshFirst,
      freshHead: freshHead.length,
      // Quanti job freschi il tetto ha rimandato nello stride. Diverso da zero
      // solo su una coorte piu' grande di meta' batch — cioe' esattamente il
      // caso (reset di massa di `firstSeenAt`) in cui l'ordinamento cambia:
      // senza questo numero la troncatura sarebbe muta.
      freshDeferred: freshCohort.length - freshHead.length,
      // Quanti job la corsia ha escluso perche' datati nel FUTURO. Diverso da
      // zero = c'e' un crawler che scrive date non servibili, da guardare.
      freshFuture,
      freshWindowMs: freshFirst ? FRESH_WINDOW_MS : 0,
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
    // Stampata sempre, anche spenta e anche a zero: una corsia che smette di
    // pescare deve essere visibile nel log come «0 job», non sparire dalla
    // riga insieme al suo effetto.
    `   Freshness lane:       ${stats.freshFirst
      ? `${stats.freshHead} job(s) ahead of the stride (< ${Math.round(stats.freshWindowMs / 3_600_000)}h old)`
        + (stats.freshDeferred > 0
          ? ` · ${stats.freshDeferred} more deferred to the stride (head hit its ceiling, so the oldest-first reserve keeps its slots)`
          : '')
        + (stats.freshFuture > 0
          ? ` · ${stats.freshFuture} skipped, dated in the FUTURE (still queued, served by the stride — check the crawler that dated them)`
          : '')
      : 'off (this consumer keeps the plain traffic/age stride)'}`,
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
