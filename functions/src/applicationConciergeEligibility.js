import { requirementLanguageCodes } from './lib/requirementLanguageCodes.js';
import { qualificationCounterContext, qualificationCounterContextHash } from './lib/qualificationCounterContext.js';
/** Full-posting qualification before a concierge proposal is published. All caches are owner-private. */
import { createHash } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { timestampMillis, serviceIsActive, acceptedPositionsCount, APPLICATION_CONCIERGE_MAX_POSITIONS } from './applicationConciergeConstants.js';
import { timestampMillis as strictTimestampMillis } from './lib/assistedApplicationRetentionPolicy.js';
import { FieldValue } from 'firebase-admin/firestore';
import { generateQualificationJson as generateJson } from './lib/qualificationGenerate.js';
import { detectCvFileType, ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import { extractCvText } from './assistedApplicationAiDocuments.js';
import { fetchJobPosting } from './assistedApplicationAiJob.js';
import { sanitizeProfile, sanitizeRequirements, sanitizeMatch, verifyQuotes } from './assistedApplicationAiDraftCore.js';
import { PROFILE_SCHEMA, PROFILE_SYSTEM_PROMPT, profileUserText, REQUIREMENTS_SCHEMA, REQUIREMENTS_SYSTEM_PROMPT,
  requirementsUserText, MATCH_SCHEMA, matchSystemPrompt, matchUserText } from './assistedApplicationAiPrompts.js';
import { guardMobilityMatch } from './lib/mobilityRequirements.js';
import { conciergeProposalEligibility } from './assistedApplicationFitNotice.js';
import { languageAnswerSourceConflicts } from './lib/answerSourceConflicts.js';
import { currentJobLanguageEvidence } from './lib/currentJobLanguageEvidence.js';
import { projectAttestedLanguageFacts } from './lib/attestedLanguageProjection.js';
import { SOURCE_CITATIONS_VERSION, citationSchema, resolveCitations } from './lib/sourceCitations.js';
import { EVIDENCE_ENTAILMENT_VERSION, EVIDENCE_ENTAILMENT_PROMPT_HASH, qualificationSources,
  verifyQualificationEvidence, verifiedQualificationAnswerIds, hasVerifiedQualificationEvidence } from './lib/qualificationEvidence.js';
import { loadCandidateAnswerEvidence } from './assistedApplicationAnswerEvidence.js';

export const CONCIERGE_ELIGIBILITY_VERSION = `full-posting-requirements-v5-${SOURCE_CITATIONS_VERSION}-${EVIDENCE_ENTAILMENT_VERSION}-${EVIDENCE_ENTAILMENT_PROMPT_HASH}`;
export const eligibilityHash = value => createHash('sha256').update(value).digest('hex');
const sourceHash = value => eligibilityHash(String(value || '').replace(/\s+/g, ' ').trim());
const PROMPT_VERSION = eligibilityHash([PROFILE_SYSTEM_PROMPT, REQUIREMENTS_SYSTEM_PROMPT, matchSystemPrompt('it')].join('\n'));
const PREFLIGHT_ANALYSIS_BUDGET_MS = 90_000; // The 120s checkout also needs time for its transaction and Stripe.

const serviceSourceMaterial = service => ({ userId: service?.userId ?? null, cvStorageKey: service?.cvStorageKey ?? null,
  cvUploadedAt: strictTimestampMillis(service?.cvUploadedAt), candidateNotes: service?.candidateNotes ?? null,
  applicantLocation: service?.applicantLocation ?? null, locale: service?.locale ?? null });
const profileSourceMaterial = record => ({ status: record?.status ?? null, profile: record?.profile ?? null,
  cvStorageKey: record?.cvStorageKey ?? null, cvHash: record?.cvHash ?? null });
const sourceChanged = () => Object.assign(new Error('evidence_source_changed'), { code: 'evidence_source_changed' });

/** Private capability; never serialized into a cached result or a model request. */
function conciergePublicationGuard({ db, serviceRef, service, expected, source, cvHash }) {
  const profileRef = db.collection('user_cv_profiles').doc(String(service.userId));
  return Object.freeze({
    fingerprint: qualificationCounterContextHash({ source: source.sourceFingerprint, expected, cvHash }),
    async assertInTransaction(tx) {
      if (typeof source.assertInTransaction !== 'function' || !/^[a-f0-9]{64}$/.test(source.sourceFingerprint || '')) throw sourceChanged();
      const [currentService, currentProfile] = await Promise.all([tx.get(serviceRef), tx.get(profileRef)]);
      if (!currentService.exists || qualificationCounterContextHash({ service: serviceSourceMaterial(currentService.data()),
        profile: profileSourceMaterial(currentProfile.data()) }) !== expected) throw sourceChanged();
      // The same FACT recipe fences origin notes/clear/retention and the global pointer.
      await source.assertInTransaction(tx);
      const current = currentService.data();
      // No awaited work follows the service window/cap check.
      if (!serviceIsActive(current, Date.now()) || acceptedPositionsCount(current) >= (Number(current.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS)) throw sourceChanged();
    },
  });
}

function withPublicationGuard(result, guard) {
  return Object.defineProperty(result, 'publicationGuard', { value: guard, enumerable: false });
}

export function normalizeConciergeJobRecord(job = {}) {
  return {
    ...job,
    id: job.id || job.jobId || '',
    url: job.url || job.jobUrl || job.applyUrl || job.canonicalUrl || '',
    title: job.title || job.jobTitle || '',
    company: job.company || job.companyName || '',
    location: job.location || '',
  };
}

async function beforeCancellation(operation, signal) {
  if (!signal) return operation();
  signal.throwIfAborted();
  let abort;
  const cancellation = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation(), cancellation]); }
  finally { signal.removeEventListener('abort', abort); }
}

