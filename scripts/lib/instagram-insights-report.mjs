/**
 * Pure aggregation for the Instagram creative scorecard.
 *
 * Instagram Insights is an external surface and its export shape changes
 * between the Professional Dashboard and the API. This module accepts the
 * small common subset we need, normalises aliases, and deliberately refuses
 * to call a winner before the minimum number of comparable observations.
 * There is no network access and no credential handling here.
 */

export const DEFAULT_MINIMUM_OBSERVATIONS = 3;
export const DEFAULT_WINDOW_HOURS = 72;

export const PRIMARY_METRIC_BY_OBJECTIVE = Object.freeze({
  share: 'shares',
  save: 'saves',
  conversation: 'comments',
});

const OBJECTIVE_BY_CREATIVE = Object.freeze({
  proof: 'share',
  save: 'save',
  question: 'conversation',
});

function objectiveForCreative(creativeId) {
  const id = String(creativeId || '').trim();
  return OBJECTIVE_BY_CREATIVE[id] || OBJECTIVE_BY_CREATIVE[id.split('-', 1)[0]] || null;
}

const METRIC_ALIASES = Object.freeze({
  reach: ['reach', 'reach_count', 'accounts_reached'],
  shares: ['shares', 'share_count', 'shares_count'],
  saves: ['saves', 'saved', 'save_count', 'saved_count'],
  comments: ['comments', 'comment_count', 'comments_count'],
  profileVisits: ['profileVisits', 'profile_visits', 'profile_activity'],
  linkClicks: ['linkClicks', 'link_clicks', 'website_clicks'],
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values) {
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

function directMetric(row, aliases) {
  const containers = [row, row.metrics].filter(isRecord);
  for (const container of containers) {
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(container, alias)) return container[alias];
    }
  }

  // Meta's media-insights response nests the metric list under
  // `insights.data`; dashboard exports and older adapters may expose the
  // same list directly as `insights` or under `metrics.data`.
  const insights = [
    ...(Array.isArray(row.insights) ? row.insights : []),
    ...(isRecord(row.insights) && Array.isArray(row.insights.data) ? row.insights.data : []),
    ...(isRecord(row.metrics) && Array.isArray(row.metrics.data) ? row.metrics.data : []),
  ];
  for (const insight of insights) {
    if (!isRecord(insight)) continue;
    const name = String(insight.name ?? '').trim();
    if (!aliases.includes(name)) continue;
    if (Array.isArray(insight.values)) return insight.values.at(-1)?.value;
    return insight.value;
  }
  return null;
}

function readMetric(row, name, { required = false } = {}) {
  const value = finiteNumber(directMetric(row, METRIC_ALIASES[name] || [name]));
  if (value === null) return required ? null : 0;
  return value;
}

function extractRows(input) {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) throw new Error('Insights input must be an array or an object containing rows');
  for (const key of ['posts', 'data', 'rows', 'results']) {
    if (Array.isArray(input[key])) return input[key];
  }
  throw new Error('Insights input must contain an array in posts, data, rows, or results');
}

function ledgerEntries(ledger) {
  if (Array.isArray(ledger)) return ledger;
  if (isRecord(ledger) && Array.isArray(ledger.posted)) return ledger.posted;
  return [];
}

function buildLedgerLookup(ledger) {
  const lookup = new Map();
  for (const entry of ledgerEntries(ledger)) {
    if (!isRecord(entry)) continue;
    const creativeId = firstString(entry.creativeId, entry.creative_id);
    if (!creativeId) continue;
    for (const key of ['instagramMediaId', 'mediaId', 'media_id', 'queueId', 'queue_id']) {
      const value = firstString(entry[key]);
      if (value) lookup.set(value, creativeId);
    }
  }
  return lookup;
}

function reject(rejected, index, reason) {
  rejected.push({ row: index + 1, reason });
}

/**
 * Normalise one export into one row per post at one measurement window.
 * `ledger` is optional; it lets a Meta export identify a treatment through a
 * media/queue id without copying captions or URLs into the export file.
 */
