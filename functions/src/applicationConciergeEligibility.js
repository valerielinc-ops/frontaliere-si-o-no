/** Full-posting qualification before a concierge proposal is published. All caches are owner-private. */
import { createHash } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { timestampMillis } from './applicationConciergeConstants.js';
import { FieldValue } from 'firebase-admin/firestore';
import { generateServerText } from './geminiGenerate.js';
import { detectCvFileType, ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import { extractCvText } from './assistedApplicationAiDocuments.js';
import { fetchJobPosting } from './assistedApplicationAiJob.js';
import { sanitizeProfile, sanitizeRequirements, sanitizeMatch, verifyQuotes } from './assistedApplicationAiDraftCore.js';
import { PROFILE_SCHEMA, PROFILE_SYSTEM_PROMPT, profileUserText, REQUIREMENTS_SCHEMA, REQUIREMENTS_SYSTEM_PROMPT,
  requirementsUserText, MATCH_SCHEMA, matchSystemPrompt, matchUserText } from './assistedApplicationAiPrompts.js';
import { conciergeProposalEligibility } from './assistedApplicationFitNotice.js';

export const CONCIERGE_ELIGIBILITY_VERSION = 'full-posting-requirements-v1';
export const eligibilityHash = value => createHash('sha256').update(value).digest('hex');
const sourceHash = value => eligibilityHash(String(value || '').replace(/\s+/g, ' ').trim());
const PROMPT_VERSION = eligibilityHash([PROFILE_SYSTEM_PROMPT, REQUIREMENTS_SYSTEM_PROMPT, matchSystemPrompt('it')].join('\n'));

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

async function generateJson(systemPrompt, userPrompt, schema) {
  const response = await generateServerText({ systemPrompt: `${systemPrompt}\nReturn ONLY valid JSON matching this schema:\n${JSON.stringify(schema)}`,
    userPrompt, maxTokens: 8192, temperature: 0, maxProviderAttempts: 2, allowCodexFallback: false });
  if (!response.body?.ok) throw new Error('eligibility_provider_unavailable');
  const text = response.body.text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const result = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('eligibility_invalid_json');
  return result;
}

export async function prepareConciergeEligibility({ db, serviceRef, service, profileRecord, bucket = null, generate = generateJson, readPosting = fetchJobPosting }) {
  if (!String(service.cvStorageKey || '').startsWith(`application-concierge-uploads/${serviceRef.id}/`)) throw new Error('eligibility_cv_owner_mismatch');
  const storage = bucket || getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
  const file = storage.file(service.cvStorageKey);
  const [metadata] = await file.getMetadata();
  if (Number(metadata.size) > 12 * 1024 * 1024) throw new Error('eligibility_cv_too_large');
  const [bytes] = await file.download();
  const cvHash = eligibilityHash(bytes);
  const type = detectCvFileType(bytes.subarray(0, 8));
  const cvText = type ? await extractCvText(bytes, type) : '';
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
  const answers = profileRecord.applicationQuestionAnswers || {};
  const answerHash = eligibilityHash(JSON.stringify(answers));
  let analyses = 0;
  return async (job) => {
    job = normalizeConciergeJobRecord(job);
    const posting = await readPosting({ jobId: job.id, jobUrl: job.url }, { maxPostingChars: 30_000 });
    if (!posting.text || posting.text.length < 100 || posting.textTruncated) return { status: 'unverified', reason: 'posting_incomplete' };
    const postingHash = sourceHash(posting.text);
    const postingMetadata = [job.title, job.company, posting.location || job.location].map(value => String(value || '').trim().replace(/\s+/g, ' '));
    const fingerprint = eligibilityHash([cvHash, answerHash, postingHash, ...postingMetadata, PROMPT_VERSION, CONCIERGE_ELIGIBILITY_VERSION].join('|'));
    const cacheId = `job-${eligibilityHash(String(job.id || job.url)).slice(0, 32)}`;
    const ref = cache.doc(cacheId);
    const cached = (await ref.get()).data();
    if (cached?.fingerprint === fingerprint) return { ...cached.result, fingerprint, cacheId };
    if (analyses >= 20) return { status: 'unverified', reason: 'analysis_deferred' };
    analyses += 1;
    const raw = await generate(REQUIREMENTS_SYSTEM_PROMPT, requirementsUserText({ jobTitle: job.title, companyName: job.company,
      location: posting.location || job.location, postingText: posting.text }), REQUIREMENTS_SCHEMA);
    if (!Array.isArray(raw.requirements) || !raw.requirements.length || raw.requirements.length > 12) return { status: 'unverified', reason: 'requirements_incomplete' };
    const requirements = verifyQuotes(sanitizeRequirements(raw), posting.text);
    const matchRaw = await generate(matchSystemPrompt(service.locale), matchUserText({ profile, requirements, answers,
      postingExcerpt: posting.text, sourceText: cvText }), MATCH_SCHEMA);
    const match = sanitizeMatch(matchRaw, requirements.requirements.length, `${cvText}\n${JSON.stringify(answers)}`);
    const result = conciergeProposalEligibility(requirements, match, { profile, answers });
    // Unknown sources and incomplete responses are retried, never cached as a positive result.
    if (result.status !== 'unverified') await ref.set({ fingerprint, cvHash, answerHash, postingHash, promptVersion: PROMPT_VERSION,
      version: CONCIERGE_ELIGIBILITY_VERSION, profile, requirements, match, result, updatedAt: FieldValue.serverTimestamp() });
    return { ...result, fingerprint, cacheId };
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
  const answerHash = eligibilityHash(JSON.stringify(profileDoc.data()?.applicationQuestionAnswers || {}));
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