function profileForEligibility(profile = {}) {
  return {
    ...profile,
    // The private CV projection stores language names as strings, while the
    // full matcher profile stores { language, level } rows. Keep both sources
    // on the same shape before the shared language guard runs.
    languages: Array.isArray(profile.languages)
      ? profile.languages.map((item) => typeof item === 'string' ? { language: item, level: '' } : item).filter(Boolean)
      : [],
  };
}

export async function evaluateConciergePosting({ job, profile, answers = {}, answerEvidence = [], answerCounterContext = [], answerSourceConflicts = [], rawCounterContext = null, locale = 'it', sourceText = '', cvHash = '', generate = generateJson, readPosting = fetchJobPosting }) {
  // The later row witness and job-only reassessment must read the same owned Q/A units.
  answerEvidence = structuredClone(answerEvidence);
  if (!sourceText) {
    const deadline = AbortSignal.timeout(PREFLIGHT_ANALYSIS_BUDGET_MS);
    const inference = generate; const read = readPosting;
    generate = (system, user, schema, options = {}) => beforeCancellation(
      () => inference(system, user, schema, { ...options, signal: deadline }), deadline);
    readPosting = (order, options) => beforeCancellation(() => read(order, { ...options, signal: deadline }), deadline);
  }
  job = normalizeConciergeJobRecord(job);
  const posting = await readPosting({ jobId: job.id, jobUrl: job.url }, { maxPostingChars: 30_000 });
  if (!posting.text || posting.text.length < 100 || posting.textTruncated) return { status: 'unverified', reason: 'posting_incomplete' };
  const postingHash = sourceHash(posting.text);
  const raw = await generate(REQUIREMENTS_SYSTEM_PROMPT, requirementsUserText({ jobTitle: job.title, companyName: job.company,
    location: posting.location || job.location, postingText: posting.text }), REQUIREMENTS_SCHEMA);
  if (!Array.isArray(raw.requirements) || !raw.requirements.length || raw.requirements.length > 12) return { status: 'unverified', reason: 'requirements_incomplete' };
  const requirements = verifyQuotes(sanitizeRequirements(raw), posting.text);
  const projected = projectAttestedLanguageFacts({ profile: profileForEligibility(profile), answerEvidence, currentCvHash: cvHash });
  const scoped = currentJobLanguageEvidence({ profile: projected.profile, answerEvidence, currentCvHash: cvHash, job });
  const conflictedLanguages = new Set([...projected.conflicts, ...scoped.conflicts].map(conflict => conflict.languageCode));
  if (requirements.requirements.some(row => languageAnswerSourceConflicts({ text: row.quote || row.requirement, languageCodes: requirementLanguageCodes(requirements, row), answerSourceConflicts, currentCvHash: cvHash }).length)) {
    return { status: 'unverified', reason: 'answer_source_conflict', gaps: [], questions: [] };
  }
  if (requirements.requirements.some(row => requirementLanguageCodes(requirements, row).some(code => conflictedLanguages.has(code)))) {
    return { status: 'unverified', reason: 'language_evidence_conflict', gaps: [], questions: [] };
  }
  const normalizedProfile = scoped.profile;
  const evidenceText = sourceText || JSON.stringify(normalizedProfile);
  const sources = qualificationSources({ sourceText, profile: normalizedProfile, answers, answerEvidence });
  const candidateSources = sources.citations;
  const matchRaw = await generate(matchSystemPrompt(locale), matchUserText({ profile: normalizedProfile, requirements, answers: sources.modelAnswers,
    postingExcerpt: posting.text, candidateSourceExcerpts: candidateSources.excerpts }), citationSchema(MATCH_SCHEMA, 'matches', 'evidence', candidateSources));
  const match = guardMobilityMatch(requirements, sanitizeMatch(resolveCitations(matchRaw, 'matches', 'evidence', candidateSources), requirements.requirements.length, sources.verificationText),
    { profile: normalizedProfile, sourceText: evidenceText, answers, memory: answers, locale });
  const preliminary = conciergeProposalEligibility(requirements, match, { profile: normalizedProfile, answers });
  const checked = await verifyQualificationEvidence({ requirements, match, rawMatch: matchRaw, sources, preliminary, generate,
    unverifiedContext: qualificationCounterContext({ flow: { answers }, answerCounterContext, rawCounterContext }) });
  let assessed = preliminary;
  if (checked.status === 'supported' && scoped.deferredCodes.length) {
    const indexes = requirements.requirements.flatMap((row, index) => requirementLanguageCodes(requirements, row).some(code => scoped.deferredCodes.includes(code)) ? [index] : []);
    const verifiedAnswerIds = verifiedQualificationAnswerIds({ requirements, match, rawMatch: matchRaw, sources, verification: checked.verification, indexes });
    const resolved = currentJobLanguageEvidence({ profile: projected.profile, answerEvidence, currentCvHash: cvHash, job, verifiedAnswerIds });
    if (resolved.conflicts.some(conflict => requirements.requirements.some(row => requirementLanguageCodes(requirements, row).includes(conflict.languageCode)))) {
      assessed = { status: 'unverified', reason: 'language_evidence_conflict', gaps: [], questions: [] };
    } else assessed = conciergeProposalEligibility(requirements, checked.assessment?.match || match, { profile: resolved.profile, answers });
  }
  const scopedLanguageUnresolved = assessed.gaps?.some(gap => requirementLanguageCodes(requirements, requirements.requirements[gap.index]).some(code => scoped.deferredCodes.includes(code)));
  const result = checked.status === 'unverified' ? { status: 'unverified', reason: checked.reason, gaps: [], questions: [] }
    : scopedLanguageUnresolved && !assessed.gaps.some(gap => gap.knownMissing) ? { status: 'unverified', reason: 'job_language_evidence_unverified', gaps: [], questions: [] } : assessed;
  const entailment = checked.verification || { version: EVIDENCE_ENTAILMENT_VERSION, status: 'not_required' };
  return { ...result, postingHash, requirements: checked.assessment?.requirements || requirements,
    match: checked.assessment?.match || match, posting, entailment };
}

