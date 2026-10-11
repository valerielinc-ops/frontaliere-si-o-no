/**
 * Pure status aggregation for the Instagram creative experiment loop.
 *
 * The publishing ledger stores one row per carousel card, while Insights
 * measures one Instagram media object. This module keeps those units
 * separate: a carousel with five cards is one published post and can produce
 * one observation for a given measurement window.
 */
import {
  groupPostedLedger,
  snapshotRows,
} from './instagram-insights-snapshot.mjs';

export const EXPERIMENT_STATUS_SCHEMA_VERSION = 1;
export const DEFAULT_MINIMUM_OBSERVATIONS = 3;
export const DEFAULT_WINDOW_HOURS = 72;

const DEFAULT_MISSING_CREDENTIALS = Object.freeze([
  'INSTAGRAM_BUSINESS_ACCOUNT_ID',
  'INSTAGRAM_ACCESS_TOKEN',
]);

/** Browser is the Mac-host default; Graph is retained only as an explicit fallback. */
export function resolveInstagramInsightsSource(env = process.env) {
  const configured = firstText(env.SOCIAL_ROBOT_INSIGHTS_SOURCE)?.toLowerCase();
  if (configured === 'graph' || configured === 'browser' || configured === 'off') return configured;
  return 'browser';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function validatePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function validatePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function queueRows(queue) {
  if (Array.isArray(queue)) return queue.filter(isRecord);
  if (isRecord(queue) && Array.isArray(queue.pending)) return queue.pending.filter(isRecord);
  return [];
}

function firstLedgerEntry(item) {
  return Array.isArray(item.ledgerEntries)
    ? item.ledgerEntries.find(isRecord) || null
    : null;
}

function pendingCreative(item) {
  const ledgerEntry = firstLedgerEntry(item);
  const read = (key, alias) => firstText(item[key], ledgerEntry?.[key], alias ? item[alias] : null, alias ? ledgerEntry?.[alias] : null);
  return {
    id: firstText(item.id, item.queueId, item.queue_id),
    kind: read('kind', 'contentKind') || 'unknown',
    day: read('day'),
    creativeId: read('creativeId', 'creative_id'),
    creativeBaseId: read('creativeBaseId', 'creative_base_id'),
    creativeVariant: read('creativeVariant', 'creative_variant'),
    creativeLabel: read('creativeLabel', 'creative_label'),
    creativeObjective: read('creativeObjective', 'creative_objective'),
    primaryMetric: read('primaryMetric', 'primary_metric'),
    engagementMechanic: read('engagementMechanic', 'engagement_mechanic'),
    hookType: read('hookType', 'hook_type'),
    attentionMechanic: read('attentionMechanic', 'attention_mechanic'),
    engagementLoop: read('engagementLoop', 'engagement_loop'),
    followUpFormat: read('followUpFormat', 'follow_up_format'),
    createdAt: isoTimestamp(item.createdAt || item.created_at),
    expiresAt: isoTimestamp(item.expiresAt || item.expires_at),
  };
}

function pendingCreatives(queue, ledger = { posted: [] }) {
  const publishedKindDays = new Set(
    groupPostedLedger(ledger).map((group) => `${group.kind}\u0000${group.day}`),
  );
  return queueRows(queue)
    .map(pendingCreative)
    .filter((item) => item.id)
    .filter((item) => !publishedKindDays.has(`${item.kind}\u0000${item.day}`))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
}

function isCohortable(group) {
  return Boolean(
    group
    && !group.conflictingCreativeId
    && firstText(group.creativeId)
    && firstText(group.kind)
    && firstText(group.creativeObjective)
    && firstText(group.primaryMetric),
  );
}

function postIdentityCandidates(row) {
  return [
    row.mediaId,
    row.media_id,
    row.instagramMediaId,
    row.instagram_media_id,
    row.postId,
    row.post_id,
    row.queueId,
    row.queue_id,
    row.identity,
    row.id,
  ].map((value) => firstText(value)).filter(Boolean);
}

function stablePostIdentity(row) {
  return postIdentityCandidates(row)[0] || null;
}

function groupIdentityKeys(group) {
  return [group.mediaId, group.queueId, group.identity]
    .map((value) => firstText(value))
    .filter(Boolean);
}

function buildGroupLookup(groups) {
  const lookup = new Map();
  for (const group of groups) {
    for (const key of groupIdentityKeys(group)) {
      if (lookup.has(key) && lookup.get(key) !== group) {
        lookup.set(key, null);
      } else if (!lookup.has(key)) {
        lookup.set(key, group);
      }
    }
  }
  return lookup;
}

function findGroupForRow(row, lookup) {
  const matches = new Set();
  for (const identity of postIdentityCandidates(row)) {
    const group = lookup.get(identity);
    if (group) matches.add(group);
    if (group === null) return { group: null, ambiguous: true };
  }
  if (matches.size === 0) return { group: undefined, ambiguous: false };
  if (matches.size > 1) return { group: null, ambiguous: true };
  return { group: [...matches][0], ambiguous: false };
}

function insightWindow(row, fallback) {
  const raw = firstText(row.windowHours, row.window_hours, row.measurementWindowHours);
  return raw === null ? fallback : finiteNumber(raw);
}

function cohortKey(group, windowHours) {
  return [group.creativeId, group.kind, windowHours].join('\u0000');
}

function createCohort(group, windowHours) {
  return {
    key: cohortKey(group, windowHours),
    creativeId: group.creativeId,
    creativeBaseId: group.creativeBaseId || null,
    creativeVariant: group.creativeVariant || null,
    creativeLabel: group.creativeLabel || null,
    objective: group.creativeObjective,
    primaryMetric: group.primaryMetric,
    engagementMechanic: group.engagementMechanic || null,
    hookType: group.hookType || null,
    attentionMechanic: group.attentionMechanic || null,
    engagementLoop: group.engagementLoop || null,
    followUpFormat: group.followUpFormat || null,
    kind: group.kind,
    windowHours,
    publishedPostKeys: new Set(),
    observedPostKeys: new Set(),
    observedWindowsByPost: new Map(),
    nextEligibleAtMs: null,
  };
}

function addGroupToCohort(cohort, group, windowHours) {
  cohort.publishedPostKeys.add(group.identity);
  if (group.publishedAtMs === null || group.publishedAtMs === undefined) return;
  const eligibleAt = group.publishedAtMs + windowHours * 3_600_000;
  cohort.nextEligibleAtMs = cohort.nextEligibleAtMs === null
    ? eligibleAt
    : Math.min(cohort.nextEligibleAtMs, eligibleAt);
}

function addObservationToCohort(cohort, group, windowHours) {
  cohort.observedPostKeys.add(group.identity);
  const observedWindows = cohort.observedWindowsByPost.get(group.identity) || new Set();
  observedWindows.add(windowHours);
  cohort.observedWindowsByPost.set(group.identity, observedWindows);
}

function statusForCohort(cohort, { asOfMs, hasCredentials, insightsAvailable, minimumObservations }) {
  const publishedPosts = cohort.publishedPostKeys.size;
  const observedPosts = cohort.observedPostKeys.size;
  if (observedPosts >= minimumObservations) return 'ready-to-compare';
  if (!hasCredentials && observedPosts < publishedPosts) return 'awaiting-meta-credentials';
  if (observedPosts === 0 && !insightsAvailable) return 'awaiting-insights';
  if (cohort.nextEligibleAtMs !== null && cohort.nextEligibleAtMs > asOfMs) {
    return 'awaiting-72h-window';
  }
  return `needs-${minimumObservations - observedPosts}-more`;
}

function serializePublishedGroup(group, observedWindows = []) {
  const hasConflict = Boolean(group.conflictingCreativeId);
  const metadataComplete = isCohortable(group);
  return {
    identity: group.identity,
    mediaId: group.mediaId || null,
    queueId: group.queueId || null,
    kind: group.kind || 'unknown',
    day: group.day || null,
    creativeId: group.creativeId || null,
    creativeBaseId: group.creativeBaseId || null,
    creativeVariant: group.creativeVariant || null,
    creativeLabel: group.creativeLabel || null,
    creativeObjective: group.creativeObjective || null,
    primaryMetric: group.primaryMetric || null,
    engagementMechanic: group.engagementMechanic || null,
    hookType: group.hookType || null,
    attentionMechanic: group.attentionMechanic || null,
    engagementLoop: group.engagementLoop || null,
    followUpFormat: group.followUpFormat || null,
    publishedAt: group.publishedAtMs === null || group.publishedAtMs === undefined
      ? null
      : new Date(group.publishedAtMs).toISOString(),
    entries: group.entries,
    eligibleForExperiment: metadataComplete,
    status: hasConflict
      ? 'metadata-conflict'
      : metadataComplete ? 'tracked' : 'metadata-incomplete',
    observedWindows: [...new Set(observedWindows)].sort((a, b) => a - b),
  };
}

function serializeCohort(cohort, args) {
  const observedPosts = cohort.observedPostKeys.size;
  const publishedPosts = cohort.publishedPostKeys.size;
  const nextEligibleAt = cohort.nextEligibleAtMs === null
    ? null
    : new Date(cohort.nextEligibleAtMs).toISOString();
  return {
    creativeId: cohort.creativeId,
    creativeBaseId: cohort.creativeBaseId,
    creativeVariant: cohort.creativeVariant,
    creativeLabel: cohort.creativeLabel,
    objective: cohort.objective,
    primaryMetric: cohort.primaryMetric,
    engagementMechanic: cohort.engagementMechanic,
    hookType: cohort.hookType,
    attentionMechanic: cohort.attentionMechanic,
    engagementLoop: cohort.engagementLoop,
    followUpFormat: cohort.followUpFormat,
    kind: cohort.kind,
    windowHours: cohort.windowHours,
    publishedPosts,
    observedPosts,
    independentObservations: observedPosts,
    minimumObservations: args.minimumObservations,
    eligible: observedPosts >= args.minimumObservations,
    status: statusForCohort(cohort, args),
    nextEligibleAt,
  };
}

function addAction(actions, code, detail) {
  if (actions.some((action) => action.code === code)) return;
  actions.push({ code, detail });
}

function buildNextActions({ pending, publishedPosts, cohorts, blockers, hasCredentials }) {
  const actions = [];
  if (!hasCredentials && publishedPosts.length > 0) {
    addAction(actions, 'configure-meta-insights', 'Impostare INSTAGRAM_BUSINESS_ACCOUNT_ID e INSTAGRAM_ACCESS_TOKEN senza stamparli nei log.');
  }
  if (pending.length > 0) {
    addAction(actions, 'publish-pending-creative', `Valutare la coda Instagram: ${pending[0].id} è ancora in attesa.`);
  }
  if (cohorts.some((cohort) => cohort.status === 'awaiting-72h-window')) {
    addAction(actions, 'wait-for-72h-window', 'Attendere la finestra completa prima di attribuire una performance.');
  }
  if (cohorts.some((cohort) => cohort.status === 'ready-to-compare')) {
    addAction(actions, 'compare-eligible-cohorts', 'Confrontare solo coorti dello stesso obiettivo, formato e finestra.');
  }
  if (cohorts.some((cohort) => cohort.status.startsWith('needs-'))) {
    addAction(actions, 'collect-more-comparable-posts', 'Continuare la rotazione fino ad avere tre osservazioni indipendenti per variante.');
  }
  if (publishedPosts.length > 0 && blockers.some((blocker) => blocker.code === 'insights-snapshot-missing')) {
    addAction(actions, 'collect-72h-insights', 'Eseguire il collector read-only quando le credenziali Meta sono disponibili.');
  }
  if (actions.length === 0) {
    addAction(actions, 'keep-experiment-running', 'Mantenere la cadenza e registrare il prossimo post della matrice.');
  }
  return actions;
}

/**
 * Build a machine-readable experiment status without network access.
 * `hasCredentials` is deliberately supplied by the caller so this module
 * never reads or exposes a token.
 */
export function buildExperimentStatus({
  ledger = { posted: [] },
  queue = { pending: [] },
  insights = null,
  asOf = new Date(),
  minimumObservations = DEFAULT_MINIMUM_OBSERVATIONS,
  windowHours = DEFAULT_WINDOW_HOURS,
  hasCredentials = false,
  missingCredentials = DEFAULT_MISSING_CREDENTIALS,
} = {}) {
  validatePositiveInteger(minimumObservations, 'minimumObservations');
  validatePositiveNumber(windowHours, 'windowHours');
  const asOfMs = timestamp(asOf);
  if (asOfMs === null) throw new Error('asOf must be a valid timestamp');

  const groups = groupPostedLedger(ledger);
  const publishedPosts = groups.map((group) => serializePublishedGroup(group));
  const groupLookup = buildGroupLookup(groups);
  const observedWindowsByGroup = new Map();
  const cohortsByKey = new Map();
  const rows = snapshotRows(insights);
  const rejectedRows = [];
  const seenPostWindows = new Set();
  let acceptedRows = 0;

  for (const group of groups) {
    if (!isCohortable(group)) continue;
    const key = cohortKey(group, windowHours);
    const cohort = cohortsByKey.get(key) || createCohort(group, windowHours);
    addGroupToCohort(cohort, group, windowHours);
    cohortsByKey.set(key, cohort);
  }

  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      rejectedRows.push({ row: index + 1, reason: 'row is not an object' });
      return;
    }
    const identity = stablePostIdentity(row);
    if (!identity) {
      rejectedRows.push({ row: index + 1, reason: 'stable post identity missing' });
      return;
    }
    const rowWindow = insightWindow(row, windowHours);
    if (rowWindow === null || rowWindow <= 0) {
      rejectedRows.push({ row: index + 1, reason: 'windowHours must be a positive number' });
      return;
    }
    if (rowWindow !== windowHours) {
      rejectedRows.push({ row: index + 1, reason: `measurement window is ${rowWindow}h, target is ${windowHours}h` });
      return;
    }
    const groupMatch = findGroupForRow(row, groupLookup);
    const group = groupMatch.group;
    if (!group) {
      rejectedRows.push({ row: index + 1, reason: groupMatch.ambiguous ? 'post identity is ambiguous in ledger' : 'post is not in the creative ledger' });
      return;
    }
    if (!isCohortable(group)) {
      rejectedRows.push({ row: index + 1, reason: group.conflictingCreativeId ? 'creative metadata conflicts in ledger' : 'creative metadata incomplete in ledger' });
      return;
    }

    const rowCreativeId = firstText(row.creativeId, row.creative_id, row.creative?.id);
    if (rowCreativeId && rowCreativeId !== group.creativeId) {
      rejectedRows.push({ row: index + 1, reason: 'creativeId disagrees with ledger' });
      return;
    }
    const rowKind = firstText(row.kind, row.contentKind, row.content_kind);
    if (rowKind && rowKind !== group.kind) {
      rejectedRows.push({ row: index + 1, reason: 'content kind disagrees with ledger' });
      return;
    }

    const postWindowKey = `${group.identity}\u0000${rowWindow}`;
    if (seenPostWindows.has(postWindowKey)) {
      rejectedRows.push({ row: index + 1, reason: 'duplicate post/window observation' });
      return;
    }
    seenPostWindows.add(postWindowKey);

    const key = cohortKey(group, windowHours);
    const cohort = cohortsByKey.get(key);
    if (!cohort) {
      rejectedRows.push({ row: index + 1, reason: 'creative cohort missing' });
      return;
    }
    acceptedRows += 1;
    addObservationToCohort(cohort, group, rowWindow);
    const observedWindows = observedWindowsByGroup.get(group.identity) || new Set();
    observedWindows.add(rowWindow);
    observedWindowsByGroup.set(group.identity, observedWindows);
  });

  const serializedCohorts = [...cohortsByKey.values()]
    .sort((a, b) => a.creativeId.localeCompare(b.creativeId) || a.kind.localeCompare(b.kind))
    .map((cohort) => serializeCohort(cohort, {
      asOfMs,
      hasCredentials: Boolean(hasCredentials),
      insightsAvailable: rows.length > 0,
      minimumObservations,
    }));

  const publishedWithObservations = publishedPosts.map((post) => ({
    ...post,
    observedWindows: [...(observedWindowsByGroup.get(post.identity) || new Set())].sort((a, b) => a - b),
  }));
  const metadataProblems = publishedPosts.filter((post) => !post.eligibleForExperiment);
  const blockers = [];
  if (metadataProblems.length > 0) {
    blockers.push({
      code: 'creative-metadata-incomplete',
      detail: `${metadataProblems.length} post sperimentali non ha metadati coerenti o completi.`,
    });
  }
  if (publishedPosts.length > 0 && !hasCredentials) {
    blockers.push({
      code: 'meta-credentials-missing',
      missing: [...missingCredentials],
      detail: 'Il collector non può leggere gli Insights finché le credenziali Meta non sono configurate.',
    });
  }
  if (publishedPosts.length > 0 && rows.length === 0) {
    blockers.push({
      code: 'insights-snapshot-missing',
      detail: 'Non esiste ancora un dataset di snapshot Insights.',
    });
  } else if (publishedPosts.length > 0 && rows.length > 0 && seenPostWindows.size === 0) {
    blockers.push({
      code: 'insights-no-attributable-observations',
      detail: 'Gli snapshot presenti non sono attribuibili a un post creativo nella finestra target.',
    });
  }

  const nextActions = buildNextActions({
    pending: pendingCreatives(queue, ledger),
    publishedPosts,
    cohorts: serializedCohorts,
    blockers,
    hasCredentials: Boolean(hasCredentials),
  });
  const pending = pendingCreatives(queue, ledger);

  return {
    schemaVersion: EXPERIMENT_STATUS_SCHEMA_VERSION,
    asOf: new Date(asOfMs).toISOString(),
    minimumObservations,
    windowHours,
    credentials: {
      configured: Boolean(hasCredentials),
      missing: Boolean(hasCredentials) ? [] : [...missingCredentials],
    },
    pending,
    publishedPosts: publishedWithObservations,
    cohorts: serializedCohorts,
    insights: {
      source: resolveInstagramInsightsSource(),
      sourceRows: rows.length,
      independentObservations: serializedCohorts.reduce((sum, cohort) => sum + cohort.observedPosts, 0),
      acceptedRows,
      rejectedRows,
    },
    blockers,
    nextAction: nextActions[0]?.code || null,
    nextActions,
  };
}

