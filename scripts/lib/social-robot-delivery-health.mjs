import {
  QUEUE_TTL_HOURS,
  SOCIAL_CHANNELS,
  isConfirmedInLedger,
  isExpired,
  ledgerKey,
  parseLedger,
  parseQueue,
} from './social-publish-queue.mjs';

export const SOCIAL_ROBOT_EXPECTED_INTERVAL_HOURS = 12;
export const SOCIAL_ROBOT_STALE_AFTER_HOURS = 36;

const MODES = new Set(['off', 'dry', 'live']);
const CHANNEL_STATES = new Set(['eligible', 'policy-held']);
const OUTCOME_PRIORITY = Object.freeze([
  'unconfirmed', 'error', 'held', 'paused', 'published', 'dry-run', 'cap', 'skipped', 'empty',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toIso(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function summarizeQueue(rawQueue, rawLedger, channel, nowMs, deliveredQueueIds = new Set()) {
  if (rawQueue === null || rawQueue === undefined || rawLedger === null || rawLedger === undefined) {
    return {
      queueStatus: 'unavailable',
      pendingCount: null,
      expiredPendingCount: null,
      unmeasuredPendingCount: null,
      oldestPendingAgeHours: null,
      oldestPendingKind: null,
      oldestPendingTtlHours: null,
    };
  }

  let pending;
  let ledger;
  try {
    const queue = parseQueue(rawQueue);
    ledger = parseLedger(rawLedger);
    const postedKeys = new Set(ledger.posted.map(ledgerKey));
    pending = queue.pending.filter((entry) => (
      entry.channel === channel
      && !deliveredQueueIds.has(entry.id)
      && !isConfirmedInLedger(ledger, entry.id)
      && !(entry.ledgerEntries || []).some((posted) => postedKeys.has(ledgerKey(posted)))
    ));
  } catch {
    return {
      queueStatus: 'invalid',
      pendingCount: null,
      expiredPendingCount: null,
      unmeasuredPendingCount: null,
      oldestPendingAgeHours: null,
      oldestPendingKind: null,
      oldestPendingTtlHours: null,
    };
  }

  let expiredPendingCount = 0;
  let unmeasuredPendingCount = 0;
  let oldest = null;
  for (const entry of pending) {
    const createdAtMs = Date.parse(String(entry.createdAt || ''));
    if (isExpired(entry, nowMs)) expiredPendingCount += 1;
    if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs) {
      unmeasuredPendingCount += 1;
      continue;
    }
    const ageHours = (nowMs - createdAtMs) / 3_600_000;
    if (!oldest || ageHours > oldest.ageHours) {
      const ttl = QUEUE_TTL_HOURS[entry.kind];
      oldest = {
        ageHours,
        kind: Object.hasOwn(QUEUE_TTL_HOURS, entry.kind) ? entry.kind : null,
        ttlHours: Number.isSafeInteger(ttl) ? ttl : null,
      };
    }
  }

  return {
    queueStatus: 'available',
    pendingCount: pending.length,
    expiredPendingCount,
    unmeasuredPendingCount,
    oldestPendingAgeHours: oldest ? Math.round(oldest.ageHours * 100) / 100 : null,
    oldestPendingKind: oldest?.kind || null,
    oldestPendingTtlHours: oldest?.ttlHours ?? null,
  };
}

function channelOutcome(results, mode, state) {
  if (state === 'policy-held') return 'policy-held';
  if (mode === 'off') return 'mode-off';
  const outcomes = results.map((result) => result.outcome);
  for (const candidate of OUTCOME_PRIORITY) {
    if (outcomes.includes(candidate)) return candidate;
  }
  return 'no-result';
}

/** Build a privacy-minimized snapshot of one unattended browser-robot run. */
export function buildSocialRobotDeliverySnapshot({
  startedAt = new Date(),
  recordedAt = new Date(),
  mode,
  dryRun,
  channels = [],
  results = [],
  confirmationRetries = [],
  queues = {},
  ledgers = {},
} = {}) {
  if (!MODES.has(mode)) throw new TypeError('social robot mode is invalid');
  if (typeof dryRun !== 'boolean') throw new TypeError('social robot dryRun must be boolean');
  const started = toIso(startedAt, 'startedAt');
  const recorded = toIso(recordedAt, 'recordedAt');
  const recordedMs = Date.parse(recorded);
  if (Date.parse(started) > recordedMs) throw new TypeError('social robot start time is after its record time');
  if (!Array.isArray(channels) || !Array.isArray(results) || !Array.isArray(confirmationRetries)
    || !isRecord(queues) || !isRecord(ledgers)) {
    throw new TypeError('social robot delivery inputs are malformed');
  }
  for (const retry of confirmationRetries) {
    if (!SOCIAL_CHANNELS.includes(retry?.channel) || typeof retry.queueId !== 'string'
      || !retry.queueId.trim() || typeof retry.confirmDispatched !== 'boolean') {
      throw new TypeError('social robot confirmation retry is malformed');
    }
  }

  const seen = new Set();
  const channelSnapshots = channels.map((item) => {
    const channel = typeof item === 'string' ? item : item?.channel;
    const state = typeof item === 'string' ? 'eligible' : item?.state;
    if (!SOCIAL_CHANNELS.includes(channel) || !CHANNEL_STATES.has(state) || seen.has(channel)) {
      throw new TypeError('social robot delivery channel is invalid or duplicated');
    }
    seen.add(channel);
    const channelResults = results.filter((result) => result?.channel === channel);
    const publishedCount = channelResults.filter((result) => result.outcome === 'published').length;
    const confirmationDispatchFailureCount = channelResults.filter((result) => (
      result.outcome === 'published' && result.confirmDispatched !== true
    )).length + confirmationRetries.filter((retry) => (
      retry.channel === channel && retry.confirmDispatched !== true
    )).length;
    const deliveredQueueIds = new Set(channelResults
      .filter((result) => result.outcome === 'published' && typeof result.queueId === 'string')
      .map((result) => result.queueId));
    for (const retry of confirmationRetries) {
      if (retry.channel === channel) deliveredQueueIds.add(retry.queueId);
    }
    return {
      channel,
      state,
      outcome: channelOutcome(channelResults, mode, state),
      publishedCount,
      confirmationDispatchFailureCount,
      ...summarizeQueue(queues[channel], ledgers[channel], channel, recordedMs, deliveredQueueIds),
    };
  });

  return {
    schemaVersion: 1,
    startedAt: started,
    recordedAt: recorded,
    expectedIntervalHours: SOCIAL_ROBOT_EXPECTED_INTERVAL_HOURS,
    staleAfterHours: SOCIAL_ROBOT_STALE_AFTER_HOURS,
    coverage: seen.size === SOCIAL_CHANNELS.length ? 'complete' : 'partial',
    mode,
    dryRun,
    channels: channelSnapshots,
  };
}

/** Render the latest heartbeat and queue state without exposing post IDs or content. */
export function summarizeSocialRobotDelivery(snapshot, asOf = new Date()) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new TypeError('asOf must be a valid date');
  const recordedAtMs = Date.parse(String(snapshot?.recordedAt || ''));
  if (!snapshot || snapshot.schemaVersion !== 1 || !Number.isFinite(recordedAtMs) || recordedAtMs > asOfMs) {
    return { status: 'not-yet-observed', recordedAt: null, ageHours: null, channels: [] };
  }

  const ageHours = Math.round(Math.max(0, (asOfMs - recordedAtMs) / 3_600_000) * 100) / 100;
  const snapshotStale = ageHours > SOCIAL_ROBOT_STALE_AFTER_HOURS;
  const channels = (Array.isArray(snapshot.channels) ? snapshot.channels : []).map((row) => {
    const queueOverdue = Number.isFinite(row.oldestPendingAgeHours)
      && Number.isFinite(row.oldestPendingTtlHours)
      && row.oldestPendingAgeHours > row.oldestPendingTtlHours;
    const queueAgeUnavailable = row.pendingCount > 0
      && (row.unmeasuredPendingCount > 0 || row.oldestPendingAgeHours === null);
    const needsAction = ['error', 'unconfirmed', 'held', 'paused'].includes(row.outcome)
      || row.queueStatus === 'invalid' || row.queueStatus === 'unavailable'
      || row.confirmationDispatchFailureCount > 0 || row.expiredPendingCount > 0
      || queueOverdue || queueAgeUnavailable;
    let status = 'observed';
    if (needsAction) status = row.expiredPendingCount > 0 ? 'queue-expired'
      : queueOverdue ? 'queue-overdue'
        : queueAgeUnavailable ? 'queue-age-unavailable' : 'action-required';
    else if (row.state === 'policy-held') status = 'policy-held';
    else if (snapshotStale) status = 'stale';
    else if (snapshot.mode === 'off' || row.outcome === 'mode-off') status = 'mode-off';
    else if (snapshot.dryRun || snapshot.mode === 'dry' || row.outcome === 'dry-run') status = 'dry-run';
    else if (row.pendingCount > 0) status = 'queued';
    return {
      channel: row.channel,
      state: row.state,
      outcome: row.outcome,
      status,
      queueStatus: row.queueStatus,
      pendingCount: row.pendingCount,
      expiredPendingCount: row.expiredPendingCount,
      unmeasuredPendingCount: row.unmeasuredPendingCount,
      oldestPendingAgeHours: row.oldestPendingAgeHours,
      oldestPendingKind: row.oldestPendingKind,
      oldestPendingTtlHours: row.oldestPendingTtlHours,
      publishedCount: row.publishedCount,
      confirmationDispatchFailureCount: row.confirmationDispatchFailureCount,
    };
  });
  const actionable = channels.some((row) => [
    'action-required', 'queue-expired', 'queue-overdue', 'queue-age-unavailable',
  ].includes(row.status));
  const status = actionable ? 'action-required'
    : snapshotStale ? 'stale'
      : snapshot.coverage !== 'complete' ? 'partial-coverage'
        : snapshot.mode === 'off' ? 'mode-off'
        : snapshot.dryRun || snapshot.mode === 'dry' ? 'dry-run'
          : channels.some((row) => row.status === 'queued') ? 'queued'
            : 'fresh';
  return {
    status,
    recordedAt: new Date(recordedAtMs).toISOString(),
    ageHours,
    staleAfterHours: SOCIAL_ROBOT_STALE_AFTER_HOURS,
    coverage: snapshot.coverage === 'complete' ? 'complete' : 'partial',
    mode: snapshot.mode,
    dryRun: snapshot.dryRun,
    channels,
  };
}