export async function prepareConciergeEligibility({ db, serviceRef, service, profileRecord, bucket = null, generate = null, readPosting = fetchJobPosting, background = false, signal = null }) {
  // Normalize SDK timestamp semantics before owning the runtime data. The raw
  // attested ledger stays with its existing provider/fence snapshot recipe.
  const sourceBaseline = qualificationCounterContextHash({ service: serviceSourceMaterial(service), profile: profileSourceMaterial(profileRecord) });
  service = structuredClone({ ...service, cvUploadedAt: strictTimestampMillis(service.cvUploadedAt),
    paidAt: strictTimestampMillis(service.paidAt), expiresAt: strictTimestampMillis(service.expiresAt) });
  const generation = generate || ((system, user, schema, options = {}) => generateJson(system, user, schema, { ...options, background, signal }));
  generate = (...args) => beforeCancellation(() => generation(...args), signal);
  const read = (order, options) => beforeCancellation(() => readPosting(order, { ...options, ...(signal ? { signal } : {}) }), signal);
  signal?.throwIfAborted();
  if (!String(service.cvStorageKey || '').startsWith(`application-concierge-uploads/${serviceRef.id}/`)) throw new Error('eligibility_cv_owner_mismatch');
  const storage = bucket || getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
  const file = storage.file(service.cvStorageKey);
  const [metadata] = await beforeCancellation(() => file.getMetadata(), signal);
  if (Number(metadata.size) > 12 * 1024 * 1024) throw new Error('eligibility_cv_too_large');
  const [bytes] = await beforeCancellation(() => file.download(), signal);
  const cvHash = eligibilityHash(bytes);
  const type = detectCvFileType(bytes.subarray(0, 8));
  const cvText = type ? await beforeCancellation(() => extractCvText(bytes, type), signal) : '';
  if (cvText.length < 80 || cvText.length > 60_000) throw new Error('eligibility_cv_unreadable');
  const cache = serviceRef.collection('eligibility');
  const purgeAt = new Date((timestampMillis(service.cvUploadedAt) || timestampMillis(service.paidAt) || Date.now()) + 90 * 86400000);
  await serviceRef.set({ eligibilityPurgeAt: purgeAt }, { merge: true });
  const profileRef = cache.doc('profile');
  const previousProfile = (await profileRef.get()).data();
  let profile;
  if (previousProfile?.cvHash === cvHash && previousProfile.promptVersion === PROMPT_VERSION) profile = previousProfile.profile;
  else {
    const raw = await generate(PROFILE_SYSTEM_PROMPT, profileUserText(cvText), PROFILE_SCHEMA);
    if (!Array.isArray(raw.languages) || !Array.isArray(raw.experience)) throw new Error('eligibility_profile_incomplete');
    profile = sanitizeProfile(raw, { cvText });
    await profileRef.set({ cvHash, promptVersion: PROMPT_VERSION, profile, updatedAt: FieldValue.serverTimestamp() });
  }
  const answerContextFor = await beforeCancellation(() => loadCandidateAnswerEvidence({ db, profileRecord, userId: service.userId }), signal);
  let analyses = 0;
  return async (job) => {
    job = normalizeConciergeJobRecord(job);
    const source = answerContextFor(job);
    const { answers, answerEvidence, answerCounterContext, answerSourceConflicts, rawCounterAnswers, fingerprint: answerContext } = source;
    const publicationGuard = conciergePublicationGuard({ db, serviceRef, service, expected: sourceBaseline, source, cvHash });
    const rawCounterContext = qualificationCounterContext({ order: service, flow: { questionAnswers: rawCounterAnswers }, answerCounterContext });
    const answerHash = eligibilityHash(JSON.stringify([answerContext, qualificationCounterContextHash(rawCounterContext)]));
    const normalizedProfile = profileForEligibility(profile);
    if (signal?.aborted) return { status: 'unverified', reason: 'analysis_deferred' };
    const posting = await read({ jobId: job.id, jobUrl: job.url }, { maxPostingChars: 30_000 });
    if (!posting.text || posting.text.length < 100 || posting.textTruncated) return { status: 'unverified', reason: 'posting_incomplete' };
    const postingHash = sourceHash(posting.text);
    const postingMetadata = [job.title, job.company, posting.location || job.location].map(value => String(value || '').trim().replace(/\s+/g, ' '));
    const fingerprint = eligibilityHash([cvHash, answerHash, postingHash, ...postingMetadata, PROMPT_VERSION, CONCIERGE_ELIGIBILITY_VERSION].join('|'));
    const cacheId = `job-${eligibilityHash(String(job.id || job.url)).slice(0, 32)}`;
    const ref = cache.doc(cacheId);
    const cached = (await ref.get()).data();
    if (cached?.fingerprint === fingerprint && cached.version === CONCIERGE_ELIGIBILITY_VERSION
      && hasVerifiedQualificationEvidence(cached)) {
      try { await db.runTransaction(tx => publicationGuard.assertInTransaction(tx)); }
      catch (error) { if (error?.code === 'evidence_source_changed') return { status: 'unverified', reason: 'evidence_source_changed', fingerprint, cacheId }; throw error; }
      return withPublicationGuard({ ...cached.result, fingerprint, cacheId }, publicationGuard);
    }
    if (analyses >= 20) return { status: 'unverified', reason: 'analysis_deferred' };
    analyses += 1;
    const analysis = await evaluateConciergePosting({ job, profile: normalizedProfile, answers, answerEvidence, answerCounterContext, answerSourceConflicts, rawCounterContext, locale: service.locale, sourceText: cvText, cvHash, generate,

      readPosting: async () => posting });
    // A cancelled verifier is still budget-deferred work, not an ordinary
    // technical retry that advances discovery past an unfinished assessment.
    signal?.throwIfAborted();
    const { postingHash: _analysisPostingHash, requirements, match, posting: _analysisPosting, entailment, ...result } = analysis;
    // Unknown sources and incomplete responses are retried, never cached as a positive result.
    if (result.status !== 'unverified') {
      const cachedAssessment = { fingerprint, cvHash, answerHash, postingHash, promptVersion: PROMPT_VERSION,
        version: CONCIERGE_ELIGIBILITY_VERSION, profile, requirements, match, result, entailment, updatedAt: FieldValue.serverTimestamp() };
      try {
        await db.runTransaction(async tx => {
          await publicationGuard.assertInTransaction(tx);
          tx.set(ref, cachedAssessment);
        });
      } catch (error) { if (error?.code === 'evidence_source_changed') return { status: 'unverified', reason: 'evidence_source_changed', fingerprint, cacheId }; throw error; }
    }
    return withPublicationGuard({ ...result, fingerprint, cacheId }, publicationGuard);
  };
}