export function formatExperimentStatus(status) {
  const lines = [
    '🧪 Instagram experiment status',
    `   As of: ${status.asOf}`,
    `   Published experimental posts: ${status.publishedPosts.length} · pending: ${status.pending.length} · target: ${status.windowHours}h`,
    '   Unit of analysis: one Instagram post/media per observation; carousel cards stay grouped.',
    `   Meta Insights credentials: ${status.credentials.configured ? 'configured' : 'missing'}`,
    '',
  ];
  if (status.cohorts.length === 0) {
    lines.push('   No complete creative cohort is tracked yet.');
  } else {
    for (const cohort of status.cohorts) {
      const label = cohort.creativeVariant ? ` (${cohort.creativeVariant})` : '';
      const loop = cohort.engagementLoop ? ` · loop ${cohort.engagementLoop}` : '';
      lines.push(
        `   ${cohort.creativeId}${label} · ${cohort.kind} · ${cohort.observedPosts}/${cohort.minimumObservations} independent obs · `
        + `${cohort.publishedPosts} published · ${cohort.status}${loop}`,
      );
    }
  }
  if (status.blockers.length) {
    lines.push('', '   Blockers:');
    for (const blocker of status.blockers) lines.push(`   - ${blocker.code}: ${blocker.detail}`);
  }
  if (status.nextAction) lines.push('', `   Next action: ${status.nextAction}`);
  return lines.join('\n');
}
