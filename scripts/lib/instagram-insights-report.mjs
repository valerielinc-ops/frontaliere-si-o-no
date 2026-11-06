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
export const DEFAULT_WINDOW_TOLERANCE_HOURS = 6;

export const PRIMARY_METRIC_BY_OBJECTIVE = Object.freeze({
  share: 'shares',
  save: 'saves',
  conversation: 'comments',
  follow: 'follows',
});

const OBJECTIVE_BY_CREATIVE = Object.freeze({
  proof: 'share',
  save: 'save',
  question: 'conversation',
  reel: 'conversation',
  'reel-question': 'conversation',
  'reel-number': 'share',
  'reel-follow': 'follow',
  'reel-save': 'save',
});

function objectiveForCreative(creativeId) {
  const id = String(creativeId || '').trim();
  return OBJECTIVE_BY_CREATIVE[id] || OBJECTIVE_BY_CREATIVE[id.split('-', 1)[0]] || null;
}

const METRIC_ALIASES = Object.freeze({
  views: ['views', 'view_count', 'impressions', 'visualizzazioni'],
  reach: ['reach', 'reach_count', 'accounts_reached'],
  shares: ['shares', 'share_count', 'shares_count'],
  follows: ['follows', 'follow_count', 'follows_count'],
  saves: ['saves', 'saved', 'save_count', 'saved_count'],
  comments: ['comments', 'comment_count', 'comments_count'],
  profileVisits: ['profileVisits', 'profile_visits', 'profile_activity'],
  linkClicks: ['linkClicks', 'link_clicks', 'website_clicks'],
});

const CSV_FIELD_ALIASES = Object.freeze({
  id: ['id', 'mediaid', 'postid', 'queueid'],
  kind: ['kind', 'contentkind', 'contenttype'],
  creativeId: ['creativeid', 'creative'],
  creativeBaseId: ['creativebaseid'],
  creativeVariant: ['creativevariant', 'variant'],
  creativeLabel: ['creativelabel'],
  creativeObjective: ['creativeobjective', 'objective'],
  backgroundExperimentId: ['backgroundexperimentid', 'visualexperimentid'],
  backgroundVariant: ['backgroundvariant', 'visualvariant', 'background'],
  backgroundLabel: ['backgroundlabel', 'visuallabel'],
  safeAreaVersion: ['safeareaversion', 'layoutversion'],
  primaryMetric: ['primarymetric'],
  engagementMechanic: ['engagementmechanic'],
  hookType: ['hooktype', 'hook'],
  attentionMechanic: ['attentionmechanic'],
  engagementLoop: ['engagementloop', 'loop'],
  followUpFormat: ['followupformat', 'followup'],
  reach: ['reach', 'reachcount', 'accountsreached'],
  views: ['views', 'viewcount', 'impressions', 'visualizzazioni'],
  shares: ['shares', 'sharecount', 'sharescount'],
  saves: ['saves', 'saved', 'savecount', 'savedcount'],
  comments: ['comments', 'commentcount', 'commentscount'],
  profileVisits: ['profilevisits', 'profileactivity'],
  linkClicks: ['linkclicks', 'websiteclicks'],
  windowHours: ['windowhours', 'measurementwindowhours'],
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCsvHeader(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function detectCsvDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/u).find((line) => line.trim()) || '';
  const counts = [',', ';', '\t'].map((delimiter) => ({
    delimiter,
    count: [...firstLine].filter((char) => char === delimiter).length,
  }));
  const winner = counts.sort((a, b) => b.count - a.count)[0];
  return winner?.count > 0 ? winner.delimiter : ',';
}

function parseCsvRecords(text, delimiter) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/u, '');

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field.trim());
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      record.push(field.trim());
      if (record.some((value) => value !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field.length > 0 || record.length > 0) {
    record.push(field.trim());
    if (record.some((value) => value !== '')) records.push(record);
  }
  return records;
}

function csvField(row, aliases) {
  for (const alias of aliases) {
    const key = Object.keys(row).find((candidate) => normalizeCsvHeader(candidate) === alias);
    if (key && String(row[key] ?? '').trim()) return String(row[key]).trim();
  }
  return null;
}

