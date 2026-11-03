/** Full-posting qualification before a concierge proposal is published. All caches are owner-private. */
import { createHash } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import {
  APPLICATION_CONCIERGE_CANDIDATE_ANSWERS_VERSION,
  APPLICATION_CONCIERGE_CANDIDATE_LANGUAGES_VERSION,
  timestampMillis,
} from './applicationConciergeConstants.js';
import { FieldValue } from 'firebase-admin/firestore';
import { generateServerText } from './geminiGenerate.js';
import { detectCvFileType, ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import { extractCvText, MAX_CV_SOURCE_BYTES } from './assistedApplicationAiDocuments.js';
import { fetchJobPosting } from './assistedApplicationAiJob.js';
import { sanitizeProfile, sanitizeRequirements, sanitizeMatch, verifyQuotes, hasUncoveredHardEligibilityStatements,
  hasUnverifiedCurrentStudentEligibility } from './assistedApplicationAiDraftCore.js';
import { PROFILE_SCHEMA, PROFILE_SYSTEM_PROMPT, profileUserText, REQUIREMENTS_SCHEMA, REQUIREMENTS_SYSTEM_PROMPT,
  requirementsUserText, MATCH_SCHEMA, matchSystemPrompt, matchUserText } from './assistedApplicationAiPrompts.js';
import { guardMobilityMatch } from './lib/mobilityRequirements.js';
import { conciergeProposalEligibility, hasUncoveredLanguageRequirements } from './assistedApplicationFitNotice.js';
import { isLanguageAbilityQuestion, languageCodeOf } from './lib/languageFacts.js';
import { SOURCE_CITATIONS_VERSION, sourceCitations, candidateConfirmedEvidenceSources, citationSchema, resolveCitations } from './lib/sourceCitations.js';

export const CONCIERGE_ELIGIBILITY_VERSION = `full-posting-requirements-v7-${SOURCE_CITATIONS_VERSION}`;
export const CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID = 'candidate-language-facts';
export const eligibilityHash = value => createHash('sha256').update(value).digest('hex');
export const candidateAnswersDocumentId = cacheId => `candidate-answers-${String(cacheId || '').slice(0, 60)}`;
const sourceHash = value => eligibilityHash(String(value || '').replace(/\s+/g, ' ').trim());
const PROMPT_VERSION = eligibilityHash([PROFILE_SYSTEM_PROMPT, REQUIREMENTS_SYSTEM_PROMPT, matchSystemPrompt('it')].join('\n'));
const ELIGIBILITY_METADATA_FIELDS = ['title', 'company', 'location', 'category', 'sector', 'description', 'requirements', 'education',
  'employmentType', 'jobType', 'contractType', 'experience', 'experienceLevel'];
const MAX_ELIGIBILITY_METADATA_VALUE_CHARS = 4_000;
const MAX_ELIGIBILITY_METADATA_CHARS = 16_000;
const MAX_ELIGIBILITY_METADATA_ENTRIES = 64;

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

function eligibilityMetadata(job, postingLocation = '') {
  const values = [];
  let totalChars = 0;
  let inspectedValues = 0;
  let truncated = false;
  const append = (field, value) => {
    if (typeof value !== 'string') return true;
    if (value.length > MAX_ELIGIBILITY_METADATA_VALUE_CHARS) {
      truncated = true;
      return false;
    }
    if (!value.trim()) return true;
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return true;
    const entry = { field, value: normalized };
    const entryChars = `${field}: ${normalized}`.length + 2;
    if (totalChars + entryChars > MAX_ELIGIBILITY_METADATA_CHARS) {
      truncated = true;
      return false;
    }
    values.push(entry);
    totalChars += entryChars;
    return true;
  };

  for (const field of ELIGIBILITY_METADATA_FIELDS) {
    const raw = job[field];
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (inspectedValues >= MAX_ELIGIBILITY_METADATA_ENTRIES) return { values, truncated: true };
      inspectedValues += 1;
      if (!append(field, value)) return { values, truncated };
    }
  }
  append('posting.location', postingLocation);
  return { values, truncated };
}

/** Keep quote verification on original source values; labels are prompt context, not source evidence. */
function eligibilityEvidenceText(metadata, postingText, { includeLabels = false } = {}) {
  const metadataValues = metadata.values.map(({ field, value }) => includeLabels ? `${field}: ${value}` : value);
  return [...metadataValues, String(postingText || '')].filter(Boolean).join('\n\n');
}

