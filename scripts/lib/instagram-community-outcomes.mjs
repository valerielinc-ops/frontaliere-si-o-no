import { summarizeInstagramCommunityQuestionDemand } from './instagram-community-topics.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
export const COMMUNITY_OUTCOME_RETENTION_WEEKS = 26;

const SURFACES = Object.freeze(['comments', 'directMessages']);
const ESCALATION_REASONS = Object.freeze([
  'personal-or-sensitive',
  'source-required',
  'outside-window',
  'timestamp-unavailable',
  'delivery-failed',
  'delivery-uncertain',
  'reply-limit-reached',
  'empty-or-unreadable',
]);

function isoMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function utcWeekStart(atMs) {
  const date = new Date(atMs);
  const dayFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - dayFromMonday);
  return date.toISOString().slice(0, 10);
}

function emptySurface() {
  return {
    observed: 0,
    responded: 0,
    responsesWithin24h: 0,
    responsesAfter24h: 0,
    pendingWithin24h: 0,
    unansweredAfter24h: 0,
    timestampUnknown: 0,
    latencyBuckets: { under1h: 0, oneToFourHours: 0, fourTo24Hours: 0, over24Hours: 0 },
    escalations: Object.fromEntries(ESCALATION_REASONS.map((reason) => [reason, 0])),
  };
}

function summarizeInteraction(target, event, nowMs) {
  target.observed += 1;
  if (event.escalationReason && Object.hasOwn(target.escalations, event.escalationReason)) {
    target.escalations[event.escalationReason] += 1;
  }

  const receivedMs = isoMs(event.receivedAt);
  const responseMs = isoMs(event.responseAt);
  if (event.status === 'responded' && (receivedMs === null || responseMs === null || responseMs < receivedMs)) {
    target.responded += 1;
    target.timestampUnknown += 1;
    return;
  }
  if (receivedMs === null) {
    target.timestampUnknown += 1;
    return;
  }

  if (responseMs !== null && responseMs >= receivedMs) {
    const latencyHours = (responseMs - receivedMs) / 3_600_000;
    target.responded += 1;
    if (latencyHours <= 24) target.responsesWithin24h += 1;
    else target.responsesAfter24h += 1;
    if (latencyHours < 1) target.latencyBuckets.under1h += 1;
    else if (latencyHours < 4) target.latencyBuckets.oneToFourHours += 1;
    else if (latencyHours <= 24) target.latencyBuckets.fourTo24Hours += 1;
    else target.latencyBuckets.over24Hours += 1;
    return;
  }

  if (nowMs - receivedMs < 24 * 3_600_000) target.pendingWithin24h += 1;
  else target.unansweredAfter24h += 1;
}

/** Build a private, content-free weekly summary from the local hashed event journal. */
export function buildInstagramCommunityOutcomeSnapshot({
  interactions = [],
  questionTopicSignals = [],
  asOf = new Date(),
  source = 'graph',
  runStatus = 'completed',
  coverage = 'bounded-page-window',
  trackingStartedAt = null,
  truncated = false,
  retentionWeeks = COMMUNITY_OUTCOME_RETENTION_WEEKS,
} = {}) {
  const nowMs = asOf instanceof Date ? asOf.getTime() : Date.parse(String(asOf));
  if (!Number.isFinite(nowMs)) throw new TypeError('community outcome asOf must be a valid date');
  if (!['graph', 'browser'].includes(source)) throw new TypeError('community outcome source is invalid');

  const lowerMs = nowMs - retentionWeeks * WEEK_MS;
  const weeks = new Map();
  for (const event of Array.isArray(interactions) ? interactions : []) {
    if (!event || !SURFACES.includes(event.surface)) continue;
    const observedMs = isoMs(event.observedAt);
    if (observedMs === null || observedMs > nowMs) continue;
    const receivedMs = isoMs(event.receivedAt);
    const eventMs = receivedMs ?? observedMs;
    if (eventMs < lowerMs || eventMs > nowMs) continue;
    const weekStart = utcWeekStart(eventMs);
    const bucket = weeks.get(weekStart) || {
      weekStart,
      generatedAt: new Date(nowMs).toISOString(),
      sources: [],
      bySurface: { comments: emptySurface(), directMessages: emptySurface() },
    };
    if (event.source && !bucket.sources.includes(event.source)) bucket.sources.push(event.source);
    const responseMs = isoMs(event.responseAt);
    const effectiveEvent = responseMs !== null && responseMs > nowMs
      ? { ...event, status: 'pending', responseAt: null }
      : event;
    summarizeInteraction(bucket.bySurface[event.surface], effectiveEvent, nowMs);
    weeks.set(weekStart, bucket);
  }

  const currentWeek = utcWeekStart(nowMs);
  if (!weeks.has(currentWeek)) {
    weeks.set(currentWeek, {
      weekStart: currentWeek,
      generatedAt: new Date(nowMs).toISOString(),
      sources: [],
      bySurface: { comments: emptySurface(), directMessages: emptySurface() },
    });
  }
  const orderedWeeks = [...weeks.values()]
    .sort((left, right) => left.weekStart.localeCompare(right.weekStart))
    .slice(-retentionWeeks);
  const trackedFrom = orderedWeeks[0]?.weekStart || currentWeek;
  return {
    schemaVersion: 2,
    generatedAt: new Date(nowMs).toISOString(),
    latestRun: { source, status: String(runStatus).slice(0, 80), coverage },
    trackedFrom,
    trackingStartedAt: isoMs(trackingStartedAt) === null
      ? new Date(nowMs).toISOString()
      : new Date(isoMs(trackingStartedAt)).toISOString(),
    eventsTruncated: Boolean(truncated),
    coverageGap: false,
    questionTopicDemand: summarizeInstagramCommunityQuestionDemand(questionTopicSignals, { asOf: new Date(nowMs) }),
    weeks: orderedWeeks,
  };
}