/** Convert a Professional Dashboard CSV export into scorecard rows. */
export function parseInstagramInsightsCsv(text) {
  const records = parseCsvRecords(text, detectCsvDelimiter(text));
  if (records.length < 2) return [];
  const headers = records[0];
  return records.slice(1).map((values) => {
    const source = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    const row = {};
    for (const [field, aliases] of Object.entries(CSV_FIELD_ALIASES)) {
      const value = csvField(source, aliases);
      if (value !== null) row[field] = value;
    }
    row.availableMetrics = Object.keys(row).filter((field) => (
      ['views', 'reach', 'shares', 'saves', 'comments', 'profileVisits', 'linkClicks'].includes(field)
    ));
    return row;
  });
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

function nestedInsightRows(row) {
  return [
    ...(Array.isArray(row.insights) ? row.insights : []),
    ...(isRecord(row.insights) && Array.isArray(row.insights.data) ? row.insights.data : []),
    ...(isRecord(row.metrics) && Array.isArray(row.metrics.data) ? row.metrics.data : []),
  ];
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
  for (const insight of nestedInsightRows(row)) {
    if (!isRecord(insight)) continue;
    const name = String(insight.name ?? '').trim();
    if (!aliases.includes(name)) continue;
    if (Array.isArray(insight.values)) return insight.values.at(-1)?.value;
    return insight.value;
  }
  return null;
}

function metricAvailability(row) {
  const declared = row?.availableMetrics ?? row?.metricsAvailable ?? row?.metricAvailability;
  if (Array.isArray(declared)) {
    return new Set(declared.map((value) => normalizeCsvHeader(value)));
  }
  if (isRecord(declared)) {
    return new Set(Object.entries(declared)
      .filter(([, value]) => value === true || value === 'available')
      .map(([key]) => normalizeCsvHeader(key)));
  }
  const nestedNames = new Set(nestedInsightRows(row)
    .filter(isRecord)
    .map((insight) => normalizeCsvHeader(insight.name))
    .filter(Boolean));
  if (nestedNames.size > 0) return nestedNames;
  return null;
}

function readMetric(row, name) {
  const value = finiteNumber(directMetric(row, METRIC_ALIASES[name] || [name]));
  const availability = metricAvailability(row);
  if (value === null) return null;
  if (availability) {
    const aliases = (METRIC_ALIASES[name] || [name]).map(normalizeCsvHeader);
    if (!aliases.some((alias) => availability.has(alias))) return null;
  } else if (value === 0 && !['reach', 'views'].includes(name)) {
    // Older snapshots filled absent interaction metrics with zero and did not
    // record which fields the source actually returned. Treat those legacy
    // zeros as unknown; explicit zeroes remain usable when availability is
    // declared by the collector or the dashboard export.
    return null;
  }
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
    const metadata = {
      creativeId,
      kind: firstString(entry.kind, entry.contentKind, entry.content_kind),
      queueId: firstString(entry.queueId, entry.queue_id),
      creativeBaseId: firstString(entry.creativeBaseId, entry.creative_base_id),
      creativeVariant: firstString(entry.creativeVariant, entry.creative_variant),
      creativeLabel: firstString(entry.creativeLabel, entry.creative_label),
      backgroundExperimentId: firstString(entry.backgroundExperimentId, entry.background_experiment_id),
      backgroundVariant: firstString(entry.backgroundVariant, entry.background_variant),
      backgroundLabel: firstString(entry.backgroundLabel, entry.background_label),
      safeAreaVersion: firstString(entry.safeAreaVersion, entry.safe_area_version),
      engagementMechanic: firstString(entry.engagementMechanic, entry.engagement_mechanic),
      hookType: firstString(entry.hookType, entry.hook_type),
      attentionMechanic: firstString(entry.attentionMechanic, entry.attention_mechanic),
      engagementLoop: firstString(entry.engagementLoop, entry.engagement_loop),
      followUpFormat: firstString(entry.followUpFormat, entry.follow_up_format),
      copyMode: firstString(entry.copyMode, entry.copy_mode),
      copySlot: firstString(entry.copySlot, entry.copy_slot),
      copyAssignmentMode: firstString(entry.copyAssignmentMode, entry.copy_assignment_mode),
      copyExperimentId: firstString(entry.copyExperimentId, entry.copy_experiment_id),
      copyPromptVersion: firstString(entry.copyPromptVersion, entry.copy_prompt_version),
      copyPackId: firstString(entry.copyPackId, entry.copy_pack_id),
      copyTemplateId: firstString(entry.copyTemplateId, entry.copy_template_id),
      copyObjective: firstString(entry.copyObjective, entry.copy_objective),
      copyAngleId: firstString(entry.copyAngleId, entry.copy_angle_id),
      copyPillarId: firstString(entry.copyPillarId, entry.copy_pillar_id),
      copyAngleIntent: firstString(entry.copyAngleIntent, entry.copy_angle_intent),
      copyHook: firstString(entry.copyHook, entry.copy_hook),
      copyCta: firstString(entry.copyCta, entry.copy_cta),
    };
    for (const key of ['instagramMediaId', 'mediaId', 'media_id', 'queueId', 'queue_id']) {
      const value = firstString(entry[key]);
      if (value) lookup.set(value, metadata);
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
export function normalizeInsightRows(input, {
  ledger = null,
  windowHours = DEFAULT_WINDOW_HOURS,
  windowToleranceHours = DEFAULT_WINDOW_TOLERANCE_HOURS,
} = {}) {
  const source = extractRows(input);
  const lookup = buildLedgerLookup(ledger);
  const rows = [];
  const rejected = [];

  source.forEach((raw, index) => {
    if (!isRecord(raw)) {
      reject(rejected, index, 'row is not an object');
      return;
    }

    const copyAttributionStatus = firstString(raw.copyAttributionStatus, raw.copy_attribution_status);
    if (copyAttributionStatus && copyAttributionStatus !== 'exact') {
      reject(rejected, index, 'copy attribution is not an exact media-to-ledger join');
      return;
    }
    if (firstString(raw.matchMethod, raw.match_method) === 'confirmation-timestamp') {
      reject(rejected, index, 'timestamp-matched media cannot attribute creative performance');
      return;
    }

    const postId = firstString(raw.id, raw.media_id, raw.mediaId, raw.post_id, raw.queueId, raw.queue_id)
      || `row-${index + 1}`;
    const ledgerMetadata = lookup.get(postId);
    const creativeId = firstString(
      raw.creativeId,
      raw.creative_id,
      raw.creative?.id,
      ledgerMetadata?.creativeId,
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

    const engagementMechanic = firstString(
      raw.engagementMechanic,
      raw.engagement_mechanic,
      raw.creative?.engagementMechanic,
      ledgerMetadata?.engagementMechanic,
    );
    const creativeBaseId = firstString(
      raw.creativeBaseId,
      raw.creative_base_id,
      raw.creative?.baseId,
      ledgerMetadata?.creativeBaseId,
    );
    const creativeVariant = firstString(
      raw.creativeVariant,
      raw.creative_variant,
      raw.creative?.variant,
      ledgerMetadata?.creativeVariant,
    );
    const creativeLabel = firstString(
      raw.creativeLabel,
      raw.creative_label,
      raw.creative?.label,
      ledgerMetadata?.creativeLabel,
    );
    const backgroundExperimentId = firstString(
      raw.backgroundExperimentId,
      raw.background_experiment_id,
      raw.visualExperimentId,
      raw.visual_experiment_id,
      ledgerMetadata?.backgroundExperimentId,
    );
    const backgroundVariant = firstString(
      raw.backgroundVariant,
      raw.background_variant,
      raw.visualVariant,
      raw.visual_variant,
      raw.background,
      raw.creative?.backgroundVariant,
      ledgerMetadata?.backgroundVariant,
    );
    const backgroundLabel = firstString(
      raw.backgroundLabel,
      raw.background_label,
      raw.visualLabel,
      raw.visual_label,
      ledgerMetadata?.backgroundLabel,
    );
    const safeAreaVersion = firstString(
      raw.safeAreaVersion,
      raw.safe_area_version,
      raw.layoutVersion,
      raw.layout_version,
      ledgerMetadata?.safeAreaVersion,
    );
    const hookType = firstString(
      raw.hookType,
      raw.hook_type,
      raw.creative?.hookType,
      ledgerMetadata?.hookType,
    );
    const attentionMechanic = firstString(
      raw.attentionMechanic,
      raw.attention_mechanic,
      raw.creative?.attentionMechanic,
      ledgerMetadata?.attentionMechanic,
    );
    const engagementLoop = firstString(
      raw.engagementLoop,
      raw.engagement_loop,
      raw.creative?.engagementLoop,
      ledgerMetadata?.engagementLoop,
    );
    const followUpFormat = firstString(
      raw.followUpFormat,
      raw.follow_up_format,
      raw.creative?.followUpFormat,
      ledgerMetadata?.followUpFormat,
    );
    const copyMode = firstString(raw.copyMode, raw.copy_mode, ledgerMetadata?.copyMode);
    const copySlot = firstString(raw.copySlot, raw.copy_slot, ledgerMetadata?.copySlot);
    const copyAssignmentMode = firstString(raw.copyAssignmentMode, raw.copy_assignment_mode, ledgerMetadata?.copyAssignmentMode);
    const copyExperimentId = firstString(raw.copyExperimentId, raw.copy_experiment_id, ledgerMetadata?.copyExperimentId);
    const copyPromptVersion = firstString(raw.copyPromptVersion, raw.copy_prompt_version, ledgerMetadata?.copyPromptVersion);
    const copyPackId = firstString(raw.copyPackId, raw.copy_pack_id, ledgerMetadata?.copyPackId);
    const copyTemplateId = firstString(raw.copyTemplateId, raw.copy_template_id, ledgerMetadata?.copyTemplateId);
    const copyObjective = firstString(raw.copyObjective, raw.copy_objective, ledgerMetadata?.copyObjective);
    const copyAngleId = firstString(raw.copyAngleId, raw.copy_angle_id, ledgerMetadata?.copyAngleId);
    const copyPillarId = firstString(raw.copyPillarId, raw.copy_pillar_id, ledgerMetadata?.copyPillarId);
    const copyAngleIntent = firstString(raw.copyAngleIntent, raw.copy_angle_intent, ledgerMetadata?.copyAngleIntent);
    const copyHook = firstString(raw.copyHook, raw.copy_hook, ledgerMetadata?.copyHook);
    const copyCta = firstString(raw.copyCta, raw.copy_cta, ledgerMetadata?.copyCta);
    if ((copyAngleId || copyPillarId || copyAngleIntent)
      && (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(copyAngleId)
        || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(copyPillarId)
        || !['searchable', 'shareable', 'both'].includes(copyAngleIntent))) {
      reject(rejected, index, 'invalid copy editorial angle metadata');
      return;
    }
    if (copyMode === 'codex' && copyObjective && copyObjective !== objective) {
      reject(rejected, index, 'copy objective conflicts with creative objective');
      return;
    }

    const views = readMetric(raw, 'views');
    const declaredAudienceMetric = firstString(
      raw.audienceMetric,
      raw.audience_metric,
      raw.reachSource,
      raw.reach_source,
    );
    const explicitReach = declaredAudienceMetric === 'views' ? null : readMetric(raw, 'reach');
    const audienceBase = explicitReach ?? views;
    const audienceMetric = explicitReach === null ? 'views' : 'reach';
    if (audienceBase === null || audienceBase <= 0) {
      reject(rejected, index, 'reach or views must be a positive number');
      return;
    }

    const metrics = {
      views,
      reach: explicitReach,
      shares: readMetric(raw, 'shares'),
      saves: readMetric(raw, 'saves'),
      comments: readMetric(raw, 'comments'),
      profileVisits: readMetric(raw, 'profileVisits'),
      linkClicks: readMetric(raw, 'linkClicks'),
    };
    if (Object.values(metrics).some((value) => value !== null && value < 0)) {
      reject(rejected, index, 'engagement metrics cannot be negative');
      return;
    }

    if (metrics[primaryMetric] === null) {
      reject(rejected, index, `primary metric ${primaryMetric} is unavailable`);
      return;
    }

    const rawWindow = firstString(raw.windowHours, raw.window_hours, raw.measurementWindowHours);
    const targetWindowHours = rawWindow === null ? windowHours : finiteNumber(rawWindow);
    if (targetWindowHours === null || targetWindowHours <= 0) {
      reject(rejected, index, 'windowHours must be a positive number');
      return;
    }
    const snapshotAgeHours = finiteNumber(raw.snapshotAgeHours ?? raw.snapshot_age_hours);
    const tolerance = Math.max(0, finiteNumber(windowToleranceHours) ?? DEFAULT_WINDOW_TOLERANCE_HOURS);
    if (snapshotAgeHours !== null && Math.abs(snapshotAgeHours - targetWindowHours) > tolerance) {
      reject(rejected, index, 'snapshot age is outside the declared measurement window');
      return;
    }

    rows.push({
      postId,
      creativeId,
      creativeBaseId,
      creativeVariant,
      creativeLabel,
      backgroundExperimentId,
      backgroundVariant,
      backgroundLabel,
      safeAreaVersion,
      kind: firstString(raw.kind, raw.contentKind, raw.content_kind, ledgerMetadata?.kind) || 'unknown',
      objective,
      primaryMetric,
      engagementMechanic,
      hookType,
      attentionMechanic,
      engagementLoop,
      followUpFormat,
      copyMode,
      copyAttributionStatus,
      copySlot,
      copyAssignmentMode,
      copyExperimentId,
      copyPromptVersion,
      copyPackId,
      copyTemplateId,
      copyObjective,
      copyAngleId,
      copyPillarId,
      copyAngleIntent,
      copyHook,
      copyCta,
      windowHours: targetWindowHours,
      snapshotAt: firstString(raw.snapshotAt, raw.snapshot_at),
      snapshotAgeHours,
      audienceBase,
      audienceMetric,
      reachSource: audienceMetric,
      availableMetrics: Array.from(metricAvailability(raw) || []),
      ...metrics,
    });
  });

  return { rows, rejected };
}

function rate(value, audienceBase) {
  return value !== null && value !== undefined && audienceBase > 0 ? value / audienceBase : null;
}

function treatmentId(treatment) {
  const background = firstString(treatment.backgroundVariant);
  return background ? `${treatment.creativeId}--bg-${background}` : treatment.creativeId;
}

/**
 * Aggregate comparable rows by creative, objective, background, content kind
 * and measurement window. The common interaction rate is only an
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
    const backgroundVariant = firstString(row.backgroundVariant) || 'legacy';
    const audienceMetric = firstString(row.audienceMetric, row.reachSource) || 'reach';
    const audienceBase = finiteNumber(row.audienceBase) ?? finiteNumber(row.reach);
    if (audienceBase === null || audienceBase <= 0) continue;
    const key = `${row.creativeId}\u0000${row.objective}\u0000${backgroundVariant}\u0000${kind}\u0000${row.windowHours}\u0000${audienceMetric}`;
    const group = groups.get(key) || {
      creativeId: row.creativeId,
      backgroundExperimentId: row.backgroundExperimentId || null,
      backgroundVariant,
      backgroundLabel: row.backgroundLabel || null,
      safeAreaVersion: row.safeAreaVersion || null,
      creativeBaseId: row.creativeBaseId || null,
      creativeVariant: row.creativeVariant || null,
      creativeLabel: row.creativeLabel || null,
      objective: row.objective,
      primaryMetric: row.primaryMetric,
      engagementMechanic: row.engagementMechanic || null,
      hookType: row.hookType || null,
      attentionMechanic: row.attentionMechanic || null,
      engagementLoop: row.engagementLoop || null,
      followUpFormat: row.followUpFormat || null,
      kind,
      windowHours: row.windowHours,
      audienceMetric,
      observations: 0,
      kinds: new Set(),
      copyVariants: new Map(),
      reachSource: null,
      audienceBase: 0,
      metricObservations: Object.fromEntries(['views', 'reach', 'shares', 'saves', 'comments', 'profileVisits', 'linkClicks'].map((name) => [name, 0])),
      interactionsComplete: true,
      views: 0,
      reach: 0,
      shares: 0,
      saves: 0,
      comments: 0,
      profileVisits: 0,
      linkClicks: 0,
    };
    group.observations += 1;
    group.kinds.add(kind);
    group.engagementMechanic ||= row.engagementMechanic || null;
    group.backgroundExperimentId ||= row.backgroundExperimentId || null;
    group.backgroundLabel ||= row.backgroundLabel || null;
    group.safeAreaVersion ||= row.safeAreaVersion || null;
    group.creativeBaseId ||= row.creativeBaseId || null;
    group.creativeVariant ||= row.creativeVariant || null;
    group.creativeLabel ||= row.creativeLabel || null;
    group.hookType ||= row.hookType || null;
    group.attentionMechanic ||= row.attentionMechanic || null;
    group.engagementLoop ||= row.engagementLoop || null;
    group.followUpFormat ||= row.followUpFormat || null;
    if (row.copyMode || row.copyTemplateId) {
      const copyKey = [
        row.copyMode || 'unknown',
        row.copyAssignmentMode || 'unknown',
        row.copyExperimentId || 'unknown',
        row.copyPackId || 'unknown',
        row.copyTemplateId || 'unknown',
        row.copyAngleId || 'unknown-angle',
        row.copyPillarId || 'unknown-pillar',
        row.copyObjective || 'unknown',
      ].join('|');
      const copyGroup = group.copyVariants.get(copyKey) || {
        copyMode: row.copyMode || null,
        copyAssignmentMode: row.copyAssignmentMode || null,
        copyExperimentId: row.copyExperimentId || null,
        copyPromptVersion: row.copyPromptVersion || null,
        copyPackId: row.copyPackId || null,
        copyTemplateId: row.copyTemplateId || null,
        copyAngleId: row.copyAngleId || null,
        copyPillarId: row.copyPillarId || null,
        copyAngleIntent: row.copyAngleIntent || null,
        copyObjective: row.copyObjective || null,
        copyHook: row.copyHook || null,
        copyCta: row.copyCta || null,
        observations: 0,
        audienceBase: 0,
        primaryTotal: 0,
        interactions: 0,
        interactionsComplete: true,
      };
      copyGroup.observations += 1;
      copyGroup.audienceBase += audienceBase;
      copyGroup.primaryTotal += Number(row[row.primaryMetric]) || 0;
      const interactionValues = [row.shares, row.saves, row.comments].map(finiteNumber);
      if (interactionValues.some((value) => value === null)) copyGroup.interactionsComplete = false;
      if (copyGroup.interactionsComplete) copyGroup.interactions += interactionValues.reduce((sum, value) => sum + value, 0);
      group.copyVariants.set(copyKey, copyGroup);
    }
    group.reachSource ||= row.reachSource || null;
    if (row.reachSource && group.reachSource !== row.reachSource) group.reachSource = 'mixed';
    group.audienceBase += audienceBase;
    for (const metric of ['views', 'reach', 'shares', 'saves', 'comments', 'profileVisits', 'linkClicks']) {
      const value = finiteNumber(row[metric]);
      if (value !== null) {
        group[metric] += value;
        group.metricObservations[metric] += 1;
      }
    }
    if ([row.shares, row.saves, row.comments].some((value) => finiteNumber(value) === null)) group.interactionsComplete = false;
    groups.set(key, group);
  }

  const treatments = Array.from(groups.values()).map((group) => {
    const interactions = group.interactionsComplete ? group.shares + group.saves + group.comments : null;
    const primaryTotal = group[group.primaryMetric] || 0;
    const eligible = group.observations >= minimumObservations;
    return {
      creativeId: group.creativeId,
      backgroundExperimentId: group.backgroundExperimentId,
      backgroundVariant: group.backgroundVariant === 'legacy' ? null : group.backgroundVariant,
      backgroundLabel: group.backgroundLabel,
      safeAreaVersion: group.safeAreaVersion,
      creativeBaseId: group.creativeBaseId,
      creativeVariant: group.creativeVariant,
      creativeLabel: group.creativeLabel,
      objective: group.objective,
      primaryMetric: group.primaryMetric,
      engagementMechanic: group.engagementMechanic,
      hookType: group.hookType,
      attentionMechanic: group.attentionMechanic,
      engagementLoop: group.engagementLoop,
      followUpFormat: group.followUpFormat,
      copyVariants: Array.from(group.copyVariants.values()).map((copyVariant) => ({
        ...copyVariant,
        interactions: copyVariant.interactionsComplete ? copyVariant.interactions : null,
        primaryRate: rate(copyVariant.primaryTotal, copyVariant.audienceBase),
        interactionRate: rate(copyVariant.interactionsComplete ? copyVariant.interactions : null, copyVariant.audienceBase),
      })),
      kind: group.kind,
      windowHours: group.windowHours,
      observations: group.observations,
      kinds: Array.from(group.kinds).sort(),
      views: group.metricObservations.views ? group.views : null,
      reach: group.metricObservations.reach ? group.reach : null,
      audienceBase: group.audienceBase,
      audienceMetric: group.audienceMetric,
      reachSource: group.reachSource || 'reach',
      shares: group.metricObservations.shares ? group.shares : null,
      saves: group.metricObservations.saves ? group.saves : null,
      comments: group.metricObservations.comments ? group.comments : null,
      profileVisits: group.metricObservations.profileVisits ? group.profileVisits : null,
      linkClicks: group.metricObservations.linkClicks ? group.linkClicks : null,
      primaryTotal,
      primaryRate: rate(primaryTotal, group.audienceBase),
      interactionTotal: interactions,
      interactionRate: rate(interactions, group.audienceBase),
      eligible,
      status: eligible ? 'eligible' : `needs-${minimumObservations - group.observations}-more`,
    };
  });

  const sortedTreatments = treatments.sort(
    (a, b) => a.creativeId.localeCompare(b.creativeId)
      || a.objective.localeCompare(b.objective)
      || (a.backgroundVariant || 'legacy').localeCompare(b.backgroundVariant || 'legacy')
      || a.kind.localeCompare(b.kind)
      || a.windowHours - b.windowHours,
  );
  const comparisonGroups = new Map();
  for (const treatment of sortedTreatments) {
    if (!treatment.eligible) continue;
    const key = `${treatment.objective}\u0000${treatment.kind}\u0000${treatment.windowHours}\u0000${treatment.audienceMetric}`;
    const group = comparisonGroups.get(key) || [];
    group.push(treatment);
    comparisonGroups.set(key, group);
  }

  const exploratoryRanking = [];
  const exploratoryWinners = [];
  for (const group of comparisonGroups.values()) {
    group.sort((a, b) => (b.primaryRate ?? -1) - (a.primaryRate ?? -1)
      || (b.interactionRate ?? -1) - (a.interactionRate ?? -1)
      || a.creativeId.localeCompare(b.creativeId));
    const winner = group[0];
    exploratoryWinners.push({
      treatmentId: treatmentId(winner),
      creativeId: winner.creativeId,
      backgroundVariant: winner.backgroundVariant,
      objective: winner.objective,
      kind: winner.kind,
      windowHours: winner.windowHours,
      interactionRate: winner.interactionRate,
      primaryRate: winner.primaryRate,
    });
    group.forEach((treatment, index) => {
      exploratoryRanking.push({
        treatmentId: treatmentId(treatment),
        creativeId: treatment.creativeId,
        backgroundVariant: treatment.backgroundVariant,
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
    exploratoryWinner: exploratoryWinners.length === 1 ? exploratoryWinners[0].treatmentId : null,
    methodology: {
      comparisonUnit: 'creativeId + objective + background variant + content kind + measurement window',
      primaryRate: 'primary metric / audience base (reach or views)',
      interactionRate: '(shares + saves + comments) / audience base (reach or views)',
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
    '   Copy splits are descriptive; they do not affect eligibility or choose winners.',
    '',
  ];
  if (report.treatments.length === 0) {
    lines.push('   No valid treatment rows yet.');
  } else {
    for (const treatment of report.treatments) {
      const background = treatment.backgroundVariant ? ` · bg ${treatment.backgroundVariant}` : '';
      const mechanic = treatment.engagementMechanic ? ` · CTA ${treatment.engagementMechanic}` : '';
      const hook = treatment.hookType ? ` · hook ${treatment.hookType}` : '';
      const loop = treatment.engagementLoop ? ` · loop ${treatment.engagementLoop}` : '';
      const copy = treatment.copyVariants?.length
        ? ' · copy ' + treatment.copyVariants
          .map((variant) => `${variant.copyTemplateId || 'unknown'} ${variant.observations} obs (${percentage(variant.primaryRate)})`)
          .join(', ')
        : '';
      lines.push(
        `   ${treatment.creativeId.padEnd(18)} ${treatment.kind.padEnd(8)} ${treatment.windowHours}h · ${treatment.observations} obs · `
        + `primary ${percentage(treatment.primaryRate)} · interactions ${percentage(treatment.interactionRate)} · ${treatment.status}${background}${mechanic}${hook}${loop}${copy}`,
      );
    }
  }
  lines.push('');
  if (!report.exploratoryWinners?.length) {
    lines.push('   No exploratory leader: collect more comparable observations.');
  } else if (report.exploratoryWinners.length === 1) {
    const winner = report.exploratoryWinners[0];
    const background = winner.backgroundVariant ? `, ${winner.backgroundVariant}` : '';
    lines.push(`   Exploratory leader (${winner.kind}, ${winner.windowHours}h${background}): ${winner.creativeId}`);
  } else {
    lines.push(`   Exploratory leaders: ${report.exploratoryWinners
      .map((winner) => `${winner.creativeId} (${winner.kind}, ${winner.windowHours}h${winner.backgroundVariant ? `, ${winner.backgroundVariant}` : ''})`)
      .join('; ')}`);
  }
  if (report.rejectedRows.length) {
    lines.push(`   Rejected rows: ${report.rejectedRows.map((row) => `${row.row} (${row.reason})`).join(', ')}`);
  }
  return lines.join('\n');
}