async function generateJson(systemPrompt, userPrompt, schema, options = {}) {
  const response = await generateServerText({ systemPrompt: `${systemPrompt}\nReturn ONLY valid JSON matching this schema:\n${JSON.stringify(schema)}`,
    userPrompt, maxTokens: 8192, temperature: 0, maxProviderAttempts: 3,
    // The final Codex rung is separately time-bounded and uses server-side Remote Config auth.
    allowCodexFallback: true, ...options });
  options.signal?.throwIfAborted();
  if (!response.body?.ok) {
    const error = new Error('eligibility_provider_unavailable');
    if (Array.isArray(response.body?.providerFailures)) error.providerFailures = response.body.providerFailures;
    throw error;
  }
  const text = response.body.text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error('eligibility_invalid_json'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('eligibility_invalid_json');
  return result;
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

function profileForEligibility(profile = {}, languageFacts = null) {
  const cvLanguages = Array.isArray(profile.languages) ? profile.languages : [];
  const cvLanguageRows = cvLanguages.map((item) => typeof item === 'string' ? { language: item, level: '' } : item).filter(Boolean);
  const candidateConfirmed = languageFacts?.provenance === 'candidate_confirmed'
    && languageFacts?.schemaVersion === APPLICATION_CONCIERGE_CANDIDATE_LANGUAGES_VERSION
    && timestampMillis(languageFacts?.confirmedAt) > 0
    && Array.isArray(languageFacts?.languages);
  if (!candidateConfirmed) {
    return {
      ...profile,
      languages: cvLanguageRows,
      // CV extraction can describe languages it found, but it cannot prove
      // that the candidate's complete spoken-language list was supplied.
      languagesExplicitList: false,
      languagesListTruncated: false,
      candidateLanguagesConfirmed: false,
    };
  }
  const declaredRows = languageFacts.languages.map(item => ({
    language: String(item?.languageCode || '').toLowerCase(),
    level: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(String(item?.level || ''))
      ? String(item.level)
      : item?.level === 'native' ? 'native' : '',
  })).filter(item => item.language);
  const declaredCodes = new Set(declaredRows.map(item => languageCodeOf(item.language)).filter(Boolean));
  // A candidate-confirmed complete list is authoritative, including an empty
  // list. CV extraction may supplement an explicitly incomplete declaration,
  // but must not silently add entries the candidate omitted from a complete one.
  const languages = languageFacts.listComplete === true
    ? declaredRows
    : [...declaredRows, ...cvLanguageRows.filter(item => !declaredCodes.has(languageCodeOf(item.language)))];
  return {
    ...profile,
    languages,
    languagesExplicitList: languageFacts.listComplete === true,
    languagesListTruncated: false,
    candidateLanguagesConfirmed: true,
  };
}

function candidateQuestionSetHash(questions) {
  const required = (Array.isArray(questions) ? questions : [])
    .filter(question => question?.required === true && question?.id && question?.question)
    .slice(0, 6)
    .map(question => {
      const bounded = (value, max) => {
        const result = String(value ?? '').trim();
        return result && result.length <= max ? result : '';
      };
      return [bounded(question.id, 60), bounded(question.question, 300)];
    });
  return required.length ? eligibilityHash(JSON.stringify(required)) : '';
}

function verifiedCandidateAnswers(record, cacheId, expectedQuestionSetHash) {
  if (record?.provenance !== 'candidate_confirmed'
    || record?.schemaVersion !== APPLICATION_CONCIERGE_CANDIDATE_ANSWERS_VERSION
    || record?.cacheId !== cacheId
    || !expectedQuestionSetHash
    || record?.questionSetHash !== expectedQuestionSetHash
    || timestampMillis(record?.confirmedAt) <= 0) return { answers: {}, entries: [], record: null };
  const entries = [];
  for (const item of Array.isArray(record.answers) ? record.answers : []) {
    const id = String(item?.questionId || '');
    const question = String(item?.question || '').trim().slice(0, 300);
    const answer = String(item?.answer || '').trim().slice(0, 500);
    if (!id || !question || !answer) continue;
    entries.push({ questionId: id, question, answer });
  }
  return {
    answers: Object.fromEntries(entries.map(item => [item.questionId, item.answer])),
    entries,
    record: entries.length ? { ...record, answers: entries } : null,
  };
}

function questionsNeedCandidateFacts(requirements) {
  return (Array.isArray(requirements?.languageRequirements) && requirements.languageRequirements.length > 0)
    || (Array.isArray(requirements?.requirements) && requirements.requirements.some(item =>
      isLanguageAbilityQuestion(`${item?.requirement || ''} ${item?.quote || ''}`)));
}

function candidateFactsDependency(requirements, cached = null, result = null) {
  const questions = Array.isArray(result?.questions) ? result.questions
    : Array.isArray(cached?.result?.questions) ? cached.result.questions : [];
  return {
    languages: questionsNeedCandidateFacts(requirements),
    answers: Boolean(cached?.candidateAnswerQuestionSetHash || questions.some(question => question?.required === true)),
  };
}

async function evaluateConciergePosting({ job, profile, languageFacts = null, answers = {}, typedAnswerRecord = null,
  locale = 'it', sourceText = '', generate = generateJson, readPosting = fetchJobPosting, metadata = null,
  suppliedRequirements = null }) {
  job = normalizeConciergeJobRecord(job);
  const posting = await readPosting({ jobId: job.id, jobUrl: job.url }, { maxPostingChars: 30_000 });
  if (typeof posting?.text !== 'string' || !posting.text) {
    return { status: 'unverified', reason: !posting || posting.source === 'none' ? 'posting_unavailable' : 'posting_incomplete' };
  }
  if (posting.text.length < 100 || posting.textTruncated) return { status: 'unverified', reason: 'posting_incomplete' };
  metadata = metadata || eligibilityMetadata(job, posting.location);
  if (metadata.truncated) return { status: 'unverified', reason: 'eligibility_metadata_incomplete', gaps: [] };
  const postingHash = sourceHash(posting.text);
  const eligibilityEvidence = eligibilityEvidenceText(metadata, posting.text);
  const eligibilityPromptText = eligibilityEvidenceText(metadata, posting.text, { includeLabels: true });
  let requirements = suppliedRequirements;
  if (!requirements) {
    const raw = await generate(REQUIREMENTS_SYSTEM_PROMPT, requirementsUserText({ jobTitle: job.title, companyName: job.company,
      location: posting.location || job.location, postingText: eligibilityPromptText }), REQUIREMENTS_SCHEMA);
    if (!Array.isArray(raw.requirements)) return { status: 'unverified', reason: 'requirements_response_invalid', gaps: [] };
    if (raw.requirements.length > 12) return { status: 'unverified', reason: 'requirements_over_limit', gaps: [] };
    if (!raw.requirements.length) return { status: 'unverified', reason: 'requirements_missing', gaps: [] };
    requirements = verifyQuotes(sanitizeRequirements(raw), eligibilityEvidence);
  }
  if (!requirements.requirements.length) return { status: 'unverified', reason: 'requirements_missing', gaps: [] };
  if (hasUncoveredLanguageRequirements(requirements)) return { status: 'unverified', reason: 'language_requirement_uncovered', gaps: [] };
  if (hasUncoveredHardEligibilityStatements(requirements, eligibilityEvidence)) {
    return { status: 'unverified', reason: 'hard_requirement_uncovered', gaps: [] };
  }
  const normalizedProfile = profileForEligibility(profile, languageFacts);
  const evidenceText = sourceText || JSON.stringify(normalizedProfile);
  const typedSources = candidateConfirmedEvidenceSources({ languageFacts, answers: typedAnswerRecord });
  const candidateSources = sourceCitations({ cv: evidenceText, ...typedSources });
  const candidateEvidenceText = Object.values(typedSources).join('\n');
  let matchRaw;
  try {
    matchRaw = await generate(matchSystemPrompt(locale), matchUserText({ profile: normalizedProfile, requirements, answers,
      postingExcerpt: posting.text, candidateSourceExcerpts: candidateSources.excerpts }), citationSchema(MATCH_SCHEMA, 'matches', 'evidence', candidateSources));
  } catch (error) {
    if (error && typeof error === 'object') {
      error.candidateFactsDependency = candidateFactsDependency(requirements,
        { candidateAnswerQuestionSetHash: typedAnswerRecord?.questionSetHash || '' });
    }
    throw error;
  }
  const match = guardMobilityMatch(requirements, sanitizeMatch(resolveCitations(matchRaw, 'matches', 'evidence', candidateSources),
    requirements.requirements.length, `${evidenceText}\n${candidateEvidenceText}\n${JSON.stringify(answers)}`),
    { profile: normalizedProfile, sourceText: `${evidenceText}\n${candidateEvidenceText}`, answers, memory: answers, locale });
  if (hasUnverifiedCurrentStudentEligibility(eligibilityEvidence, normalizedProfile, sourceText)) {
    return { status: 'unverified', reason: 'current_education_unverified', gaps: [], postingHash, requirements, match, posting };
  }
  const result = conciergeProposalEligibility(requirements, match, { profile: normalizedProfile, answers });
  if (result.status === 'clarification_required' && !(Array.isArray(result.questions) && result.questions.some(question => question?.required === true))) {
    return { status: 'unverified', reason: 'clarification_questions_missing', gaps: [], postingHash, requirements, match, posting };
  }
  return { ...result, postingHash, requirements, match, posting };
}

export async function prepareConciergeEligibility({ db, serviceRef, service, profileRecord, bucket = null, generate = null, readPosting = fetchJobPosting, background = false, signal = null }) {
  const generation = generate || ((system, user, schema) => generateJson(system, user, schema, { background, signal }));
  generate = (...args) => beforeCancellation(() => generation(...args), signal);
  const read = (order, options) => beforeCancellation(() => readPosting(order, { ...options, ...(signal ? { signal } : {}) }), signal);
  signal?.throwIfAborted();
  if (!String(service.cvStorageKey || '').startsWith(`application-concierge-uploads/${serviceRef.id}/`)) throw new Error('eligibility_cv_owner_mismatch');
  const storage = bucket || getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
  const file = storage.file(service.cvStorageKey);
  const [metadata] = await beforeCancellation(() => file.getMetadata(), signal);
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CV_SOURCE_BYTES) throw new Error('eligibility_cv_too_large');
  const [bytes] = await beforeCancellation(() => file.download(), signal);
  const cvHash = eligibilityHash(bytes);
  const type = detectCvFileType(bytes.subarray(0, 8));
  const cvText = type ? await beforeCancellation(() => extractCvText(bytes, type, { signal }), signal) : '';
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
  // Legacy answer maps have no typed provenance and may be specific to a
  // different employer or application. Candidate declarations stay scoped to
  // this service and candidate answers stay scoped to their exact listing.
  const languageFactsRecord = (await cache.doc(CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID).get()).data() || null;
  const candidateLanguageFacts = profileForEligibility(profile, languageFactsRecord).candidateLanguagesConfirmed
    ? languageFactsRecord
    : null;
  const languageFactsHash = candidateLanguageFacts ? eligibilityHash(JSON.stringify({
    schemaVersion: candidateLanguageFacts.schemaVersion,
    listComplete: candidateLanguageFacts.listComplete === true,
    languages: (Array.isArray(candidateLanguageFacts.languages) ? candidateLanguageFacts.languages : [])
      .map(item => [String(item?.languageCode || '').toLowerCase(), String(item?.level || 'unknown')]),
  })) : '';
  const emptyAnswerHash = eligibilityHash('{}');
  let analyses = 0;
  const postingPrefetches = new Map();
  const postingReadKey = job => `${job.id}\0${job.url}`;
  const postingReadOptions = { maxPostingChars: 30_000, ...(signal ? { signal } : {}) };
  const readPostingResult = job => {
    let reading;
    try { reading = read({ jobId: job.id, jobUrl: job.url }, postingReadOptions); }
    catch (error) { return Promise.resolve({ error }); }
    return Promise.resolve(reading).then(posting => ({ posting }), error => ({ error }));
  };
  const readPostingForFingerprint = job => {
    const key = postingReadKey(job);
    if (!postingPrefetches.has(key)) postingPrefetches.set(key, readPostingResult(job));
    return postingPrefetches.get(key);
  };
  const readPostingForCheck = async job => {
    const key = postingReadKey(job);
    const prefetched = postingPrefetches.get(key);
    if (prefetched) {
      postingPrefetches.delete(key);
      return prefetched;
    }
    return readPostingResult(job);
  };
  const normalizePosting = posting => !posting || typeof posting.text !== 'string'
    ? { ...posting, text: '', source: posting?.source || 'none' }
    : posting;
  const fingerprintForPosting = (job, posting) => {
    const metadata = eligibilityMetadata(job, posting.location);
    const postingHash = sourceHash(posting.text);
    const eligibilityMetadataHash = eligibilityHash(JSON.stringify({
      values: metadata.values,
      truncated: metadata.truncated,
      posting: {
        source: typeof posting.source === 'string' ? posting.source : '',
        textLength: posting.text.length,
        textTruncated: posting.textTruncated === true,
      },
    }));
    const sourceFingerprint = eligibilityHash([cvHash, postingHash,
      eligibilityMetadataHash, PROMPT_VERSION, CONCIERGE_ELIGIBILITY_VERSION].join('|'));
    const cacheId = `job-${eligibilityHash(String(job.id || job.url)).slice(0, 32)}`;
    return { sourceFingerprint, cacheId, metadata, postingHash };
  };
  const matchInputFor = async ({ cacheId, sourceFingerprint, cached }) => {
    const cachedRequirements = cached?.sourceFingerprint === sourceFingerprint
      && Array.isArray(cached?.requirements?.requirements)
      ? cached.requirements
      : null;
    let typedAnswers = { answers: {}, entries: [], record: null };
    if (cachedRequirements) {
      const answerDoc = await cache.doc(candidateAnswersDocumentId(cacheId)).get();
      const expectedQuestionSetHash = cached?.candidateAnswerQuestionSetHash
        || (cached?.result?.status === 'clarification_required'
          ? candidateQuestionSetHash(cached.result.questions)
          : '');
      typedAnswers = verifiedCandidateAnswers(answerDoc.data(), cacheId, expectedQuestionSetHash);
    }
    const answerHash = typedAnswers.entries.length
      ? eligibilityHash(JSON.stringify(typedAnswers.entries))
      : emptyAnswerHash;
    const usesLanguageFacts = Boolean(cachedRequirements && questionsNeedCandidateFacts(cachedRequirements));
    const appliedLanguageFactsHash = usesLanguageFacts ? languageFactsHash : '';
    const matchInputHash = eligibilityHash(JSON.stringify({
      candidateLanguageFacts: appliedLanguageFactsHash,
      candidateAnswers: answerHash,
    }));
    return {
      cachedRequirements,
      typedAnswers,
      answerHash,
      languageFactsHash: appliedLanguageFactsHash,
      matchInputHash,
      fingerprint: eligibilityHash(`${sourceFingerprint}|${matchInputHash}`),
    };
  };
  const fingerprintForJob = async job => {
    job = normalizeConciergeJobRecord(job);
    if (signal?.aborted) return null;
    const loaded = await readPostingForFingerprint(job);
    if (signal?.aborted) return null;
    if (loaded.error) return null;
    const posting = normalizePosting(loaded.posting);
    const source = fingerprintForPosting(job, posting);
    const cached = (await cache.doc(source.cacheId).get()).data();
    return (await matchInputFor({ ...source, cached })).fingerprint;
  };
  const check = async (job) => {
    job = normalizeConciergeJobRecord(job);
    if (signal?.aborted) return { status: 'unverified', reason: 'analysis_deferred' };
    const loaded = await readPostingForCheck(job);
    if (loaded.error) {
      signal?.throwIfAborted();
      const { cacheId } = fingerprintForPosting(job, { text: '', location: '' });
      return { status: 'unverified', reason: 'posting_unavailable', cacheId };
    }
    signal?.throwIfAborted();
    const posting = normalizePosting(loaded.posting);
    const { sourceFingerprint, cacheId, metadata, postingHash } = fingerprintForPosting(job, posting);
    let cached;
    let matchInput;
    const ref = cache.doc(cacheId);
    try {
      cached = (await ref.get()).data();
      matchInput = await matchInputFor({ cacheId, sourceFingerprint, cached });
    } catch (error) {
      if (error && typeof error === 'object') {
        error.eligibilityFingerprint = sourceFingerprint;
        error.eligibilitySourceFingerprint = sourceFingerprint;
        const cachedRequirements = cached?.sourceFingerprint === sourceFingerprint
          && Array.isArray(cached?.requirements?.requirements) ? cached.requirements : null;
        if (cachedRequirements) error.candidateFactsDependency = candidateFactsDependency(cachedRequirements, cached);
      }
      throw error;
    }
    let factsDependency = candidateFactsDependency(matchInput.cachedRequirements, cached);
    const withEligibilityMetadata = result => ({
      ...result,
      sourceFingerprint,
      candidateFactsDependency: factsDependency,
    });
    let fingerprint = matchInput.fingerprint;
    if (!posting.text) return withEligibilityMetadata({ status: 'unverified', reason: posting.source === 'none' ? 'posting_unavailable' : 'posting_incomplete', fingerprint, cacheId });
    if (posting.text.length < 100 || posting.textTruncated) return withEligibilityMetadata({ status: 'unverified', reason: 'posting_incomplete', fingerprint, cacheId });
    if (metadata.truncated) return withEligibilityMetadata({ status: 'unverified', reason: 'eligibility_metadata_incomplete', fingerprint, cacheId });
    if (cached?.fingerprint === fingerprint) return withEligibilityMetadata({ ...cached.result, fingerprint, cacheId });
    if (analyses >= 20) return withEligibilityMetadata({ status: 'unverified', reason: 'analysis_deferred', fingerprint, cacheId });
    analyses += 1;
    let analysis;
    try {
      analysis = await evaluateConciergePosting({ job, profile, languageFacts: candidateLanguageFacts,
        answers: matchInput.typedAnswers.answers, typedAnswerRecord: matchInput.typedAnswers.record,
        locale: service.locale, sourceText: cvText, generate, readPosting: async () => posting, metadata,
        suppliedRequirements: matchInput.cachedRequirements });
    } catch (error) {
      if (error && typeof error === 'object') {
        error.eligibilityFingerprint = fingerprint;
        error.eligibilityCacheId = cacheId;
        error.eligibilitySourceFingerprint = sourceFingerprint;
        error.candidateFactsDependency = {
          languages: factsDependency.languages === true || error.candidateFactsDependency?.languages === true,
          answers: factsDependency.answers === true || error.candidateFactsDependency?.answers === true,
        };
      }
      throw error;
    }
    const { postingHash: _analysisPostingHash, requirements, match, posting: _analysisPosting, ...result } = analysis;
    const appliedLanguageFactsHash = questionsNeedCandidateFacts(requirements) ? languageFactsHash : '';
    const finalMatchInputHash = eligibilityHash(JSON.stringify({
      candidateLanguageFacts: appliedLanguageFactsHash,
      candidateAnswers: matchInput.answerHash,
    }));
    fingerprint = eligibilityHash(`${sourceFingerprint}|${finalMatchInputHash}`);
    const candidateAnswerQuestionSetHash = result.status === 'clarification_required'
      ? candidateQuestionSetHash(result.questions)
      : matchInput.typedAnswers.record?.questionSetHash || '';
    factsDependency = candidateFactsDependency(requirements, cached, result);
    // Unknown sources and incomplete responses are retried, never cached as a positive result.
    if (result.status !== 'unverified') {
      try {
        await ref.set({ fingerprint, sourceFingerprint, matchInputHash: finalMatchInputHash,
          languageFactsHash: appliedLanguageFactsHash, candidateAnswerQuestionSetHash,
          cvHash, answerHash: matchInput.answerHash, postingHash, promptVersion: PROMPT_VERSION,
          version: CONCIERGE_ELIGIBILITY_VERSION, profile, requirements, match, result, updatedAt: FieldValue.serverTimestamp() });
      } catch (error) {
        if (error && typeof error === 'object') {
          error.eligibilityFingerprint = fingerprint;
          error.eligibilitySourceFingerprint = sourceFingerprint;
          error.eligibilityCacheId = cacheId;
          error.candidateFactsDependency = factsDependency;
        }
        throw error;
      }
    }
    return withEligibilityMetadata({ ...result, fingerprint, cacheId });
  };
  check.fingerprintFor = fingerprintForJob;
  return check;
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
  // A one-off checkout may only reuse candidate facts from the CV until its
  // answer records have the typed source/round/target verification contract.
  const answers = {};
  const result = await evaluateConciergePosting({
    job,
    profile: record.profile,
    answers,
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
  const [serviceDoc, proposalDoc] = await Promise.all([serviceRef.get(), serviceRef.collection('proposals').doc(order.parentProposalId).get()]);
  const proposal = proposalDoc.data();
  if (serviceDoc.data()?.userId !== order.userId || proposal?.eligibilityVersion !== CONCIERGE_ELIGIBILITY_VERSION
    || !/^job-[a-f0-9]{32}$/.test(proposal?.eligibilityCacheId || '')) return null;
  const cached = (await serviceRef.collection('eligibility').doc(proposal.eligibilityCacheId).get()).data();
  const answerHash = eligibilityHash(JSON.stringify({}));
  if (cached?.result?.status !== 'compatible' || cached.promptVersion !== PROMPT_VERSION || cached.version !== CONCIERGE_ELIGIBILITY_VERSION
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