export function normalizeInsightRows(input, { ledger = null } = {}) {
  const source = extractRows(input);
  const lookup = buildLedgerLookup(ledger);
  const rows = [];
  const rejected = [];

  source.forEach((raw, index) => {
    if (!isRecord(raw)) {
      reject(rejected, index, 'row is not an object');
      return;
    }

    const postId = firstString(raw.id, raw.media_id, raw.mediaId, raw.post_id, raw.queueId, raw.queue_id)
      || `row-${index + 1}`;
    const creativeId = firstString(
      raw.creativeId,
      raw.creative_id,
      raw.creative?.id,
      lookup.get(postId),
    );
    if (!creativeId) {
      reject(rejected, index, 'creativeId missing (add it or provide --ledger)');
      return;
    }

    const objective = firstString(
      raw.creativeObjective,
      raw.creative_objective,
      raw.objective,
      raw.creative?.objective,
      objectiveForCreative(creativeId),
    );
    const primaryMetric = firstString(
      raw.primaryMetric,
      raw.primary_metric,
      raw.creative?.primaryMetric,
      objective ? PRIMARY_METRIC_BY_OBJECTIVE[objective] : null,
    );
    if (
      !objective
      || !primaryMetric
      || !PRIMARY_METRIC_BY_OBJECTIVE[objective]
      || primaryMetric !== PRIMARY_METRIC_BY_OBJECTIVE[objective]
    ) {
      reject(rejected, index, 'objective/primary metric missing or unsupported');
      return;
    }

    const reach = readMetric(raw, 'reach', { required: true });
    if (reach === null || reach <= 0) {
      reject(rejected, index, 'reach must be a positive number');
      return;
    }

    const metrics = {
      shares: readMetric(raw, 'shares'),
      saves: readMetric(raw, 'saves'),
      comments: readMetric(raw, 'comments'),
      profileVisits: readMetric(raw, 'profileVisits'),
      linkClicks: readMetric(raw, 'linkClicks'),
    };
    if (Object.values(metrics).some((value) => value < 0)) {
      reject(rejected, index, 'engagement metrics cannot be negative');
      return;
    }

    const rawWindow = firstString(raw.windowHours, raw.window_hours, raw.measurementWindowHours);
    const windowHours = rawWindow === null ? DEFAULT_WINDOW_HOURS : finiteNumber(rawWindow);
    if (windowHours === null || windowHours <= 0) {
      reject(rejected, index, 'windowHours must be a positive number');
      return;
    }

    rows.push({
      postId,
      creativeId,
      kind: firstString(raw.kind, raw.contentKind, raw.content_kind) || 'unknown',
      objective,
      primaryMetric,
      windowHours,
      reach,
      ...metrics,
    });
  });

  return { rows, rejected };
}

function rate(value, reach) {
  return reach > 0 ? value / reach : 0;
}

/**
 * Aggregate comparable rows by creative, content kind and measurement
 * window. The common interaction rate is only an
 * exploratory guardrail; the treatment's primary rate remains the decision
 * metric. This prevents comparing shares and saves as if they were the same
 * business objective.
 */
