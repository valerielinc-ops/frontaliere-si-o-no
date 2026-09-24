/**
 * Delivery verdict for crawler generations: "green run" is not "published".
 *
 * A crawler group run is green when every member crawler exited 0, but the
 * data only reaches the site when the group commit lands on `main` and the
 * finalizer verifies a fresh receipt bound to the generation token against
 * that tip. The commit path deliberately exits 0 on push contention (42) and
 * a busy global lease (44), so a green run can publish nothing
 * (valerielinc-ops/frontaliere-si-o-no#9689, corpus #1579/#1566). The ledger
 * already records the terminal manifest verdict per group; this module turns
 * it into one deterministic state per group and a fleet-level verdict that a
 * gate can fail on.
 *
 * States:
 * - `published`: terminal manifest valid (token-bound receipt, commit on
 *   main, slice blobs persisted).
 * - `green_undelivered`: every crawler succeeded (no `wait_failed`) but the
 *   manifest is invalid — the silent loss this module exists to expose.
 * - `crawler_failed`: the crawl itself did not complete (`wait_failed`); the
 *   group run is already red, the missing delivery is a consequence.
 * - `token_missing`: the run carried no generation token.
 * - `not_persisted`: no ledger record for the group in this generation (the
 *   group never finalized, or its ledger commit was lost).
 */

export const CRAWLER_DELIVERY_STATES = Object.freeze([
  'published',
  'green_undelivered',
  'crawler_failed',
  'token_missing',
  'not_persisted',
]);

export const DEFAULT_DELIVERY_SETTLE_MS = 2 * 60 * 60 * 1_000;

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Classify one terminal manifest or ledger entry (both carry the same fields). */
export function classifyCrawlerDelivery(record) {
  if (!record || typeof record !== 'object') return 'not_persisted';
  const reasons = Array.isArray(record.reasons) ? record.reasons : [];
  if (record.generationToken === null || record.generationToken === undefined
      || reasons.includes('generation_token_missing')) return 'token_missing';
  if (record.valid === true && reasons.length === 0) return 'published';
  if (reasons.includes('wait_failed')) return 'crawler_failed';
  return 'green_undelivered';
}

function entryTime(entry) {
  const time = Date.parse(entry?.checkedAt ?? '');
  return Number.isNaN(time) ? -Infinity : time;
}

/**
 * Pick the newest generation that is complete enough to judge: at least
 * `minGroups` distinct groups recorded and no ledger write for `settleMs`
 * (a wave still finalizing would otherwise read as `not_persisted`).
 */
export function selectSettledGenerationToken(entries, { now, settleMs = DEFAULT_DELIVERY_SETTLE_MS, minGroups }) {
  const byToken = new Map();
  for (const entry of entries) {
    if (typeof entry?.generationToken !== 'string') continue;
    const bucket = byToken.get(entry.generationToken) ?? { groups: new Set(), firstAt: Infinity, lastAt: -Infinity };
    bucket.groups.add(entry.group);
    bucket.firstAt = Math.min(bucket.firstAt, entryTime(entry));
    bucket.lastAt = Math.max(bucket.lastAt, entryTime(entry));
    byToken.set(entry.generationToken, bucket);
  }
  const candidates = [...byToken.entries()]
    .map(([token, bucket]) => ({ token, groups: bucket.groups.size, firstAt: bucket.firstAt, lastAt: bucket.lastAt }))
    .sort((left, right) => right.lastAt - left.lastAt || compareCodePoint(right.token, left.token));
  const skipped = [];
  for (const candidate of candidates) {
    if (candidate.groups < minGroups) {
      skipped.push({ token: candidate.token, groups: candidate.groups, reason: 'partial' });
    } else if (now - candidate.lastAt < settleMs) {
      skipped.push({ token: candidate.token, groups: candidate.groups, reason: 'unsettled' });
    } else {
      return { token: candidate.token, firstAt: candidate.firstAt, skipped };
    }
  }
  return { token: null, firstAt: null, skipped };
}

