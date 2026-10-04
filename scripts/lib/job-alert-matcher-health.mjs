/**
 * Matcher health of the daily JobAlert sender, measured on the ACTIVE
 * inventory (owner decision 2026-10-04, issue 9060).
 *
 * The old monitor alarmed on the share of real alerts that matched zero jobs in
 * their recipient window — the jobs that became available since that
 * recipient's last send. That share is the YIELD of a run: it rises in quiet
 * periods, on a second run of the same day (the cursor is a few hours old) and
 * whenever a subscriber asks for something the inventory does not have. None
 * of those is a matcher defect, and silencing them would have needed a higher
 * threshold — while a matcher broken on one path (one canton, the taxonomy
 * comparison) stayed below any rate threshold.
 *
 * What is measured instead: synthetic alerts built FROM the active inventory,
 * one per (canton, profession) group present in it, each carrying the hard
 * filters a subscriber would set — a profession keyword taken from a listing's
 * own title (or its category label, persisted in `keywords` exactly like a
 * board/sector alert) and that listing's canton as `cantonFilter`. The listing
 * the probe was cut from is in the inventory, so a sound matcher returns at
 * least one job for every probe. A probe that returns zero is a matcher
 * regression, not a quiet day: the monitor reports on the first one.
 *
 * The real alerts' zero-match yield stays in the run log and in the report as
 * an informative figure; it no longer opens or closes anything.
 *
 * Declared coverage limit: the probes exercise the hard keyword path (title
 * text and category taxonomy) and the `cantonFilter` geo path. They do not set
 * `locations` (the locationIndex/city geo filter) nor `sectors`, so a
 * regression confined to those two paths is not seen by this monitor.
 *
 * Pure module: the caller injects the matcher (`planMatch`), so production runs
 * the real planAlertMatch and tests can break it on purpose.
 */

/** Upper bound on probes per run, declared in the log and in the report. */
export const MATCHER_HEALTH_MAX_PROBES = 200;

/** Reserved, non-deliverable recipient of the synthetic alerts. */
export const MATCHER_HEALTH_PROBE_EMAIL = 'matcher-health-probe@frontaliereticino.invalid';

/** The locale used by the synthetic alert passed to planAlertMatch. */
export const MATCHER_HEALTH_PROBE_LOCALE = 'it';

export const MATCHER_HEALTH_PROBE_KINDS = {
  TITLE_KEYWORD: 'title-keyword',
  CATEGORY: 'category',
};

const MIN_TITLE_TOKEN_LENGTH = 4;

/** Grouping key only — the matcher never sees this value. */
function professionGroupKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The canton exactly as the matcher derives it (`jobMatchFeatures.jobCanton`
 * and the cantonFilter normalisation in services/jobAlertMatching.mjs:
 * lowercased, NOT trimmed). A trimmed probe canton would fail on a healthy
 * matcher for a row stored as 'TI ', blaming the matcher for a data defect.
 */
function jobCanton(job) {
  return String(job?.canton || '').toLowerCase();
}

function jobCategoryLabel(job) {
  return String(job?.category || job?.sector || '').trim();
}

/**
 * The longest letter-only token of the job's own title. The matcher compares
 * a hard keyword with `title.toLowerCase()` (plus localized titles and the
 * description), so this token is a substring of the source listing's text by
 * construction.
 */
export function titleProfessionToken(title) {
  const lowered = String(title || '').toLowerCase();
  let best = '';
  for (const token of lowered.split(/[^\p{L}]+/u)) {
    if (token.length >= MIN_TITLE_TOKEN_LENGTH && token.length > best.length) best = token;
  }
  return best;
}

/**
 * A listing can seed a probe only when the send loop itself would score it
 * for an ordinary recipient: canary listings are reserved to the owner, and a
 * listing awaiting retranslation is skipped only for recipients of another
 * locale. Keep the fallback source locale aligned with planAlertMatch.
 */
function canSeedProbe(job, probeLocale = MATCHER_HEALTH_PROBE_LOCALE) {
  return Boolean(job)
    && job.canary !== true
    && (job.needsRetranslation !== true || probeLocale === (job.sourceLang || 'it'))
    && jobCanton(job).trim() !== ''
    && titleProfessionToken(job.title) !== '';
}

function stableJobKey(job) {
  return String(job?.id || job?.slug || job?.title || '');
}

function probeAlert({ id, keyword, canton }) {
  return {
    id,
    email: MATCHER_HEALTH_PROBE_EMAIL,
    locale: MATCHER_HEALTH_PROBE_LOCALE,
    active: true,
    keywords: [keyword],
    cantonFilter: [canton],
  };
}

