/**
 * Pure application-intent reminder helpers shared by the sender and the
 * saved-jobs recommendation path.
 *
 * The producer is server-owned and may contain anonymous records. These
 * helpers only resolve records that the caller has already associated with a
 * verified uid; no email-to-anonymous join belongs here.
 */

import { extractKeywords } from '../../services/newsletter-content.mjs';
import { locationTokenVariants, normalizeLocToken } from '../../services/locToken.mjs';
import {
  APPLICATION_INTENT_CONSENT_VERSION,
  APPLICATION_INTENT_RETENTION_DAYS,
} from '../../functions/src/applicationIntentCore.js';
import {
  APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION,
} from '../../functions/src/applicationIntentPrivacy.js';

export const APPLICATION_INTENT_RETENTION_MS = APPLICATION_INTENT_RETENTION_DAYS * 86400000;
export const APPLICATION_INTENT_REMINDER_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export { APPLICATION_INTENT_REMINDER_DELIVERIES_COLLECTION };
export const MAX_APPLICATION_INTENT_RECOMMENDATIONS = 3;

const TERMINAL_STATUSES = new Set([
  'completed',
  'submitted',
  'cancelled',
  'canceled',
  'deleted',
  'withdrawn',
  'closed',
]);

const TIMESTAMP_FIELDS = Object.freeze([
  'timestamp',
  'createdAt',
  'created_at',
  'occurredAt',
  'occurred_at',
  'intentAt',
  'intent_at',
  'clickedAt',
  'clicked_at',
]);

const CONSENT_VERSION_FIELDS = Object.freeze([
  'consentVersion',
  'consent_version',
  'termsVersion',
  'terms_version',
  'policyVersion',
  'version',
]);

const CONSENT_TEXT_FIELDS = Object.freeze([
  'consentText',
  'consent_text',
  'termsText',
  'terms_text',
  'textShown',
  'text_shown',
  'shownText',
]);

const JOB_ID_FIELDS = Object.freeze(['jobId', 'job_id', 'listingId', 'listing_id', 'jobIdentifier']);
const JOB_SLUG_FIELDS = Object.freeze(['jobSlug', 'job_slug', 'slug']);