export function aggregateCreativePerformance(rows, { minimumObservations = DEFAULT_MINIMUM_OBSERVATIONS } = {}) {
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  if (!Number.isInteger(minimumObservations) || minimumObservations < 1) {
    throw new Error('minimumObservations must be a positive integer');
  }

  const groups = new Map();
  for (const row of rows) {
    const kind = firstString(row.kind) || 'unknown';
    const key = `${row.creativeId}\u0000${kind}\u0000${row.windowHours}`;
    const group = groups.get(key) || {
      creativeId: row.creativeId,
      objective: row.objective,
      primaryMetric: row.primaryMetric,
      kind,
      windowHours: row.windowHours,
      observations: 0,
      kinds: new Set(),
      reach: 0,
      shares: 0,
      saves: 0,
      comments: 0,
      profileVisits: 0,
      linkClicks: 0,
    };
    group.observations += 1;
    group.kinds.add(kind);
    for (const metric of ['reach', 'shares', 'saves', 'comments', 'profileVisits', 'linkClicks']) {
      group[metric] += Number(row[metric]) || 0;
    }
    groups.set(key, group);
  }

  const treatments = Array.from(groups.values()).map((group) => {
    const interactions = group.shares + group.saves + group.comments;
    const primaryTotal = group[group.primaryMetric] || 0;
    const eligible = group.observations >= minimumObservations;
    return {
      creativeId: group.creativeId,
      objective: group.objective,
      primaryMetric: group.primaryMetric,
      kind: group.kind,
      windowHours: group.windowHours,
      observations: group.observations,
      kinds: Array.from(group.kinds).sort(),
      reach: group.reach,
      shares: group.shares,
      saves: group.saves,
      comments: group.comments,
      profileVisits: group.profileVisits,
      linkClicks: group.linkClicks,
      primaryTotal,
      primaryRate: rate(primaryTotal, group.reach),
      interactionTotal: interactions,
      interactionRate: rate(interactions, group.reach),
      eligible,
      status: eligible ? 'eligible' : `needs-${minimumObservations - group.observations}-more`,
    };
  });

  const sortedTreatments = treatments.sort(
    (a, b) => a.creativeId.localeCompare(b.creativeId)
      || a.kind.localeCompare(b.kind)
      || a.windowHours - b.windowHours,
  );
  const comparisonGroups = new Map();
  for (const treatment of sortedTreatments) {
    if (!treatment.eligible) continue;
    const key = `${treatment.objective}\u0000${treatment.kind}\u0000${treatment.windowHours}`;
    const group = comparisonGroups.get(key) || [];
    group.push(treatment);
    comparisonGroups.set(key, group);
  }

  const exploratoryRanking = [];
  const exploratoryWinners = [];
  for (const group of comparisonGroups.values()) {
    group.sort((a, b) => b.interactionRate - a.interactionRate || b.primaryRate - a.primaryRate || a.creativeId.localeCompare(b.creativeId));
    const winner = group[0];
    exploratoryWinners.push({
      creativeId: winner.creativeId,
      objective: winner.objective,
      kind: winner.kind,
      windowHours: winner.windowHours,
      interactionRate: winner.interactionRate,
      primaryRate: winner.primaryRate,
    });
    group.forEach((treatment, index) => {
      exploratoryRanking.push({
        creativeId: treatment.creativeId,
        objective: treatment.objective,
        kind: treatment.kind,
        windowHours: treatment.windowHours,
        rank: index + 1,
      });
    });
  }

  return {
    minimumObservations,
    acceptedRows: rows.length,
    treatments: sortedTreatments,
    exploratoryRanking,
    exploratoryWinners,
    exploratoryWinner: exploratoryWinners.length === 1 ? exploratoryWinners[0].creativeId : null,
    methodology: {
      comparisonUnit: 'creativeId + content kind + measurement window',
      primaryRate: 'primary metric / reach',
      interactionRate: '(shares + saves + comments) / reach',
      rankingWarning: 'exploratoryRanking is a within-objective guardrail, not a replacement for each treatment primary metric or a cross-objective winner',
    },
  };
}

export function buildCreativeReport(input, options = {}) {
  const normalized = normalizeInsightRows(input, options);
  const aggregate = aggregateCreativePerformance(normalized.rows, options);
  return { ...aggregate, rejectedRows: normalized.rejected };
}

function percentage(value) {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatCreativeReport(report) {
  const lines = [
    '📊 Instagram creative scorecard',
    `   Rows accepted: ${report.acceptedRows} · rejected: ${report.rejectedRows.length}`,
    `   Minimum observations per treatment: ${report.minimumObservations}`,
    '',
  ];
  if (report.treatments.length === 0) {
    lines.push('   No valid treatment rows yet.');
  } else {
    for (const treatment of report.treatments) {
      lines.push(
        `   ${treatment.creativeId.padEnd(18)} ${treatment.kind.padEnd(8)} ${treatment.windowHours}h · ${treatment.observations} obs · `
        + `primary ${percentage(treatment.primaryRate)} · interactions ${percentage(treatment.interactionRate)} · ${treatment.status}`,
      );
    }
  }
  lines.push('');
  if (!report.exploratoryWinners?.length) {
    lines.push('   No exploratory leader: collect more comparable observations.');
  } else if (report.exploratoryWinners.length === 1) {
    const winner = report.exploratoryWinners[0];
    lines.push(`   Exploratory leader (${winner.kind}, ${winner.windowHours}h): ${winner.creativeId}`);
  } else {
    lines.push(`   Exploratory leaders: ${report.exploratoryWinners
      .map((winner) => `${winner.creativeId} (${winner.kind}, ${winner.windowHours}h)`)
      .join('; ')}`);
  }
  if (report.rejectedRows.length) {
    lines.push(`   Rejected rows: ${report.rejectedRows.map((row) => `${row.row} (${row.reason})`).join(', ')}`);
  }
  return lines.join('\n');
}
