import { createHash } from 'node:crypto';
import { extractStableJobId } from './job-match-key.mjs';
import { classifyByRegex, CLUSTER_TAXONOMY } from './cluster-classifier-prompt.mjs';

export const SOCIAL_SOURCE_CATALOG_SCHEMA_VERSION = 1;
export const SOCIAL_SOURCE_CATALOG_MAX_AGE_DAYS = 2;
export const SOCIAL_JOB_SOURCE_MAX_AGE_DAYS = 7;
export const SOCIAL_JOB_SOURCE_MAX_CANDIDATES = 120;
export const SOCIAL_SOURCE_FRESHNESS_MAX_AGE_DAYS = Object.freeze({
  article: 30,
  job: SOCIAL_JOB_SOURCE_MAX_AGE_DAYS,
  event: 7,
});

export const SOCIAL_SOURCE_FORMATS_BY_KIND = Object.freeze({
  article: Object.freeze([
    'instagram.article', 'instagram.reel', 'tiktok.article', 'tiktok.video',
    'facebook.article', 'linkedin.article',
  ]),
  job: Object.freeze([
    'instagram.job', 'instagram.reel', 'tiktok.job', 'tiktok.video',
    'facebook.job', 'linkedin.job', 'telegram.job', 'reddit.job',
  ]),
  event: Object.freeze(['facebook.event']),
});

const SOURCE_KIND_SET = new Set(Object.keys(SOCIAL_SOURCE_FORMATS_BY_KIND));
const TOPIC_SET = new Set(CLUSTER_TAXONOMY);
const SOURCE_ID_RE = /^(?:article|job|event)-[a-f0-9]{20}$/u;
const FORMAT_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
const SELECTION_HINT_RE = /(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|@[\w.]+|[<>{}])/iu;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function canonicalIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function normalizeIdentity(kind, identity) {
  const normalized = String(identity || '').normalize('NFKC').trim();
  if (!SOURCE_KIND_SET.has(kind) || !normalized || normalized.length > 2048) return null;
  return normalized;
}

export function sanitizeSocialSourceSelectionHint(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').replace(/[\r\n\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > 120 || SELECTION_HINT_RE.test(normalized)) return null;
  return normalized.replace(/\b\d+(?:[.,]\d+)?\b/gu, '').replace(/\s+/gu, ' ').trim() || null;
}

export function createSocialSourceId(kind, identity) {
  const normalized = normalizeIdentity(kind, identity);
  if (!normalized) return null;
  const digest = createHash('sha256').update(`${kind}\n${normalized}`).digest('hex').slice(0, 20);
  return `${kind}-${digest}`;
}

export function socialSourceIdForArticle(articleOrSlug) {
  const slug = typeof articleOrSlug === 'string'
    ? articleOrSlug
    : isRecord(articleOrSlug) ? articleOrSlug.slug : '';
  const normalized = String(slug || '').normalize('NFKC').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)) return null;
  return createSocialSourceId('article', normalized);
}

