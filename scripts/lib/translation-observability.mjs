import { createHash } from 'node:crypto';
import { digestDocument } from './canonical-json-digest.mjs';
import { buildStableJobIdentity } from './job-identity.mjs';
import { mergeUrlKey } from './job-url-key.mjs';
import { isIncomplete, summarizeJobs, finalizeEntry } from '../log-translation-stats.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];
const MAX_COMPANIES = 20;
const MAX_FINGERPRINTS = 100;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function jobsFrom(document) {
  if (Array.isArray(document)) return document;
  return Array.isArray(document?.jobs) ? document.jobs : [];
}

function ageBucket(job, now) {
  const raw = job.firstSeenAt || job.crawledAt || job.postedDate || job.datePosted;
  const value = Date.parse(raw || '');
  if (!Number.isFinite(value) || value > now) return 'unknown';
  const days = (now - value) / 86_400_000;
  if (days <= 1) return '0-1d';
  if (days <= 7) return '2-7d';
  if (days <= 30) return '8-30d';
  if (days <= 90) return '31-90d';
  return '91d+';
}

function slotReasons(job, incomplete) {
  const reasons = [];
  if (job.needsRetranslation) reasons.push('needs_retranslation');
  if (job.localeMismatchSuppressed) reasons.push('locale_mismatch_suppressed');
  if (!incomplete) return reasons;
  const source = normalized(job.description);
  const sourceLang = normalized(job.sourceLang) || 'it';
  for (const locale of LOCALES) {
    const title = String(job.titleByLocale?.[locale] || '').trim();
    const description = String(job.descriptionByLocale?.[locale] || '').trim();
    if (title.length < 3) reasons.push(`title_missing:${locale}`);
    if (description.length < 120) reasons.push(`description_missing:${locale}`);
    if (locale !== sourceLang && source && normalized(description) === source) {
      reasons.push(`source_copy_description:${locale}`);
    }
  }
  return reasons;
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function boundedFingerprints(values) {
  return [...new Set(values)].sort().slice(0, MAX_FINGERPRINTS).map((value) => `sha256:${value}`);
}

function canonicalMetrics(jobs, now) {
  const summarized = finalizeEntry(summarizeJobs(jobs), { label: 'observability', now, timestamp: new Date(now).toISOString() });
  return {
    total: summarized.total,
    incomplete: summarized.incomplete,
    slotsPresent: summarized.slotsPresent,
    needsRetranslation: summarized.needsRetranslation,
    flaggedAmongSlotsPresent: summarized.flaggedAmongSlotsPresent,
    verifiedTranslated: summarized.verifiedTranslated,
    suppressed: summarized.suppressed,
    missingByLocale: summarized.missingByLocale,
  };
}

/** Build a private, hash-only snapshot. It contains no job text, id or URL. */
export function createTranslationObservabilitySnapshot(document, { now = Date.now() } = {}) {
  const jobs = jobsFrom(document);
  const quality = { reasons: {}, byLocale: {}, bySourceLang: {}, byLocaleSourceLang: {} };
  const cohorts = { age: { '0-1d': 0, '2-7d': 0, '8-30d': 0, '31-90d': 0, '91d+': 0, unknown: 0 }, companies: {} };
  const rows = [];
  for (const job of jobs) {
    const incomplete = isIncomplete(job);
    const flagged = !!job.needsRetranslation;
    const identityHash = sha256(buildStableJobIdentity(job));
    const urlKey = mergeUrlKey(job.url || '');
    const urlKeyHash = urlKey ? sha256(urlKey) : null;
    const state = incomplete ? 'incomplete' : flagged ? 'flagged' : 'complete';
    rows.push({ identityHash, urlKeyHash, state });
    const sourceLang = normalized(job.sourceLang) || 'unknown';
    const pending = incomplete || flagged;
    if (pending) {
      increment(cohorts.age, ageBucket(job, now));
      // Cohort ranking only needs a stable bucket. Keep the crawled company key
      // out of both the private snapshot and the uploaded/committed report.
      increment(cohorts.companies, `sha256:${sha256(normalized(job.companyKey) || 'unknown')}`);
    }
    for (const reason of slotReasons(job, incomplete)) {
      increment(quality.reasons, reason);
      increment(quality.bySourceLang, sourceLang);
      const locale = reason.includes(':') ? reason.split(':')[1] : 'all';
      increment(quality.byLocale, locale);
      increment(quality.byLocaleSourceLang, `${locale}:${sourceLang}`);
    }
  }
  rows.sort((left, right) => left.identityHash.localeCompare(right.identityHash) || left.state.localeCompare(right.state));
  return {
    schemaVersion: 1,
    metrics: canonicalMetrics(jobs, now),
    jobSetDigest: digestDocument(rows.map((row) => row.identityHash)),
    rows,
    quality,
    cohorts,
  };
}

function states(snapshot) {
  return new Map(snapshot.rows.map((row) => [row.identityHash, row]));
}

function boundedCompanies(companies) {
  return Object.entries(companies)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_COMPANIES)
    .map(([companyFingerprint, pending]) => ({ companyFingerprint, pending }));
}