/**
 * Check a one-off application against the same full-posting criterion used by
 * concierge proposals, but only when a ready private CV projection already
 * exists. Missing or stale projections remain unknown so the paid flow can
 * continue to the normal post-payment review instead of rejecting a user on
 * incomplete evidence.
 */
export async function preflightExistingCvEligibility({ db, userId, job, generate = generateJson, readPosting = fetchJobPosting }) {
  if (!db || !userId) return { status: 'unverified', reason: 'profile_unavailable' };
  const snapshot = await db.collection('user_cv_profiles').doc(String(userId)).get();
  const record = snapshot.exists ? snapshot.data() || {} : null;
  if (!record || record.status !== 'ready' || !record.profile || record.profile.extractedTextAvailable === false) {
    return { status: 'unverified', reason: 'profile_not_ready' };
  }
  const contextFor = await loadCandidateAnswerEvidence({ db, profileRecord: record, userId });
  const { answers, answerEvidence, answerCounterContext, answerSourceConflicts, rawCounterAnswers } = contextFor(normalizeConciergeJobRecord(job));
  const rawCounterContext = qualificationCounterContext({ flow: { questionAnswers: rawCounterAnswers }, answerCounterContext });
  const result = await evaluateConciergePosting({
    job,
    profile: record.profile,
    answers,
    answerEvidence,
    answerCounterContext,
    answerSourceConflicts,
    rawCounterContext,
    locale: record.locale || 'it',
    generate,
    readPosting,
  });
  return {
    status: result.status,
    reason: result.reason || null,
    gaps: Array.isArray(result.gaps) ? result.gaps.slice(0, 3).map((gap) => ({
      requirement: String(gap.requirement || '').slice(0, 200),
      quote: String(gap.quote || '').slice(0, 300),
      status: String(gap.status || 'unknown').slice(0, 20),
    })) : [],
  };
}