/** Merge by UTC week; a later snapshot replaces an earlier aggregate for that week. */
export function mergeInstagramCommunityOutcomeSnapshots(existing, incoming, {
  retentionWeeks = COMMUNITY_OUTCOME_RETENTION_WEEKS,
} = {}) {
  if (!incoming || ![1, 2].includes(incoming.schemaVersion) || !Array.isArray(incoming.weeks)) return existing || null;
  const incomingHasTrackingGap = Boolean(existing?.trackingStartedAt && incoming.trackingStartedAt
    && incoming.trackingStartedAt > existing.trackingStartedAt);
  const observedCount = (week) => Object.values(week?.bySurface || {})
    .reduce((sum, surface) => sum + (Number(surface?.observed) || 0), 0);
  const byWeek = new Map();
  for (const week of [
    ...(Array.isArray(existing?.weeks) ? existing.weeks : []),
    ...incoming.weeks,
  ]) {
    if (!week || !/^\d{4}-\d{2}-\d{2}$/u.test(String(week.weekStart || ''))) continue;
    const current = byWeek.get(week.weekStart);
    const preserveOlderAggregate = current && incomingHasTrackingGap
      && incoming.weeks.includes(week)
      && observedCount(week) < observedCount(current);
    if (preserveOlderAggregate) continue;
    if (!current || (isoMs(week.generatedAt) || 0) >= (isoMs(current.generatedAt) || 0)) {
      byWeek.set(week.weekStart, week);
    }
  }
  const weeks = [...byWeek.values()]
    .sort((left, right) => left.weekStart.localeCompare(right.weekStart))
    .slice(-retentionWeeks);
  return {
    schemaVersion: incoming.schemaVersion === 2 || existing?.schemaVersion === 2 ? 2 : 1,
    generatedAt: incoming.generatedAt,
    latestRun: incoming.latestRun,
    trackedFrom: weeks[0]?.weekStart || incoming.trackedFrom,
    trackingStartedAt: existing?.trackingStartedAt && incoming.trackingStartedAt
      ? (existing.trackingStartedAt < incoming.trackingStartedAt ? existing.trackingStartedAt : incoming.trackingStartedAt)
      : incoming.trackingStartedAt || existing?.trackingStartedAt,
    eventsTruncated: Boolean(existing?.eventsTruncated || incoming.eventsTruncated),
    coverageGap: Boolean(existing?.coverageGap || incoming.coverageGap || incomingHasTrackingGap),
    ...(incoming.schemaVersion === 2
      ? { questionTopicDemand: incoming.questionTopicDemand }
      : existing?.questionTopicDemand ? { questionTopicDemand: existing.questionTopicDemand } : {}),
    weeks,
  };
}