/** Combine two snapshots into the public, bounded report. */
export function buildTranslationObservabilityReport({ before, final, runId, startedAt, finishedAt = new Date().toISOString(), sourceCommit, outcome = 'unknown' }) {
  const previous = states(before);
  const current = states(final);
  const delta = { added: 0, removed: 0, persisted: 0, transitions: { complete: 0, flagged: 0, incomplete: 0 }, ingress: 0, drain: 0 };
  const fingerprints = [];
  for (const [identityHash, row] of current) {
    const old = previous.get(identityHash);
    if (!old) {
      delta.added++;
      if (row.state !== 'complete') delta.ingress++;
      fingerprints.push(identityHash);
      continue;
    }
    delta.persisted++;
    if (old.state !== row.state) {
      increment(delta.transitions, `${old.state}_to_${row.state}`);
      if (old.state !== 'complete' && row.state === 'complete') delta.drain++;
      if (old.state === 'complete' && row.state !== 'complete') delta.ingress++;
    }
  }
  for (const [identityHash, row] of previous) {
    if (!current.has(identityHash)) {
      delta.removed++;
      if (row.state !== 'complete') delta.drain++;
      fingerprints.push(identityHash);
    }
  }
  const previousUrl = new Map();
  for (const row of before.rows) {
    if (row.urlKeyHash) previousUrl.set(row.urlKeyHash, (previousUrl.get(row.urlKeyHash) || 0) + 1);
  }
  // A before/final pair only observes active records. It cannot prove a
  // deletion followed by re-addition between snapshots.
  const continuity = {
    activePersisted: delta.persisted,
    newIdentities: 0,
    stableUrlIdentityChanges: 0,
    ambiguous: 0,
    fingerprints: [],
    deleteReaddEvidence: {
      observable: false,
      proven: 0,
      reason: 'Active before/final snapshots retain neither deletions nor a durable re-add event.',
    },
  };
  for (const [identityHash, row] of current) {
    if (previous.has(identityHash)) continue;
    const candidates = row.urlKeyHash ? (previousUrl.get(row.urlKeyHash) || 0) : 0;
    if (candidates === 1) continuity.stableUrlIdentityChanges++;
    else if (candidates > 1) continuity.ambiguous++;
    else continuity.newIdentities++;
  }
  const report = {
    schemaVersion: 1,
    runId: String(runId),
    startedAt: String(startedAt),
    finishedAt,
    sourceCommit: sourceCommit || null,
    finalCommit: null,
    outcome,
    before: { ...before.metrics, jobSetDigest: before.jobSetDigest },
    final: { ...final.metrics, jobSetDigest: final.jobSetDigest },
    delta,
    cohorts: { age: final.cohorts.age, topCompanies: boundedCompanies(final.cohorts.companies) },
    quality: final.quality,
    continuity: { ...continuity, fingerprints: boundedFingerprints(fingerprints) },
  };
  report.digest = digestDocument(report);
  return report;
}

export function finalizeTranslationObservabilityReport(report, finalCommit) {
  const copy = { ...report, finalCommit: finalCommit || null };
  delete copy.digest;
  copy.digest = digestDocument(copy);
  const bytes = Buffer.byteLength(JSON.stringify(copy));
  if (bytes > 1_048_576) throw new RangeError(`Translation observability report exceeds 1 MiB (${bytes} bytes)`);
  return copy;
}