export function socialSourceIdForJob(job) {
  if (!isRecord(job)) return null;
  try {
    const url = new URL(String(job.url || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
  } catch {
    return null;
  }
  const stableId = extractStableJobId(job.url);
  return stableId ? createSocialSourceId('job', stableId) : null;
}

export function socialSourceIdForEvent(event) {
  if (!isRecord(event)) return null;
  const date = canonicalIsoDate(event.startDate);
  if (!date) return null;
  let identity = '';
  try {
    const url = new URL(String(event.url || ''));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    const pathname = url.pathname.replace(/\/+$/u, '');
    identity = `${url.origin}${pathname}|${date}`;
  } catch {
    const id = String(event.id || '').normalize('NFKC').trim();
    const canton = String(event.canton || '').trim().toUpperCase();
    if (!id || !/^[A-Z]{2}$/u.test(canton)) return null;
    identity = `${canton}|${id}|${date}`;
  }
  return createSocialSourceId('event', identity);
}

/**
 * Move Codex-recommended sources ahead of publisher-ranked candidates only
 * when the exact opaque ID resolves to an already eligible live candidate.
 * Unmatched, stale, or malformed recommendations leave publisher order intact.
 */
export function preferredSocialSourceCandidates(candidates, {
  pack,
  channel,
  format,
  sourceIdForCandidate,
} = {}) {
  if (!Array.isArray(candidates) || typeof sourceIdForCandidate !== 'function') return [];
  const recommendations = Array.isArray(pack?.sourceAssignments)
    ? pack.sourceAssignments.filter((assignment) => assignment?.channel === channel
      && assignment?.format === format
      && typeof assignment.sourceId === 'string'
      && SOURCE_ID_RE.test(assignment.sourceId)
      && SOCIAL_SOURCE_FORMATS_BY_KIND[assignment.sourceId.split('-', 1)[0]]?.includes(`${channel}.${format}`))
    : [];
  if (recommendations.length === 0) return [];
  const recommendedIds = new Set(recommendations.map((assignment) => assignment.sourceId));
  const candidateBySourceId = new Map();
  for (const candidate of candidates) {
    let sourceId = null;
    try {
      sourceId = sourceIdForCandidate(candidate);
    } catch {
      sourceId = null;
    }
    if (recommendedIds.has(sourceId) && !candidateBySourceId.has(sourceId)) {
      candidateBySourceId.set(sourceId, candidate);
    }
  }
  return recommendations.map((assignment) => candidateBySourceId.get(assignment.sourceId)).filter(Boolean);
}

export function prioritizeSocialSourceCandidates(candidates, options = {}) {
  if (!Array.isArray(candidates)) return [];
  const preferred = preferredSocialSourceCandidates(candidates, options);
  if (preferred.length === 0) return candidates;
  const preferredSet = new Set(preferred);
  return [...preferred, ...candidates.filter((candidate) => !preferredSet.has(candidate))];
}

function normalizedSource(source, { requireFreshness = true } = {}) {
  if (!isRecord(source)) return null;
  const sourceId = String(source.sourceId || '').trim();
  const contentKind = String(source.contentKind || '').trim();
  const topic = String(source.topic || '').trim();
  const freshnessDays = source.freshnessDays;
  const sourceObservedOn = source.sourceObservedOn == null ? null : canonicalIsoDate(source.sourceObservedOn);
  const eligibleFormats = Array.isArray(source.eligibleFormats) ? source.eligibleFormats : null;
  const selectionHint = source.selectionHint == null ? null : sanitizeSocialSourceSelectionHint(source.selectionHint);
  if (!SOURCE_ID_RE.test(sourceId)
    || !SOURCE_KIND_SET.has(contentKind)
    || !sourceId.startsWith(`${contentKind}-`)
    || !TOPIC_SET.has(topic)
    || !Number.isSafeInteger(freshnessDays)
    || freshnessDays < 0
    || freshnessDays > 365
    || source.sourceObservedOn != null && !sourceObservedOn
    || source.selectionHint != null && !selectionHint
    || !eligibleFormats
    || eligibleFormats.length < 1
    || eligibleFormats.some((format) => !FORMAT_RE.test(format)
      || !SOCIAL_SOURCE_FORMATS_BY_KIND[contentKind].includes(format))) {
    return null;
  }
  if (requireFreshness && freshnessDays > SOCIAL_SOURCE_FRESHNESS_MAX_AGE_DAYS[contentKind]) return null;
  const formats = [...new Set(eligibleFormats)].sort();
  if (formats.length !== eligibleFormats.length) return null;
  return {
    sourceId,
    contentKind,
    topic,
    freshnessDays,
    ...(sourceObservedOn ? { sourceObservedOn } : {}),
    ...(selectionHint ? { selectionHint } : {}),
    eligibleFormats: formats,
  };
}

export function socialSourceCatalogId(sources) {
  const normalized = (Array.isArray(sources) ? sources : [])
    .map((source) => normalizedSource(source, { requireFreshness: false }))
    .filter(Boolean)
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return createHash('sha256').update(stableJson(normalized)).digest('hex').slice(0, 32);
}

export function validateSocialSourceCatalog(value, { now = new Date(), allowStale = false } = {}) {
  if (!isRecord(value)
    || value.schemaVersion !== SOCIAL_SOURCE_CATALOG_SCHEMA_VERSION
    || !Array.isArray(value.sources)) {
    throw new Error('social source catalog is malformed');
  }
  const snapshotDate = canonicalIsoDate(value.snapshotDate);
  const current = now instanceof Date ? now : new Date(now);
  if (!snapshotDate || !Number.isFinite(current.getTime())) throw new Error('social source catalog needs valid dates');
  const snapshotMs = Date.parse(`${snapshotDate}T00:00:00.000Z`);
  const currentDay = Date.parse(`${current.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const ageDays = Math.floor((currentDay - snapshotMs) / DAY_MS);
  if (ageDays < 0 || (!allowStale && ageDays > SOCIAL_SOURCE_CATALOG_MAX_AGE_DAYS)) {
    throw new Error('social source catalog is future-dated or stale');
  }
  const seen = new Set();
  const sources = value.sources.map((source) => {
    const normalized = normalizedSource(source, { requireFreshness: !allowStale });
    if (!normalized || seen.has(normalized.sourceId)) throw new Error('social source catalog contains an invalid or duplicate source');
    seen.add(normalized.sourceId);
    return normalized;
  });
  const expectedId = socialSourceCatalogId(sources);
  if (value.catalogId !== expectedId) throw new Error('social source catalog digest does not match its sources');
  return { schemaVersion: SOCIAL_SOURCE_CATALOG_SCHEMA_VERSION, snapshotDate, catalogId: expectedId, sources };
}

function sourceTopic(job) {
  const declared = String(job.category || job.cluster || '').trim();
  if (TOPIC_SET.has(declared)) return declared;
  const classified = classifyByRegex(String(job.title || ''));
  return TOPIC_SET.has(classified) ? classified : 'generic';
}

/** Build a small, sanitized candidate list from the assembled publishable job records. */
export function buildSocialJobSourceCatalog(jobs, { asOf = new Date(), maxAgeDays = SOCIAL_JOB_SOURCE_MAX_AGE_DAYS } = {}) {
  const current = asOf instanceof Date ? asOf : new Date(asOf);
  if (!Number.isFinite(current.getTime())) throw new TypeError('asOf must be a valid date');
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 30) {
    throw new TypeError('maxAgeDays must be an integer from 1 to 30');
  }
  const today = Date.parse(`${current.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const unique = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!isRecord(job) || job.needsRetranslation === true || job.publicationHold === true) continue;
    const sourceId = socialSourceIdForJob(job);
    const observedAt = canonicalIsoDate(job.crawledAt);
    if (!sourceId || !observedAt) continue;
    const observedMs = Date.parse(`${observedAt}T00:00:00.000Z`);
    const freshnessDays = Math.floor((today - observedMs) / DAY_MS);
    if (freshnessDays < 0 || freshnessDays > maxAgeDays) continue;
    const source = {
      sourceId,
      contentKind: 'job',
      topic: sourceTopic(job),
      freshnessDays,
      sourceObservedOn: observedAt,
      selectionHint: sanitizeSocialSourceSelectionHint(job.title),
      eligibleFormats: [...SOCIAL_SOURCE_FORMATS_BY_KIND.job],
    };
    const previous = unique.get(sourceId);
    if (!previous || source.freshnessDays < previous.freshnessDays) unique.set(sourceId, source);
  }

  const sources = [...unique.values()]
    .sort((left, right) => left.freshnessDays - right.freshnessDays
      || left.topic.localeCompare(right.topic)
      || left.sourceId.localeCompare(right.sourceId))
    .slice(0, SOCIAL_JOB_SOURCE_MAX_CANDIDATES);
  const catalog = {
    schemaVersion: SOCIAL_SOURCE_CATALOG_SCHEMA_VERSION,
    snapshotDate: current.toISOString().slice(0, 10),
    sources,
  };
  return { ...catalog, catalogId: socialSourceCatalogId(sources) };
}