/** The application writer reuses the exact qualification only while its original sources are unchanged. */
export async function vettedConciergeDraftInputs({ db, order, cvBuffer, postingText }) {
  if (!order.parentServiceId || !order.parentProposalId) return null;
  const serviceRef = db.collection('application_concierge_services').doc(order.parentServiceId);
  const [serviceDoc, proposalDoc, profileDoc] = await Promise.all([serviceRef.get(), serviceRef.collection('proposals').doc(order.parentProposalId).get(), db.collection('user_cv_profiles').doc(order.userId).get()]);
  const proposal = proposalDoc.data();
  if (serviceDoc.data()?.userId !== order.userId || !/^job-[a-f0-9]{32}$/.test(proposal?.eligibilityCacheId || '')) return null;
  const cached = (await serviceRef.collection('eligibility').doc(proposal.eligibilityCacheId).get()).data();
  const answerContextFor = await loadCandidateAnswerEvidence({ db, profileRecord: profileDoc.data() || {}, userId: order.userId });
  const context = answerContextFor({ id: order.jobId || proposal.jobId, url: order.jobUrl || proposal.jobUrl });
  const rawCounterContext = qualificationCounterContext({ order: serviceDoc.data() || {}, flow: { questionAnswers: context.rawCounterAnswers }, answerCounterContext: context.answerCounterContext });
  const answerHash = eligibilityHash(JSON.stringify([context.fingerprint, qualificationCounterContextHash(rawCounterContext)]));
  if (cached?.result?.status !== 'compatible' || cached.promptVersion !== PROMPT_VERSION || cached.version !== CONCIERGE_ELIGIBILITY_VERSION
    || !hasVerifiedQualificationEvidence(cached)
    || cached.fingerprint !== proposal.eligibilityFingerprint || cached.cvHash !== eligibilityHash(cvBuffer)
    || cached.postingHash !== sourceHash(postingText) || cached.answerHash !== answerHash) return null;
  return cached;
}


/** Remove private qualification caches after the existing 90-day application data window. */
export async function purgeConciergeEligibility({ db, nowMs = Date.now() }) {
  const services = await db.collection('application_concierge_services').where('eligibilityPurgeAt', '<=', new Date(nowMs)).limit(100).get();
  let deleted = 0;
  for (const service of services.docs || []) {
    const cache = await service.ref.collection('eligibility').get();
    for (let start = 0; start < cache.docs.length; start += 400) {
      const batch = db.batch();
      for (const document of cache.docs.slice(start, start + 400)) batch.delete(document.ref);
      await batch.commit();
      deleted += Math.min(400, cache.docs.length - start);
    }
    await service.ref.set({ eligibilityPurgeAt: FieldValue.delete(), eligibilityPurgedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return { deleted };
}