function nonEmpty(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

export function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value && typeof value.seconds === 'number') {
    const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
    const millis = value.seconds * 1000 + Math.floor(nanos / 1e6);
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

export function snapshotData(snapshot) {
  const raw = snapshot?.data;
  // Firestore's DocumentSnapshot.data() reads internal state through `this`.
  // Keep the receiver when normalizing a real snapshot; arrow-function test
  // doubles do not expose this failure mode.
  return typeof raw === 'function' ? raw.call(snapshot) || {} : raw || snapshot || {};
}

export function applicationIntentTimestamp(data) {
  for (const field of TIMESTAMP_FIELDS) {
    const millis = timestampMillis(data?.[field]);
    if (millis !== null) return millis;
  }
  return null;
}

function hasConsent(data) {
  if (!data || typeof data !== 'object') return false;
  const hasVersion = CONSENT_VERSION_FIELDS.some((field) => nonEmpty(data[field]));
  const hasText = CONSENT_TEXT_FIELDS.some((field) => nonEmpty(data[field]));
  if (!hasVersion || !hasText) return false;
  if (data.consentGiven === false || data.consent_given === false) return false;
  const canonical = data.consentVersion === APPLICATION_INTENT_CONSENT_VERSION
    && nonEmpty(data.consentText);
  return canonical || data.consentGiven === true || data.consent_given === true;
}

function expiryMillis(data) {
  if (Object.prototype.hasOwnProperty.call(data || {}, 'expiresAt')) return timestampMillis(data.expiresAt);
  if (Object.prototype.hasOwnProperty.call(data || {}, 'retentionUntil')) return timestampMillis(data.retentionUntil);
  return null;
}

export function applicationIntentDueAt(data) {
  return timestampMillis(data?.reminder?.dueAt || data?.reminder_due_at || data?.dueAt);
}

/**
 * Eligibility for the new sender. Requiring a dueAt is the cutover guard:
 * legacy intents that were previously included in the saved digest are never
 * replayed by this separate channel.
 */
export function isApplicationIntentReminderEligible(data, nowMs = Date.now()) {
  if (!data || typeof data !== 'object' || !hasConsent(data)) return false;
  if (data.reminder?.enabled === false || data.reminder_enabled === false) return false;
  if (data.reminder?.state && data.reminder.state !== 'pending') return false;
  if (data.optedOut === true || data.reminderOptedOut === true || data.reminder_opted_out === true) return false;
  if (data.applicationCompleted === true || data.application_completed === true) return false;
  if (data.completion?.state === 'completed' || data.completion?.completedAt != null) return false;
  if (data.completedAt != null || data.completed_at != null) return false;
  if (TERMINAL_STATUSES.has(String(data.status || data.application_status || '').trim().toLowerCase())) return false;

  const occurredAt = applicationIntentTimestamp(data);
  const dueAt = applicationIntentDueAt(data);
  if (occurredAt === null || dueAt === null || occurredAt > nowMs || dueAt > nowMs) return false;
  if (dueAt < occurredAt + APPLICATION_INTENT_REMINDER_MIN_AGE_MS) return false;

  const expiresAt = expiryMillis(data);
  if (expiresAt === null || expiresAt <= nowMs) return false;
  if (expiresAt > occurredAt + APPLICATION_INTENT_RETENTION_MS) return false;
  return nowMs - occurredAt <= APPLICATION_INTENT_RETENTION_MS;
}

function jobMatchesIdentity(job, candidate) {
  const value = String(candidate || '').trim();
  if (!value || !job) return false;
  if (String(job.id || '').trim() === value) return true;
  if (String(job.slug || '').trim() === value) return true;
  if (Object.values(job.slugByLocale || {}).some((slug) => String(slug || '').trim() === value)) return true;
  const companyKey = String(job.companyKey || '').trim() || 'unknown-company';
  const canonicalSlug = String(job.slugByLocale?.it || job.slug || '').trim();
  if (canonicalSlug && `${companyKey}:${canonicalSlug}` === value) return true;
  if (job.id && `${companyKey}:id:${String(job.id).trim()}` === value) return true;
  return String(job.url || '').trim() === value || String(job.applyUrl || '').trim() === value;
}

export function resolveApplicationIntentJob(data, documentId, jobsById) {
  const nestedJob = data?.job && typeof data.job === 'object' ? data.job : {};
  const nestedListing = data?.listing && typeof data.listing === 'object' ? data.listing : {};
  const directCandidates = [
    ...JOB_ID_FIELDS.map((field) => data?.[field]),
    nestedJob.id,
    nestedListing.id,
    data?.id,
    documentId,
  ];
  for (const candidate of directCandidates) {
    if (jobsById.has(candidate)) return jobsById.get(candidate);
    for (const job of jobsById.values()) if (jobMatchesIdentity(job, candidate)) return job;
  }
  const identityCandidates = [
    data?.jobKey,
    data?.job_key,
    ...JOB_SLUG_FIELDS.map((field) => data?.[field]),
    nestedJob.jobKey,
    nestedJob.slug,
    nestedListing.jobKey,
    nestedListing.slug,
    data?.jobUrl,
    data?.job_url,
    data?.url,
  ];
  for (const candidate of identityCandidates) {
    for (const job of jobsById.values()) if (jobMatchesIdentity(job, candidate)) return job;
  }
  return null;
}

export function applicationIntentUid(snapshot) {
  const collection = snapshot?.ref?.parent;
  const parentDocument = collection?.parent;
  const data = snapshotData(snapshot);
  if (collection?.id === 'application_intents' && parentDocument?.parent?.id === 'users') {
    const pathUid = String(parentDocument.id || '').trim();
    if (!pathUid) return null;
    if (['uid', 'userId', 'accountUid'].some((field) => data[field] != null && String(data[field]).trim() !== pathUid)) return null;
    if (data.identifierType != null && data.identifierType !== 'firebase_uid') return null;
    if (data.identifier != null && String(data.identifier).trim() !== pathUid) return null;
    return pathUid;
  }
  if (data.identifierType !== 'firebase_uid') return null;
  return String(data.identifier || '').trim() || null;
}

export function buildApplicationIntentEntry(snapshot, jobsById, locale, jobUrlBuilder, nowMs = Date.now()) {
  const data = snapshotData(snapshot);
  if (!isApplicationIntentReminderEligible(data, nowMs)) return null;
  const job = resolveApplicationIntentJob(data, snapshot?.id, jobsById);
  if (!job) return null;
  return {
    id: job.id,
    intentId: snapshot?.id || null,
    applicationIntent: true,
    applicationMode: data.application_mode || job.applyMode || 'external',
    intentAt: applicationIntentTimestamp(data),
    url: jobUrlBuilder(job, locale),
    title: job.titleByLocale?.[locale] || job.titleByLocale?.it || job.title || '',
    company: job.company || '',
    canton: job.canton || null,
    location: job.location || job.addressLocality || null,
    category: job.category || null,
    sector: job.sector || job.category || null,
    companyKey: job.companyKey || null,
    firstSeenAt: job.firstSeenAt || null,
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    currency: job.currency || null,
    baseSalary: job.baseSalary || null,
    contract: job.contract || null,
    sourceJob: job,
  };
}

function sourceTitle(job) {
  return `${job?.titleByLocale?.it || job?.title || ''} ${job?.category || ''} ${job?.sector || ''}`;
}

function jobLocationTokens(job) {
  const raw = `${job?.location || ''} ${job?.addressLocality || ''} ${job?.addressRegion || ''} ${job?.canton || ''}`;
  const normalized = normalizeLocToken(raw);
  return new Set(locationTokenVariants(normalized));
}

function jobKeySet(job) {
  return new Set([
    job?.id,
    job?.slug,
    ...Object.values(job?.slugByLocale || {}),
  ].filter(Boolean).map((value) => String(value)));
}

/** Rank semantically and geographically similar live jobs, with no popularity fallback. */
export function rankSimilarApplicationJobs(sourceJobs = [], candidateJobs = [], {
  max = MAX_APPLICATION_INTENT_RECOMMENDATIONS,
  excludedJobIds = new Set(),
} = {}) {
  const sources = Array.isArray(sourceJobs) ? sourceJobs.filter(Boolean) : [];
  const candidates = Array.isArray(candidateJobs) ? candidateJobs : [];
  const excluded = new Set([...excludedJobIds].map((value) => String(value)));
  const sourceProfiles = sources.map((job) => ({
    job,
    keywords: extractKeywords(sourceTitle(job)),
    locations: jobLocationTokens(job),
    canton: String(job?.canton || '').toLowerCase(),
  }));
  const sourceCompanies = new Set(sources
    .map((job) => String(job?.companyKey || job?.company || '').trim().toLowerCase())
    .filter(Boolean));
  const scored = [];
  for (const candidate of candidates) {
    if (!candidate?.id || excluded.has(String(candidate.id))) continue;
    const candidateCompany = String(candidate.companyKey || candidate.company || '').trim().toLowerCase();
    if (candidateCompany && sourceCompanies.has(candidateCompany)) continue;
    const candidateKeys = jobKeySet(candidate);
    if (sourceProfiles.some(({ job }) => [...jobKeySet(job)].some((key) => candidateKeys.has(key)))) continue;
    const candidateKeywords = extractKeywords(sourceTitle(candidate));
    const candidateLocations = jobLocationTokens(candidate);
    let best = null;
    for (const source of sourceProfiles) {
      let overlap = 0;
      for (const keyword of source.keywords) if (candidateKeywords.has(keyword)) overlap++;
      if (overlap === 0) continue;
      const sameLocation = [...source.locations].some((token) => candidateLocations.has(token));
      const sameCanton = source.canton && source.canton === String(candidate.canton || '').toLowerCase();
      const score = overlap * 4 + (sameLocation ? 7 : 0) + (sameCanton ? 2 : 0);
      if (!best || score > best.score) best = { score, overlap, sameLocation, sameCanton };
    }
    if (!best) continue;
    scored.push({ candidate, ...best });
  }
  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff) return scoreDiff;
    const dateA = timestampMillis(a.candidate.firstSeenAt || a.candidate.postedDate) || 0;
    const dateB = timestampMillis(b.candidate.firstSeenAt || b.candidate.postedDate) || 0;
    return dateB - dateA;
  });

  const result = [];
  const companies = new Set();
  for (const { candidate } of scored) {
    if (result.length >= max) break;
    const company = String(candidate.companyKey || candidate.company || '').toLowerCase();
    if (company && companies.has(company)) continue;
    result.push(candidate);
    if (company) companies.add(company);
  }
  return result;
}
