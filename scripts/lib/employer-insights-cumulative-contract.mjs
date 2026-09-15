import crypto from 'node:crypto';

export const D18_SCHEMA_VERSION = 1;
export const D18_METRIC_VERSION = 'D18-v1';
export const D18_TIMEZONE = 'Europe/Zurich';
export const D18_J0 = '2026-09-09T00:00:00+02:00';
export const D18_LIMIT_STATE = 'parziale, mai complete';
export const D18_POSTHOG_CAVEAT = 'Il denominatore storico PostHog non è provato: OFFSET è stato rifiutato con HTTP 400 e la paginazione keyset è incompleta. I valori PostHog sono backup osservati/parziali, non una popolazione completa; non esiste un fattore di espansione autorizzato e non vanno proiettati né sommati a GA4.';

export const D18_METRICS = Object.freeze([
  'adViews',
  'listExposures',
  'profileVisits',
  'outboundClicks',
  'candidateButtonClicks',
  'identifiableUniqueVisitors',
]);

export const D18_STATUSES = Object.freeze([
  'observed',
  'zero osservato',
  'parziale',
  'non disponibile',
  'sorgente non disponibile',
  'non sommabile fra regimi',
]);

const D18_SOURCES = new Set(['ga4', 'posthog', 'firestore:applications', 'provider:delivery', 'composite']);
const D18_DENOMINATOR_STATUSES = new Set(['provato', 'non provato', 'non disponibile']);
const DAY_MS = 86_400_000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = finiteNumber(value);
  return number == null ? null : Math.max(0, Math.trunc(number));
}

function parseTimestamp(value, label) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

function clone(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clone(nested)]));
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function normalizeD18Window(input, { kind = undefined } = {}) {
  if (!isObject(input)) throw new Error('D18 window is required');
  const from = String(input.from || '');
  const to = String(input.to || '');
  parseTimestamp(from, 'D18 window.from');
  parseTimestamp(to, 'D18 window.to');
  if (Date.parse(from) >= Date.parse(to)) throw new Error('D18 window.from must precede window.to');
  if (input.timezone !== D18_TIMEZONE) throw new Error(`D18 window.timezone must be ${D18_TIMEZONE}`);
  if (input.inclusive !== undefined && input.inclusive !== '[from,to)') throw new Error('D18 window must be half-open');
  const window = { from, to, timezone: D18_TIMEZONE, inclusive: '[from,to)' };
  const effectiveKind = kind ?? input.kind;
  if (effectiveKind) window.kind = String(effectiveKind);
  if (input.days !== undefined) window.days = Number(input.days);
  return window;
}

export function isWithinD18Window(value, window) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const time = Date.parse(value);
  return time >= Date.parse(window.from) && time < Date.parse(window.to);
}

function localParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: D18_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function localDayKey(value) {
  const parts = localParts(parseTimestamp(String(value), 'timestamp'));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addUtcDays(day, count) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function listD18Days(window) {
  const normalized = normalizeD18Window(window);
  const first = localDayKey(normalized.from);
  const last = localDayKey(new Date(Date.parse(normalized.to) - 1).toISOString());
  const days = [];
  for (let day = first; day <= last; day = addUtcDays(day, 1)) days.push(day);
  return days;
}

export function deriveD18Windows(requestedWindow) {
  const normalized = normalizeD18Window(requestedWindow, { kind: 'cumulative' });
  const cutoff = Date.parse(normalized.to);
  const lowerBound = Date.parse(normalized.from);
  const byDays = (days) => normalizeD18Window({
    from: new Date(Math.max(lowerBound, cutoff - days * DAY_MS)).toISOString(),
    to: normalized.to,
    timezone: D18_TIMEZONE,
  }, { kind: `${days}d` });
  return {
    cumulative: normalized,
    '30d': byDays(30),
    '90d': byDays(90),
    trend: normalizeD18Window(requestedWindow, { kind: 'trend' }),
  };
}

function normalizeDenominator(denominator, window, fallbackSource, fallbackUnit) {
  const source = denominator?.source || fallbackSource || 'unknown';
  const status = D18_DENOMINATOR_STATUSES.has(denominator?.status)
    ? denominator.status
    : 'non disponibile';
  const value = finiteNumber(denominator?.value);
  return {
    value: status === 'non provato' || status === 'non disponibile' ? null : value,
    unit: denominator?.unit || fallbackUnit || 'events',
    source,
    window: normalizeD18Window(denominator?.window || window),
    status,
    reason: denominator?.reason ?? null,
  };
}

function normalizeCoverage(coverage, window, snapshotId = null) {
  const raw = isObject(coverage) ? coverage : {};
  return {
    snapshotId: raw.snapshotId ?? snapshotId,
    coverageStart: raw.coverageStart ?? null,
    coverageEnd: raw.coverageEnd ?? null,
    completeThrough: raw.completeThrough ?? null,
    gaps: Array.isArray(raw.gaps) ? clone(raw.gaps) : [],
    truncated: raw.truncated === true ? true : raw.truncated === false ? false : null,
    rowsReturned: positiveIntegerOrNull(raw.rowsReturned ?? raw.returnedRows),
    totalRows: positiveIntegerOrNull(raw.totalRows ?? raw.groupRowsBeforeCut),
    pages: positiveIntegerOrNull(raw.pages),
    pageSize: positiveIntegerOrNull(raw.pageSize),
    queried: raw.queried !== false,
    status: raw.status ?? (raw.truncated ? 'parziale' : 'observed'),
    unavailableReason: raw.unavailableReason ?? null,
    dataLossFromOtherRow: raw.dataLossFromOtherRow === true,
  };
}

function defaultIdentity() {
  return { method: 'not available', key: null, precision: 'non disponibile' };
}

function defaultDedupe() {
  return { method: 'emission_id', removed: 0, unit: 'events', status: 'dedup non disponibile' };
}

export function metricValue({
  value = null,
  unit,
  source,
  window,
  status,
  denominator,
  coverage,
  identity,
  dedupe,
  parts = undefined,
} = {}) {
  if (!unit) throw new Error('MetricValue.unit is required');
  if (!D18_SOURCES.has(source)) throw new Error(`MetricValue.source is invalid: ${source}`);
  const normalizedWindow = normalizeD18Window(window);
  const requestedStatus = D18_STATUSES.includes(status) ? status : 'non disponibile';
  const normalizedDenominator = normalizeDenominator(denominator, normalizedWindow, source, unit);
  const normalizedStatus = requestedStatus === 'zero osservato' && normalizedDenominator.status !== 'provato'
    ? 'non disponibile'
    : requestedStatus;
  const numeric = finiteNumber(value);
  const unavailable = normalizedStatus === 'non disponibile' || normalizedStatus === 'sorgente non disponibile';
  const safeValue = unavailable || normalizedStatus === 'non sommabile fra regimi' || normalizedStatus === 'parziale' && numeric === 0
    ? null
    : numeric;
  if (normalizedStatus === 'zero osservato' && safeValue !== 0) {
    throw new Error('zero osservato requires value 0');
  }
  return {
    value: safeValue,
    unit,
    source,
    window: normalizedWindow,
    status: normalizedStatus,
    denominator: normalizedDenominator,
    coverage: normalizeCoverage(coverage, normalizedWindow, coverage?.snapshotId ?? null),
    identity: isObject(identity) ? {
      method: identity.method ?? 'not available',
      key: identity.key ?? null,
      precision: identity.precision ?? 'non disponibile',
    } : defaultIdentity(),
    dedupe: isObject(dedupe) ? {
      method: dedupe.method ?? 'emission_id',
      removed: positiveIntegerOrNull(dedupe.removed) ?? 0,
      unit: dedupe.unit ?? 'events',
      status: dedupe.status ?? 'dedup non disponibile',
    } : defaultDedupe(),
    ...(parts ? { parts: clone(parts) } : {}),
  };
}

export function metricFromObservation({
  unit,
  source,
  window,
  value = null,
  fieldPresent = value !== null && value !== undefined,
  querySucceeded = true,
  complete = true,
  truncated = false,
  denominator,
  coverage,
  identity,
  dedupe,
} = {}) {
  let status;
  if (!querySucceeded) status = 'sorgente non disponibile';
  else if (!fieldPresent) status = 'non disponibile';
  else if (truncated || complete === false) status = 'parziale';
  else if (finiteNumber(value) === 0) status = 'zero osservato';
  else status = 'observed';
  const normalizedDenominator = normalizeDenominator(
    denominator || {
      value: status === 'zero osservato' || status === 'observed' ? value : null,
      unit,
      source,
      status: status === 'parziale' ? 'non provato' : 'provato',
    },
    normalizeD18Window(window),
    source,
    unit,
  );
  if (status === 'zero osservato' && normalizedDenominator.status !== 'provato') status = 'non disponibile';
  return metricValue({
    value: status === 'sorgente non disponibile' || status === 'non disponibile' ? null : value,
    unit,
    source,
    window,
    status,
    denominator: normalizedDenominator,
    coverage: { ...coverage, truncated: truncated || complete === false },
    identity,
    dedupe,
  });
}

function normalizeCompositePart(part, source, unit, window) {
  const complete = isObject(part)
    && looksLikeMetric(part)
    && isObject(part.denominator)
    && isObject(part.coverage)
    && isObject(part.identity)
    && isObject(part.dedupe);
  if (complete) return clone(part);
  return metricValue({
    value: part?.value ?? null,
    unit: part?.unit || unit,
    source: D18_SOURCES.has(part?.source) ? part.source : source,
    window: part?.window || window,
    status: D18_STATUSES.includes(part?.status) ? part.status : 'non disponibile',
    denominator: part?.denominator,
    coverage: part?.coverage,
    identity: part?.identity,
    dedupe: part?.dedupe,
    parts: part?.parts,
  });
}

export function buildCompositeMetric({
  window,
  unit,
  historicalBackup,
  currentPrimary,
  identity,
  dedupe,
} = {}) {
  const normalizedWindow = normalizeD18Window(window);
  const historical = normalizeCompositePart(
    historicalBackup || { value: null, unit, source: 'posthog', window: normalizedWindow, status: 'non disponibile' },
    'posthog',
    unit,
    normalizedWindow,
  );
  const current = normalizeCompositePart(
    currentPrimary || { value: null, unit, source: 'ga4', window: normalizedWindow, status: 'non disponibile' },
    'ga4',
    unit,
    normalizedWindow,
  );
  return metricValue({
    value: null,
    unit: 'composite_two_regimes',
    source: 'composite',
    window: normalizedWindow,
    status: 'non sommabile fra regimi',
    denominator: { value: null, unit, source: 'composite', window: normalizedWindow, status: 'non disponibile' },
    coverage: {
      snapshotId: historical.coverage?.snapshotId || current.coverage?.snapshotId || null,
      coverageStart: historical.coverage?.coverageStart || current.coverage?.coverageStart || null,
      coverageEnd: current.coverage?.coverageEnd || historical.coverage?.coverageEnd || null,
      completeThrough: current.coverage?.completeThrough || historical.coverage?.completeThrough || null,
      gaps: [
        ...(Array.isArray(historical.coverage?.gaps) ? historical.coverage.gaps : []),
        ...(Array.isArray(current.coverage?.gaps) ? current.coverage.gaps : []),
      ],
      truncated: Boolean(historical.coverage?.truncated || current.coverage?.truncated),
      rowsReturned: null,
      totalRows: null,
      pages: null,
    },
    identity: identity || { method: 'two_regimes', key: null, precision: 'regime-specific' },
    dedupe: dedupe || { method: 'per_source_emission_id', removed: 0, unit: 'events', status: 'declared' },
    parts: { historicalBackup: clone(historical), currentPrimary: clone(current) },
  });
}

export function buildPosthogMetric({ window, observed = null, sample = null, budgetInsufficient = false, response = {} } = {}) {
  // The historical PostHog denominator is explicitly unproven by D18, even
  // when the provider returns all rows requested by a particular query.
  const denominatorStatus = 'non provato';
  const truncated = denominatorStatus === 'non provato'
    || budgetInsufficient
    || Number(response?.offsetStatus) === 400
    || response?.cursorAdvanced === false
    || (finiteNumber(response?.rowsReturned) != null && finiteNumber(response?.totalRows) != null && response.rowsReturned < response.totalRows);
  return metricFromObservation({
    unit: 'events',
    source: 'posthog',
    window,
    value: observed,
    fieldPresent: observed !== null && observed !== undefined,
    querySucceeded: response?.offsetStatus === 400 ? observed !== null && observed !== undefined : true,
    complete: !truncated,
    truncated,
    denominator: {
      value: null,
      unit: 'events',
      source: 'posthog',
      window,
      status: denominatorStatus,
      reason: D18_POSTHOG_CAVEAT,
    },
    coverage: {
      coverageStart: window.from,
      coverageEnd: window.to,
      completeThrough: truncated ? null : window.to,
      rowsReturned: response?.rowsReturned ?? null,
      totalRows: response?.totalRows ?? null,
      pages: response?.pages ?? null,
      truncated,
      status: truncated ? 'parziale' : 'observed',
      offsetStatus: response?.offsetStatus ?? null,
      sample: sample ?? null,
    },
  });
}

export function buildPosthogRegime({ window, observed = null, response = {}, sample = null, budgetInsufficient = false } = {}) {
  return buildPosthogMetric({ window, observed, response, sample, budgetInsufficient });
}

function sourceDayState(value) {
  if (value === true) return { queried: true, available: true, partial: false };
  if (value === false || value == null) return { queried: false, available: false, partial: false };
  if (typeof value === 'string') return { queried: true, available: value === 'available' || value === 'zero osservato' || value === 'observed', partial: value === 'parziale' };
  return {
    queried: value.queried !== false,
    available: value.available === true || value.status === 'observed' || value.status === 'zero osservato' || value.status === 'available',
    partial: value.partial === true || value.status === 'parziale',
  };
}

export function buildCoverageMatrix({ requestedWindow, daily = [] } = {}) {
  const window = normalizeD18Window(requestedWindow);
  const requestedDays = listD18Days(window);
  const byDay = new Map((daily || []).map((entry) => [String(entry.day), entry]));
  const both = [];
  const ga4Only = [];
  const posthogOnly = [];
  const neither = [];
  const partial = { ga4: [], posthog: [] };
  const unknown = [];
  for (const day of requestedDays) {
    const entry = byDay.get(day);
    if (!entry) {
      unknown.push(day);
      continue;
    }
    const ga4 = sourceDayState(entry.ga4);
    const posthog = sourceDayState(entry.posthog);
    if (!ga4.queried || !posthog.queried) unknown.push(day);
    else if (ga4.available && posthog.available) both.push(day);
    else if (ga4.available) ga4Only.push(day);
    else if (posthog.available) posthogOnly.push(day);
    else neither.push(day);
    if (ga4.partial) partial.ga4.push(day);
    if (posthog.partial) partial.posthog.push(day);
  }
  const hasUnknown = unknown.length > 0;
  return {
    granularity: 'day',
    requestedDays,
    both,
    ga4Only,
    posthogOnly,
    neither: hasUnknown ? null : neither,
    partial,
    unknownDays: hasUnknown ? unknown : [],
    status: hasUnknown || neither.length > 0
      ? 'non disponibile'
      : (partial.ga4.length || partial.posthog.length ? 'parziale' : 'observed'),
  };
}

function normalizeSourceCoverage(meta, window, snapshotId) {
  const raw = meta?.sourceCoverage || meta?.coverage || meta || {};
  return normalizeCoverage({
    ...raw,
    snapshotId: raw.snapshotId ?? snapshotId,
    queried: raw.queried !== false,
  }, window, snapshotId);
}

function normalizeIdentityCoverage(meta, window, snapshotId) {
  const raw = meta?.identityCoverage || {};
  const hasEvidence = isObject(raw) && Object.keys(raw).length > 0;
  return {
    ...normalizeCoverage({
      ...raw,
      coverageStart: raw.eligibleFrom ?? raw.coverageStart ?? null,
      snapshotId: raw.snapshotId ?? snapshotId,
      status: raw.status ?? 'non disponibile',
      queried: hasEvidence && raw.queried !== false,
    }, window, snapshotId),
    eligibleFrom: raw.eligibleFrom ?? raw.coverageStart ?? null,
    firstCompleteIdentityAt: raw.firstCompleteIdentityAt ?? null,
  };
}

function hasSourceCoverageEvidence(meta) {
  const coverage = meta?.sourceCoverage || meta?.coverage || meta;
  return isObject(coverage) && [
    'queried',
    'status',
    'coverageStart',
    'coverageEnd',
    'completeThrough',
  ].some((field) => Object.prototype.hasOwnProperty.call(coverage, field));
}

export function buildD18SourceRegimes({
  requestedWindow,
  snapshotId,
  ga4 = {},
  posthog = {},
  applications = {},
  delivery = {},
} = {}) {
  const window = normalizeD18Window(requestedWindow);
  const sourceCoverage = (meta, source) => ({
    source,
    ...normalizeSourceCoverage(meta, window, snapshotId),
    ...(!hasSourceCoverageEvidence(meta) ? { queried: false, status: 'sorgente non disponibile' } : {}),
  });
  const denominator = (meta, source, fallbackStatus = 'non disponibile') => {
    const coverage = meta?.sourceCoverage || meta?.coverage || meta || {};
    const unavailable = !hasSourceCoverageEvidence(meta)
      || meta?.available === false
      || meta?.queried === false
      || coverage.available === false
      || coverage.queried === false
      || meta?.status === 'sorgente non disponibile'
      || coverage.status === 'sorgente non disponibile';
    const supplied = meta?.denominator || {
      value: null,
      unit: 'events',
      source,
      status: fallbackStatus,
      ...(source === 'posthog' ? { reason: D18_POSTHOG_CAVEAT } : {}),
    };
    return normalizeDenominator(
      source === 'posthog'
        ? { ...supplied, value: null, status: 'non provato', source: 'posthog', reason: supplied.reason || D18_POSTHOG_CAVEAT }
        : unavailable ? { ...supplied, value: null, status: 'non disponibile', source } : supplied,
      window,
      source,
      'events',
    );
  };
  const ga4Coverage = sourceCoverage(ga4, 'ga4');
  const posthogCoverage = sourceCoverage(posthog, 'posthog');
  const applicationsCoverage = sourceCoverage(applications, 'firestore:applications');
  const deliveryCoverage = sourceCoverage(delivery, 'provider:delivery');
  const applicationRetentionDays = finiteNumber(applications?.retentionDays);
  const sourceStatus = (meta, coverage, fallback) => meta?.status || coverage.status || fallback;
  const posthogUnavailable = posthogCoverage.queried === false
    || posthogCoverage.status === 'sorgente non disponibile'
    || posthog?.status === 'sorgente non disponibile';
  return {
    ga4: {
      source: 'ga4',
      ...ga4Coverage,
      sourceCoverage: ga4Coverage,
      identityCoverage: normalizeIdentityCoverage(ga4, window, snapshotId),
      denominator: denominator(ga4, 'ga4'),
      status: sourceStatus(ga4, ga4Coverage, 'observed'),
    },
    posthog: {
      source: 'posthog',
      ...posthogCoverage,
      sourceCoverage: posthogCoverage,
      identityCoverage: normalizeIdentityCoverage(posthog, window, snapshotId),
      denominator: denominator(posthog, 'posthog', 'non provato'),
      status: posthogUnavailable ? 'sorgente non disponibile' : 'parziale',
      caveat: D18_POSTHOG_CAVEAT,
    },
    applications: {
      source: 'firestore:applications',
      ...applicationsCoverage,
      sourceCoverage: { ...applicationsCoverage, retentionDays: applicationRetentionDays },
      retentionDays: applicationRetentionDays,
      status: sourceStatus(applications, applicationsCoverage, 'sorgente non disponibile'),
    },
    delivery: {
      source: 'provider:delivery',
      ...deliveryCoverage,
      sourceCoverage: deliveryCoverage,
      status: sourceStatus(delivery, deliveryCoverage, 'sorgente non disponibile'),
    },
  };
}

function looksLikeMetric(value) {
  return isObject(value)
    && Object.prototype.hasOwnProperty.call(value, 'value')
    && Object.prototype.hasOwnProperty.call(value, 'unit')
    && Object.prototype.hasOwnProperty.call(value, 'source')
    && Object.prototype.hasOwnProperty.call(value, 'window')
    && Object.prototype.hasOwnProperty.call(value, 'status');
}

function validateMetric(value, path, errors) {
  if (!looksLikeMetric(value)) {
    errors.push(`${path} must be a MetricValue with value/unit/source/window/status`);
    return;
  }
  if (!D18_SOURCES.has(value.source)) errors.push(`${path}.source is invalid`);
  if (!D18_STATUSES.includes(value.status)) errors.push(`${path}.status is invalid`);
  if (!value.window || value.window.inclusive !== '[from,to)') errors.push(`${path}.window must be half-open`);
  if (value.value !== null && finiteNumber(value.value) === null) errors.push(`${path}.value must be a number or null`);
  if (!isObject(value.denominator) || !D18_DENOMINATOR_STATUSES.has(value.denominator.status)) errors.push(`${path}.denominator is required`);
  if (!isObject(value.coverage)) errors.push(`${path}.coverage is required`);
  else {
    for (const field of ['coverageStart', 'coverageEnd', 'completeThrough', 'truncated', 'rowsReturned', 'totalRows', 'pages']) {
      if (!Object.prototype.hasOwnProperty.call(value.coverage, field)) errors.push(`${path}.coverage.${field} is required`);
    }
  }
  if (!isObject(value.identity)) errors.push(`${path}.identity is required`);
  if (!isObject(value.dedupe)) errors.push(`${path}.dedupe is required`);
  if ((value.status === 'non disponibile' || value.status === 'sorgente non disponibile' || value.status === 'non sommabile fra regimi') && value.value !== null) {
    errors.push(`${path}.value must be null for ${value.status}`);
  }
  if (value.status === 'zero osservato' && value.value !== 0) errors.push(`${path}.zero osservato must have value 0`);
  if (value.status === 'zero osservato' && value.denominator?.status !== 'provato') errors.push(`${path}.zero osservato requires a provato denominator`);
  if (value.source === 'composite' && value.status === 'non sommabile fra regimi') {
    if (!isObject(value.parts)) errors.push(`${path}.parts is required for a composite metric`);
    else {
      if (!isObject(value.parts.historicalBackup)) errors.push(`${path}.parts.historicalBackup is required`);
      if (!isObject(value.parts.currentPrimary)) errors.push(`${path}.parts.currentPrimary is required`);
    }
  }
  if (value.parts) {
    validateMetric(value.parts.historicalBackup, `${path}.parts.historicalBackup`, errors);
    validateMetric(value.parts.currentPrimary, `${path}.parts.currentPrimary`, errors);
  }
}

function walkD18(value, path, errors, key = '') {
  const metricKeys = new Set([...D18_METRICS, 'submitted', 'forwarded', 'delivered', 'failed']);
  if (metricKeys.has(key) && typeof value === 'number') {
    errors.push(`${path} is a naked counter; use MetricValue`);
    return;
  }
  if (looksLikeMetric(value) || isObject(value) && Object.prototype.hasOwnProperty.call(value, 'value') && (
    Object.prototype.hasOwnProperty.call(value, 'source')
    || Object.prototype.hasOwnProperty.call(value, 'status')
    || Object.prototype.hasOwnProperty.call(value, 'denominator')
    || Object.prototype.hasOwnProperty.call(value, 'coverage')
  )) {
    validateMetric(value, path, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkD18(entry, `${path}[${index}]`, errors));
    return;
  }
  if (isObject(value)) {
    for (const [childKey, child] of Object.entries(value)) walkD18(child, `${path}.${childKey}`, errors, childKey);
  }
}

function validateReconciliationLedger(ledger, path, surfaces, errors) {
  if (!isObject(ledger)) {
    errors.push(`${path} is required`);
    return;
  }
  for (const field of ['rawObserved', 'observed', 'attributed', 'residualTotal', 'technicalDuplicatesRemoved']) {
    validateMetric(ledger[field], `${path}.${field}`, errors);
  }
  const raw = ledger.rawObserved?.value;
  const attributed = ledger.attributed?.value;
  const residualTotal = ledger.residualTotal?.value;
  const technicalDuplicatesRemoved = ledger.technicalDuplicatesRemoved?.value;
  if ([raw, attributed, residualTotal, technicalDuplicatesRemoved].every((value) => typeof value === 'number')
    && raw !== attributed + residualTotal + technicalDuplicatesRemoved) {
    errors.push(`${path}.rawInvariant arithmetic mismatch`);
  }
  if (typeof ledger.invariant !== 'boolean' || ledger.invariant !== true) errors.push(`${path}.invariant must be true`);
  if (typeof ledger.rawInvariant !== 'boolean' || ledger.rawInvariant !== true) errors.push(`${path}.rawInvariant must be true`);
  if (!surfaces.length) return;
  if (!isObject(ledger.bySurface)) {
    errors.push(`${path}.bySurface is required`);
    return;
  }
  for (const surface of surfaces) {
    const surfaceLedger = ledger.bySurface[surface];
    validateReconciliationLedger(surfaceLedger, `${path}.bySurface.${surface}`, [], errors);
    const expectedUnit = surface === 'identifiableUniqueVisitors'
      ? 'identifiers'
      : surfaces.includes('submitted') ? 'records' : 'events';
    for (const field of ['rawObserved', 'observed', 'attributed', 'residualTotal', 'technicalDuplicatesRemoved']) {
      if (surfaceLedger?.[field]?.unit !== expectedUnit) errors.push(`${path}.bySurface.${surface}.${field}.unit must be ${expectedUnit}`);
    }
  }
}

export function validateD18Payload(payload) {
  const errors = [];
  if (!isObject(payload)) return { ok: false, errors: ['payload must be an object'] };
  if (payload.schemaVersion !== D18_SCHEMA_VERSION) errors.push('schemaVersion is missing or invalid');
  if (payload.metricVersion !== D18_METRIC_VERSION) errors.push('metricVersion is missing or invalid');
  if (typeof payload.snapshotId !== 'string' || !payload.snapshotId) errors.push('snapshotId is required');
  if (typeof payload.generatedAt !== 'string' || !Number.isFinite(Date.parse(payload.generatedAt))) errors.push('generatedAt is required');
  try { normalizeD18Window(payload.requestedWindow); } catch (error) { errors.push(error.message); }
  if (payload.cutoff !== payload.requestedWindow?.to) errors.push('cutoff must equal requestedWindow.to');
  if (!isObject(payload.sourceRegimes?.ga4) || !isObject(payload.sourceRegimes?.posthog)) errors.push('sourceRegimes.ga4/posthog are required');
  for (const source of ['ga4', 'posthog', 'applications', 'delivery']) {
    const coverage = payload.sourceRegimes?.[source]?.sourceCoverage;
    if (!isObject(coverage) || !Object.prototype.hasOwnProperty.call(coverage, 'coverageEnd')) {
      errors.push(`sourceRegimes.${source}.sourceCoverage.coverageEnd is required`);
    }
  }
  if (!isObject(payload.coverageMatrix)) errors.push('coverageMatrix is required');
  if (!isObject(payload.periodTotal?.metrics)) errors.push('periodTotal.metrics is required');
  for (const metric of D18_METRICS) {
    validateMetric(payload.periodTotal?.metrics?.[metric], `periodTotal.metrics.${metric}`, errors);
  }
  validateMetric(payload.periodTotal, 'periodTotal', errors);
  if (!Array.isArray(payload.companies)) errors.push('companies must be an array');
  walkD18(payload.companies, 'companies', errors);
  walkD18(payload.globalResiduals, 'globalResiduals', errors);
  validateReconciliationLedger(payload.reconciliation?.ga4, 'reconciliation.ga4', D18_METRICS, errors);
  validateReconciliationLedger(payload.reconciliation?.posthog, 'reconciliation.posthog', D18_METRICS, errors);
  validateReconciliationLedger(payload.reconciliation?.applications, 'reconciliation.applications', ['submitted', 'forwarded', 'delivered', 'failed'], errors);
  if (!isObject(payload.provenance) || payload.provenance.limitState !== D18_LIMIT_STATE) errors.push('provenance.limitState must be parziale, mai complete');
  const provenance = payload.provenance;
  for (const field of ['queryHash', 'catalogSha', 'buildSha']) {
    if (typeof provenance?.[field] !== 'string' || !provenance[field]) errors.push(`provenance.${field} is required`);
  }
  if (!isObject(provenance?.sourceSnapshot)) errors.push('provenance.sourceSnapshot is required');
  for (const source of ['ga4', 'posthog', 'applications', 'delivery']) {
    if (typeof provenance?.sourceSnapshot?.[source] !== 'string' || !provenance.sourceSnapshot[source]) {
      errors.push(`provenance.sourceSnapshot.${source} is required`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function assertD18Payload(payload) {
  const result = validateD18Payload(payload);
  if (!result.ok) throw new Error(`invalid D18 payload: ${result.errors.join('; ')}`);
  return payload;
}

export async function collectD18Pages({
  fetchPage,
  pageSize = 1000,
  checkpoint = null,
  lastVerified = null,
} = {}) {
  if (typeof fetchPage !== 'function') throw new Error('D18 fetchPage is required');
  const rows = Array.isArray(checkpoint?.rows) ? checkpoint.rows.map(clone) : [];
  const seen = new Set(rows.map((row) => String(row?.id ?? row?.eventId ?? stableJson(row))));
  let cursor = checkpoint?.cursor ?? null;
  let pages = Number(checkpoint?.pages || 0);
  const append = (pageRows) => {
    for (const row of pageRows) {
      const key = String(row?.id ?? row?.eventId ?? stableJson(row));
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(clone(row));
    }
  };
  try {
    while (true) {
      const response = await fetchPage({ cursor, pageSize });
      if (!isObject(response) || !Array.isArray(response.rows)) throw new Error('D18 page response is invalid');
      pages += 1;
      append(response.rows);
      if (!response.hasNext) {
        if (response.rows.length === 0 && rows.length === 0 && lastVerified?.rows) {
          return {
            status: 'sorgente non disponibile',
            rows: clone(lastVerified.rows),
            checkpoint: { rows: clone(lastVerified.rows), cursor: lastVerified.cursor ?? null, pages: lastVerified.pages ?? 0 },
            lastVerified: clone(lastVerified),
          };
        }
        return { status: 'observed', rows, checkpoint: { rows, cursor: response.nextCursor ?? null, pages }, lastVerified: clone(lastVerified) };
      }
      if (response.nextCursor == null || String(response.nextCursor) === String(cursor)) throw new Error('D18 cursor did not advance');
      cursor = response.nextCursor;
    }
  } catch {
    return {
      status: 'parziale',
      rows,
      checkpoint: { rows, cursor, pages },
      lastVerified: clone(lastVerified),
    };
  }
}

export function authorizeD18Request({ credential, credentialCompanyKey, requestedCompanyKey } = {}) {
  if (!credential) return { ok: false, reason: 'credential missing' };
  if (credential === '<TOKEN_REDATTO>' || credential === '[REDACTED]') return { ok: false, reason: 'credential redacted' };
  if (!credentialCompanyKey || credentialCompanyKey !== requestedCompanyKey) return { ok: false, reason: 'cross-company credential' };
  return { ok: true, companyKey: requestedCompanyKey };
}

export function sanitizeD18Secrets(value) {
  if (typeof value === 'string') {
    return value
      .replace(/([?&])t=[^&#]*/gi, '')
      .replace(/([?&])(?:token|credential|authorization|password)=[^&#]*/gi, '')
      .replace(/\?&/g, '?')
      .replace(/[?&]$/g, '')
      .replace(/(authorization|token|credential|password)\s*[:=]\s*[^,;\s]+/gi, '$1=[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(sanitizeD18Secrets);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
      if (/^(?:t|token|credential|authorization|password)$/i.test(key)) return [key, '[REDACTED]'];
      return [key, sanitizeD18Secrets(nested)];
    }));
  }
  return value;
}
