import { createHash } from 'node:crypto';
import { digestDocument } from './canonical-json-digest.mjs';
import { buildStableJobIdentity } from './job-identity.mjs';
import { isIncomplete, summarizeJobs, finalizeEntry } from '../log-translation-stats.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];
const MAX_COMPANIES = 20;
const MAX_FINGERPRINTS = 100;
const HASH_BYTES = 32;
const ACTIVE_ROW_BYTES = 65;
const RETIRED_ROW_BYTES = 69;
const STATE_ENCODING = 'identity-content-state-retired-day-base64-v2';
const STATE_NAMES = ['complete', 'flagged', 'incomplete'];
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export const TRANSLATION_OBSERVABILITY_LIMITS = Object.freeze({ retiredCap: 50_000, retentionDays: 90 });

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function normalized(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
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
    if (locale !== sourceLang && source && normalized(description) === source) reasons.push(`source_copy_description:${locale}`);
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

function sourceTranslationUnitHash(job) {
  return digestDocument({
    sourceLang: normalized(job.sourceLang) || 'unknown',
    title: normalized(job.title),
    description: normalized(job.description),
    requirements: Array.isArray(job.requirements) ? job.requirements.map(normalized).filter(Boolean) : [],
  }).slice(7);
}

/** Build a private, hash-only snapshot. It contains no job text, id, slug or URL. */
export function createTranslationObservabilitySnapshot(document, { now = Date.now() } = {}) {
  const jobs = jobsFrom(document);
  const quality = { reasons: {}, byLocale: {}, bySourceLang: {}, byLocaleSourceLang: {} };
  const cohorts = { age: { '0-1d': 0, '2-7d': 0, '8-30d': 0, '31-90d': 0, '91d+': 0, unknown: 0 }, companies: {} };
  const rows = [];
  for (const job of jobs) {
    const incomplete = isIncomplete(job);
    const flagged = !!job.needsRetranslation;
    const identityHash = sha256(buildStableJobIdentity(job));
    const contentHash = sourceTranslationUnitHash(job);
    const state = incomplete ? 'incomplete' : flagged ? 'flagged' : 'complete';
    rows.push({ identityHash, contentHash, state });
    const sourceLang = normalized(job.sourceLang) || 'unknown';
    if (incomplete || flagged) {
      increment(cohorts.age, ageBucket(job, now));
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
    schemaVersion: 2,
    metrics: canonicalMetrics(jobs, now),
    jobSetDigest: digestDocument(rows.map((row) => row.identityHash)),
    rows,
    quality,
    cohorts,
  };
}

function assertHash(value, field) {
  if (!HASH_PATTERN.test(value || '')) throw new TypeError(`Invalid ${field} SHA-256`);
}

function stateCode(value) {
  const code = STATE_NAMES.indexOf(value);
  if (code < 0) throw new TypeError(`Invalid translation state: ${value}`);
  return code;
}

/** Pack fixed-width hash-only records for bounded persisted state. */
export function packTranslationObservabilityRows(rows, { retired = false } = {}) {
  const width = retired ? RETIRED_ROW_BYTES : ACTIVE_ROW_BYTES;
  const sorted = [...rows].sort((left, right) => left.identityHash.localeCompare(right.identityHash));
  const buffer = Buffer.alloc(sorted.length * width);
  sorted.forEach((row, index) => {
    assertHash(row.identityHash, 'identity');
    assertHash(row.contentHash, 'content');
    const offset = index * width;
    Buffer.from(row.identityHash, 'hex').copy(buffer, offset);
    Buffer.from(row.contentHash, 'hex').copy(buffer, offset + HASH_BYTES);
    buffer[offset + (HASH_BYTES * 2)] = stateCode(row.state);
    if (retired) {
      if (!Number.isInteger(row.retiredDay) || row.retiredDay < 1 || row.retiredDay > 0xffff_ffff) throw new TypeError('Invalid retired day');
      buffer.writeUInt32BE(row.retiredDay, offset + ACTIVE_ROW_BYTES);
    }
  });
  return buffer.toString('base64');
}

export function unpackTranslationObservabilityRows(packed, count, { retired = false } = {}) {
  if (typeof packed !== 'string' || !Number.isInteger(count) || count < 0) throw new TypeError('Invalid packed row envelope');
  const width = retired ? RETIRED_ROW_BYTES : ACTIVE_ROW_BYTES;
  const buffer = Buffer.from(packed, 'base64');
  if (buffer.toString('base64') !== packed || buffer.length !== count * width) throw new TypeError('Invalid packed row bytes');
  const rows = [];
  for (let index = 0; index < count; index++) {
    const offset = index * width;
    const code = buffer[offset + (HASH_BYTES * 2)];
    if (!STATE_NAMES[code]) throw new TypeError('Invalid packed translation state');
    const row = {
      identityHash: buffer.subarray(offset, offset + HASH_BYTES).toString('hex'),
      contentHash: buffer.subarray(offset + HASH_BYTES, offset + (HASH_BYTES * 2)).toString('hex'),
      state: STATE_NAMES[code],
    };
    if (retired) row.retiredDay = buffer.readUInt32BE(offset + ACTIVE_ROW_BYTES);
    rows.push(row);
  }
  return rows;
}

function stateDigest(document) {
  const copy = structuredClone(document);
  delete copy.digest;
  return digestDocument(copy);
}

function boundedPolicy(policy = TRANSLATION_OBSERVABILITY_LIMITS) {
  const retiredCap = Number(policy.retiredCap);
  const retentionDays = Number(policy.retentionDays);
  if (!Number.isInteger(retiredCap) || retiredCap < 1 || retiredCap > TRANSLATION_OBSERVABILITY_LIMITS.retiredCap) throw new TypeError('Invalid retired registry cap');
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > TRANSLATION_OBSERVABILITY_LIMITS.retentionDays) throw new TypeError('Invalid retired registry retention');
  return { retiredCap, retentionDays };
}

function buildPersistedState({ generation, observedDay, activeRows, retiredRows, policy, evidenceLoss }) {
  const document = {
    schemaVersion: 2,
    encoding: STATE_ENCODING,
    generation,
    observedDay,
    policy: boundedPolicy(policy),
    active: { count: activeRows.length, packed: packTranslationObservabilityRows(activeRows) },
    retired: { count: retiredRows.length, packed: packTranslationObservabilityRows(retiredRows, { retired: true }) },
    evidenceLoss: {
      retentionEvictions: evidenceLoss?.retentionEvictions || 0,
      capEvictions: evidenceLoss?.capEvictions || 0,
      stateResets: evidenceLoss?.stateResets || 0,
    },
  };
  document.digest = stateDigest(document);
  return document;
}

/** Validate the state digest and enumerate its packed hash-only population. */
export function unpackTranslationObservabilityState(document) {
  if (!document || document.schemaVersion !== 2 || document.encoding !== STATE_ENCODING) throw new TypeError('Unsupported translation observability state');
  if (!Number.isInteger(document.generation) || document.generation < 1 || document.generation >= 0xffff_ffff) throw new TypeError('Invalid state generation');
  if (!Number.isInteger(document.observedDay) || document.observedDay < 1 || document.observedDay > 0xffff_ffff) throw new TypeError('Invalid observed day');
  if (document.digest !== stateDigest(document)) throw new TypeError('Translation observability state digest mismatch');
  const policy = boundedPolicy(document.policy);
  const activeRows = unpackTranslationObservabilityRows(document.active?.packed, document.active?.count);
  const retiredRows = unpackTranslationObservabilityRows(document.retired?.packed, document.retired?.count, { retired: true });
  if (retiredRows.length > policy.retiredCap) throw new RangeError('Retired registry exceeds its cap');
  const activeIds = new Set();
  for (const row of activeRows) {
    if (activeIds.has(row.identityHash)) throw new TypeError('Duplicate active identity hash');
    activeIds.add(row.identityHash);
  }
  const retiredIds = new Set();
  for (const row of retiredRows) {
    if (retiredIds.has(row.identityHash) || activeIds.has(row.identityHash)) throw new TypeError('Duplicate or active retired identity hash');
    if (row.retiredDay > document.observedDay) throw new TypeError('Retired day is in the future');
    retiredIds.add(row.identityHash);
  }
  const evidenceLoss = document.evidenceLoss || {};
  if (![evidenceLoss.retentionEvictions, evidenceLoss.capEvictions, evidenceLoss.stateResets].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Invalid evidence-loss counters');
  return { generation: document.generation, observedDay: document.observedDay, policy, activeRows, retiredRows, evidenceLoss: { ...evidenceLoss } };
}

function uniqueRows(snapshot) {
  const rows = new Map();
  for (const row of snapshot?.rows || []) {
    assertHash(row.identityHash, 'identity');
    assertHash(row.contentHash, 'content');
    stateCode(row.state);
    if (rows.has(row.identityHash)) throw new TypeError('Duplicate final identity hash');
    rows.set(row.identityHash, row);
  }
  return rows;
}

function unavailableContinuity(reason, state) {
  return {
    activePersisted: 0,
    newIdentities: 0,
    ambiguous: 0,
    perfectReuseCandidates: 0,
    retired: state?.retired?.count || 0,
    deleteReaddEvidence: {
      observable: false,
      complete: false,
      proven: 0,
      reason,
      retentionDays: state?.policy?.retentionDays || TRANSLATION_OBSERVABILITY_LIMITS.retentionDays,
      retiredCap: state?.policy?.retiredCap || TRANSLATION_OBSERVABILITY_LIMITS.retiredCap,
      evictedThisGeneration: { retention: 0, cap: 0 },
    },
  };
}

/** Advance one valid true-final generation and derive cross-generation evidence. */
export function advanceTranslationObservabilityState({ previousState = null, final, validFinal = true, skipReason = 'true_final_not_valid', stateIssue = null, policy = TRANSLATION_OBSERVABILITY_LIMITS, now = Date.now() } = {}) {
  if (stateIssue) previousState = null;
  if (!validFinal) return { advanced: false, state: previousState, continuity: unavailableContinuity(skipReason, previousState), identityHashes: [] };
  let current;
  try {
    current = uniqueRows(final);
  } catch {
    return { advanced: false, state: previousState, continuity: unavailableContinuity('invalid_true_final_population', previousState), identityHashes: [] };
  }
  const requestedDay = Math.floor(Number(now) / 86_400_000);
  if (!Number.isSafeInteger(requestedDay) || requestedDay < 1 || requestedDay > 0xffff_ffff) {
    return { advanced: false, state: previousState, continuity: unavailableContinuity('invalid_observation_time', previousState), identityHashes: [] };
  }
  if (!previousState) {
    const stateResets = stateIssue ? 1 : 0;
    const reason = stateIssue ? 'persisted_state_invalid_rebootstrap' : 'bootstrap_first_valid_generation';
    const state = buildPersistedState({
      generation: 1,
      observedDay: requestedDay,
      activeRows: [...current.values()],
      retiredRows: [],
      policy,
      evidenceLoss: { stateResets },
    });
    return {
      advanced: true,
      state,
      transitionReason: stateIssue ? reason : 'valid_true_final',
      continuity: unavailableContinuity(reason, state),
      identityHashes: [],
    };
  }

  const previous = unpackTranslationObservabilityState(previousState);
  const generation = previous.generation + 1;
  const observedDay = Math.max(requestedDay, previous.observedDay);
  const active = new Map(previous.activeRows.map((row) => [row.identityHash, row]));
  const retainedRetired = [];
  let retentionEvictions = 0;
  for (const row of previous.retiredRows) {
    if (observedDay - row.retiredDay > previous.policy.retentionDays) retentionEvictions++;
    else retainedRetired.push(row);
  }
  const eligibleRetired = new Map(retainedRetired.map((row) => [row.identityHash, row]));
  const retiredByContent = new Map();
  for (const row of retainedRetired) {
    const matches = retiredByContent.get(row.contentHash) || [];
    matches.push(row);
    retiredByContent.set(row.contentHash, matches);
  }

  let activePersisted = 0;
  let proven = 0;
  let ambiguous = 0;
  let perfectReuseCandidates = 0;
  let newIdentities = 0;
  const identityHashes = [];
  for (const row of current.values()) {
    if (active.has(row.identityHash)) {
      activePersisted++;
      continue;
    }
    const priorIdentity = eligibleRetired.get(row.identityHash);
    if (priorIdentity) {
      proven++;
      if (priorIdentity.state === 'complete') perfectReuseCandidates++;
      eligibleRetired.delete(row.identityHash);
      identityHashes.push(row.identityHash);
      continue;
    }
    const contentMatches = (retiredByContent.get(row.contentHash) || []).filter((candidate) => eligibleRetired.has(candidate.identityHash));
    if (contentMatches.length > 0) {
      ambiguous++;
      if (contentMatches.some((candidate) => candidate.state === 'complete')) perfectReuseCandidates++;
      identityHashes.push(row.identityHash);
    } else newIdentities++;
  }

  const nextRetired = [...eligibleRetired.values()];
  for (const row of active.values()) {
    if (!current.has(row.identityHash)) {
      nextRetired.push({ ...row, retiredDay: observedDay });
      identityHashes.push(row.identityHash);
    }
  }
  nextRetired.sort((left, right) => right.retiredDay - left.retiredDay || left.identityHash.localeCompare(right.identityHash));
  const capEvictions = Math.max(0, nextRetired.length - previous.policy.retiredCap);
  if (capEvictions) nextRetired.splice(previous.policy.retiredCap);
  const evidenceLoss = {
    retentionEvictions: previous.evidenceLoss.retentionEvictions + retentionEvictions,
    capEvictions: previous.evidenceLoss.capEvictions + capEvictions,
    stateResets: previous.evidenceLoss.stateResets,
  };
  const complete = evidenceLoss.retentionEvictions === 0 && evidenceLoss.capEvictions === 0 && evidenceLoss.stateResets === 0;
  const reason = capEvictions > 0
    ? 'retired_evidence_evicted_by_cap'
    : retentionEvictions > 0
      ? 'retired_evidence_evicted_by_retention'
      : complete
        ? 'valid_intergenerational_comparison'
        : evidenceLoss.stateResets > 0
          ? 'prior_persisted_state_was_reset'
          : 'prior_retired_evidence_was_evicted';
  const state = buildPersistedState({ generation, observedDay, activeRows: [...current.values()], retiredRows: nextRetired, policy: previous.policy, evidenceLoss });
  return {
    advanced: true,
    state,
    transitionReason: 'valid_true_final',
    identityHashes,
    continuity: {
      activePersisted,
      newIdentities,
      ambiguous,
      perfectReuseCandidates,
      retired: nextRetired.length,
      deleteReaddEvidence: {
        observable: true,
        complete,
        proven,
        reason,
        retentionDays: previous.policy.retentionDays,
        retiredCap: previous.policy.retiredCap,
        evictedThisGeneration: { retention: retentionEvictions, cap: capEvictions },
      },
    },
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

/** Combine two same-run snapshots and cross-generation shadow evidence. */
export function buildTranslationObservabilityReport({ before, final, runId, startedAt, finishedAt = new Date().toISOString(), sourceCommit, outcome = 'unknown', generationObservation = null }) {
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
  const observation = generationObservation || { advanced: false, state: null, identityHashes: [], continuity: unavailableContinuity('cross_generation_state_not_supplied', null) };
  const report = {
    schemaVersion: 2,
    runId: String(runId),
    startedAt: String(startedAt),
    finishedAt,
    sourceCommit: sourceCommit || null,
    finalCommit: null,
    outcome,
    stateTransition: {
      advanced: observation.advanced,
      generation: observation.state?.generation || null,
      stateDigest: observation.state?.digest || null,
      reason: observation.transitionReason || observation.continuity.deleteReaddEvidence.reason,
    },
    before: { ...before.metrics, jobSetDigest: before.jobSetDigest },
    final: { ...final.metrics, jobSetDigest: final.jobSetDigest },
    delta,
    cohorts: { age: final.cohorts.age, topCompanies: boundedCompanies(final.cohorts.companies) },
    quality: final.quality,
    continuity: { ...observation.continuity, fingerprints: boundedFingerprints([...fingerprints, ...(observation.identityHashes || [])]) },
  };
  report.digest = digestDocument(report);
  return report;
}

export function finalizeTranslationObservabilityReport(report, finalCommit) {
  const copy = structuredClone(report);
  copy.finalCommit = finalCommit || null;
  delete copy.digest;
  copy.digest = digestDocument(copy);
  const bytes = Buffer.byteLength(JSON.stringify(copy));
  if (bytes > 1_048_576) throw new RangeError(`Translation observability report exceeds 1 MiB (${bytes} bytes)`);
  return copy;
}