/**
 * Fleet verdict for one generation token; `delivered` is true only at N/N published.
 *
 * A tokenless record carries no generation to group by, so it would otherwise
 * be invisible and let an older, fully published generation pass. Every
 * tokenless record written at or after `tokenlessSince` (the first write of
 * the judged generation) counts against its group as `token_missing` unless
 * a newer token-bound record supersedes it.
 */
export function evaluateCrawlerGenerationDelivery({ entries, generationToken, expectedGroupIds, tokenlessSince = null }) {
  const expected = [...expectedGroupIds].sort(compareCodePoint);
  const latestByGroup = new Map();
  const keepNewest = (map, entry) => {
    const previous = map.get(entry.group);
    // Reruns append a new record; the newest verdict wins, file order breaks ties.
    if (!previous || entryTime(entry) >= entryTime(previous.entry)) map.set(entry.group, { entry });
  };
  const tokenlessByGroup = new Map();
  for (const entry of entries) {
    if (generationToken !== null && entry?.generationToken === generationToken) keepNewest(latestByGroup, entry);
    else if (entry?.generationToken === null && tokenlessSince !== null && entryTime(entry) >= tokenlessSince) {
      keepNewest(tokenlessByGroup, entry);
    }
  }
  for (const [group, tokenless] of tokenlessByGroup) {
    const bound = latestByGroup.get(group);
    if (!bound || entryTime(tokenless.entry) >= entryTime(bound.entry)) latestByGroup.set(group, tokenless);
  }
  const counts = Object.fromEntries(CRAWLER_DELIVERY_STATES.map((state) => [state, 0]));
  const groups = {};
  for (const group of expected) {
    const entry = latestByGroup.get(group)?.entry ?? null;
    const state = entry === null ? 'not_persisted' : classifyCrawlerDelivery(entry);
    counts[state] += 1;
    groups[group] = {
      state,
      reasons: entry ? [...entry.reasons] : [],
      callerRepository: entry?.callerRepository ?? null,
      callerRunId: entry?.callerRunId ?? null,
      checkedAt: entry?.checkedAt ?? null,
    };
  }
  const unexpectedGroups = [...latestByGroup.keys()].filter((group) => !expected.includes(group)).sort(compareCodePoint);
  return {
    generationToken,
    expectedGroups: expected.length,
    counts,
    unexpectedGroups,
    delivered: expected.length > 0 && counts.published === expected.length && unexpectedGroups.length === 0,
    groups,
  };
}

export function formatCrawlerDeliveryMarker(report) {
  const { counts } = report;
  return `CRAWLER_GENERATION_DELIVERY: token=${report.generationToken ?? 'none'} `
    + `published=${counts.published}/${report.expectedGroups} `
    + `green_undelivered=${counts.green_undelivered} crawler_failed=${counts.crawler_failed} `
    + `token_missing=${counts.token_missing} not_persisted=${counts.not_persisted} `
    + `verdict=${report.delivered ? 'delivered' : 'undelivered'}`;
}

export function formatCrawlerDeliveryMarkdown(report) {
  const lines = [
    `### Crawler generation delivery — token \`${report.generationToken ?? 'none'}\``,
    '',
    `**${report.counts.published}/${report.expectedGroups}** groups published. `
      + `Green but undelivered: **${report.counts.green_undelivered}**, crawler failed: ${report.counts.crawler_failed}, `
      + `token missing: ${report.counts.token_missing}, not persisted: ${report.counts.not_persisted}.`,
    '',
    '| Group | State | Reasons | Caller run |',
    '| --- | --- | --- | --- |',
  ];
  // Two-digit group ids are not integer-like keys, so object order is not numeric order.
  for (const group of Object.keys(report.groups).sort(compareCodePoint)) {
    const detail = report.groups[group];
    if (detail.state === 'published') continue;
    const cell = (value) => String(value).replace(/[|\r\n]/g, ' ');
    lines.push(`| ${group} | ${detail.state} | ${cell(detail.reasons.join(', ') || '—')} | ${cell(detail.callerRunId ?? '—')} |`);
  }
  if (report.unexpectedGroups.length > 0) lines.push('', `Unexpected groups in ledger: ${report.unexpectedGroups.join(', ')}`);
  return `${lines.join('\n')}\n`;
}