/**
 * Build the synthetic alerts from the active inventory.
 *
 * Groups are (canton, profession) pairs, profession being the listing's
 * category/sector label. Every group contributes a title-keyword probe and,
 * when the representative listing carries a category label, a category probe.
 * The representative is the group's first eligible listing in a stable order,
 * so a rerun on the same inventory builds the same probes.
 *
 * When the groups need more than `maxProbes`, they are taken round-robin
 * across cantons (largest group of each canton first), so a small canton is
 * not starved by the large ones. The returned counts declare the sample.
 *
 * @param {object[]} activeJobs Open, currently available listings.
 * @param {{maxProbes?: number}} [options]
 * @returns {{probes: object[], groupCount: number, sampledGroupCount: number, cantonCount: number}}
 */
export function buildMatcherHealthProbes(activeJobs, { maxProbes = MATCHER_HEALTH_MAX_PROBES } = {}) {
  const groups = new Map();
  for (const job of activeJobs || []) {
    if (!canSeedProbe(job)) continue;
    const canton = jobCanton(job);
    const profession = professionGroupKey(jobCategoryLabel(job));
    const key = `${canton}\u0000${profession}`;
    let group = groups.get(key);
    if (!group) {
      group = { canton, profession, size: 0, representative: null };
      groups.set(key, group);
    }
    group.size++;
    if (!group.representative || stableJobKey(job) < stableJobKey(group.representative)) {
      group.representative = job;
    }
  }

  const byCanton = new Map();
  for (const group of groups.values()) {
    if (!byCanton.has(group.canton)) byCanton.set(group.canton, []);
    byCanton.get(group.canton).push(group);
  }
  const cantonQueues = [...byCanton.keys()].sort().map((canton) => byCanton.get(canton)
    .sort((a, b) => (b.size - a.size) || a.profession.localeCompare(b.profession)));

  const limit = Number.isFinite(maxProbes) && maxProbes > 0 ? Math.floor(maxProbes) : 0;
  const probes = [];
  let sampledGroupCount = 0;
  const probeFor = (group, kind, keyword) => ({
    canton: group.canton,
    profession: group.profession,
    sourceJobId: stableJobKey(group.representative),
    kind,
    keyword,
    alert: probeAlert({
      id: `matcher-health:${kind}:${group.canton}:${group.profession}`,
      keyword,
      canton: group.canton,
    }),
  });
  for (let round = 0; probes.length < limit; round++) {
    // One group per canton in this round: every canton gets its title-keyword
    // probe before any canton gets a category probe, so a tight cap still
    // covers every canton of the round.
    const roundGroups = cantonQueues.map((queue) => queue[round]).filter(Boolean);
    if (roundGroups.length === 0) break;
    const sampled = new Set();
    for (const group of roundGroups) {
      if (probes.length >= limit) break;
      sampled.add(group);
      probes.push(probeFor(
        group,
        MATCHER_HEALTH_PROBE_KINDS.TITLE_KEYWORD,
        titleProfessionToken(group.representative.title),
      ));
    }
    for (const group of roundGroups) {
      if (probes.length >= limit) break;
      if (!sampled.has(group)) continue;
      const category = jobCategoryLabel(group.representative);
      if (!category || !professionGroupKey(category)) continue;
      probes.push(probeFor(group, MATCHER_HEALTH_PROBE_KINDS.CATEGORY, category));
    }
    sampledGroupCount += sampled.size;
  }

  return {
    probes,
    groupCount: groups.size,
    sampledGroupCount,
    cantonCount: cantonQueues.length,
  };
}

/**
 * Run the injected matcher on every probe. `planMatch(alert)` must score the
 * alert against the whole active inventory (no recipient cursor) and return
 * planAlertMatch's shape (`rankedCount`, `candidateCount`, `zeroCause`).
 */
export function evaluateMatcherHealth(probes, planMatch) {
  const failures = [];
  const failureByKind = {};
  let probeCount = 0;
  for (const probe of probes || []) {
    probeCount++;
    const plan = planMatch(probe.alert) || {};
    const rankedCount = Number(plan.rankedCount) || 0;
    if (rankedCount > 0) continue;
    failures.push({
      kind: probe.kind,
      canton: probe.canton,
      profession: probe.profession,
      keyword: probe.keyword,
      sourceJobId: probe.sourceJobId,
      candidateCount: Number(plan.candidateCount) || 0,
      zeroCause: plan.zeroCause || null,
    });
    failureByKind[probe.kind] = (failureByKind[probe.kind] || 0) + 1;
  }
  return {
    probeCount,
    passedCount: probeCount - failures.length,
    failureCount: failures.length,
    failureByKind,
    failures,
  };
}

/**
 * Lifecycle of the canonical monitor issue. Every probe is expected to match,
 * so one failing probe reports; recovery needs a non-empty probe set. Dry-run
 * and targeted operator sends do not touch the issue.
 */
export function getMatcherHealthMonitorAction({
  probeCount = 0,
  failureCount = 0,
  dryRun = false,
  targeted = false,
} = {}) {
  if (
    dryRun
    || targeted
    || !Number.isFinite(probeCount)
    || !Number.isFinite(failureCount)
    || probeCount <= 0
    || failureCount < 0
  ) {
    return 'skip';
  }
  return failureCount > 0 ? 'report' : 'resolve';
}
