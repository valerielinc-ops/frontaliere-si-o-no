import {
  employerResponseTimelineView,
  employerResponseView,
  loadEmployerResponse,
  loadEmployerResponseTimeline,
} from './assistedApplicationEmployerResponse.js';
/**
 * Candidate and owner API for the application concierge.
 *
 * Candidate acceptance is deliberately a server-side transaction. A proposal
 * is only turned into an assisted_applications child after the owner has
 * proposed it and the candidate has accepted it; the existing automation
 * engine then continues to operate on that child without knowing about the
 * parent bundle.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID,
  CONCIERGE_ELIGIBILITY_VERSION,
  candidateAnswersDocumentId,
  eligibilityHash,
  prepareConciergeEligibility,
} from './applicationConciergeEligibility.js';
import { proposalDocumentId, rankingFeaturesForJob } from './applicationConciergeMatching.js';
import { candidateStatusForAssistedApplication } from './assistedApplicationCandidateStatusCore.js';
import { getReviewTokenSecret, mintReviewToken } from './assistedApplicationReviewToken.js';
import { conciergeRenewalOffer } from './applicationConciergeLifecyclePolicy.js';
import { isApplicationConciergeRenewalEnabledFor } from './applicationConciergeRenewalRollout.js';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { assertSiteAdmin } from './adminAuth.js';
import { writeAdminAuditLog } from './adminAudit.js';
import { getAuth } from 'firebase-admin/auth';
import { verifyCaller } from './stripePublisherCore.js';
import { ASSISTED_APPLICATION_CONSENT_VERSION } from './assistedApplicationCheckout.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import { conciergePaidEmailViews } from './assistedApplicationEmailEvents.js';
import {
  APPLICATION_CONCIERGE_CONSENT_VERSION,
  APPLICATION_CONCIERGE_CV_PREFIX,
  APPLICATION_CONCIERGE_CANDIDATE_ANSWERS_VERSION,
  APPLICATION_CONCIERGE_CANDIDATE_LANGUAGES_VERSION,
  APPLICATION_CONCIERGE_MATCHING_VERSION,
  APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS,
  APPLICATION_CONCIERGE_PROPOSAL_STATUSES,
  APPLICATION_CONCIERGE_SERVICES_COLLECTION,
  acceptedPositionsCount,
  openProposalsCount,
  serviceIsActive,
  serviceIsExpired,
  servicePositionLimit,
  timestampMillis,
} from './applicationConciergeConstants.js';
import { CANDIDATE_LANGUAGE_LEVELS, CANDIDATE_LANGUAGE_OPTIONS } from './lib/languageFacts.js';
import { conciergeMaterialCopy, CONCIERGE_MAX_CV_BYTES } from './applicationConciergeMaterialCopy.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPLICATION_CONCIERGE_CANDIDATE_LOCALES = new Set(['it', 'en', 'de', 'fr']);
const MAX_CV_BYTES = CONCIERGE_MAX_CV_BYTES;
const CV_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const CANDIDATE_LANGUAGE_CODES = new Set(CANDIDATE_LANGUAGE_OPTIONS.map(item => item.code));
const CANDIDATE_LANGUAGE_LEVEL_SET = new Set(CANDIDATE_LANGUAGE_LEVELS);
const CANDIDATE_DECLINE_REASONS = new Set(['role', 'location', 'contract', 'schedule', 'sector', 'seniority']);
const MAX_CANDIDATE_LANGUAGES = 20;
const MAX_CLARIFICATION_ANSWERS = 6;

export class ApplicationConciergeError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'ApplicationConciergeError';
    this.code = code;
    this.status = status;
  }
}

function boundedString(value, max) {
  const result = String(value ?? '').trim();
  return result && result.length <= max ? result : '';
}

function optionalString(value, max) {
  if (value === undefined || value === null) return null;
  return boundedString(value, max) || null;
}

function candidateCommunicationLocale(service) {
  return APPLICATION_CONCIERGE_CANDIDATE_LOCALES.has(service?.locale) ? service.locale : 'it';
}

function timestampToIso(value) {
  const millis = timestampMillis(value);
  return millis > 0 ? new Date(millis).toISOString() : null;
}

function eligibilityFactsRevision(service) {
  const value = Number(service?.eligibilityFactsRevision);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function proposalUsesCurrentEligibilityFacts(proposal, service) {
  return eligibilityFactsRevision(proposal) === eligibilityFactsRevision(service);
}

function validHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function serviceIdFromRequest(req) {
  const query = req.query || {};
  const value = Array.isArray(query.serviceId) ? query.serviceId[0] : query.serviceId;
  return boundedString(value || req.body?.serviceId, 200);
}

function proposalIdFromRequest(req) {
  return boundedString(req.body?.proposalId || req.query?.proposalId, 200);
}

function validId(value) {
  return /^[A-Za-z0-9_-]{1,200}$/.test(String(value || ''));
}

function serviceRefFor(db, serviceId) {
  return db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
}

function proposalRefFor(db, serviceId, proposalId) {
  return serviceRefFor(db, serviceId).collection('proposals').doc(proposalId);
}

function proposalStatus(value) {
  const status = boundedString(value, 30);
  return APPLICATION_CONCIERGE_PROPOSAL_STATUSES.includes(status) ? status : 'proposed';
}

function cvKeyForService(serviceId, value) {
  const key = boundedString(value, 600);
  const prefix = `${APPLICATION_CONCIERGE_CV_PREFIX}/${serviceId}/`;
  const file = key.startsWith(prefix) ? key.slice(prefix.length) : '';
  return file && /^[A-Za-z0-9._-]+$/.test(file) && !file.includes('..') ? key : '';
}

function matchingNeedsVerification(service) {
  return ['queued', 'running', 'failed', 'needs_review'].includes(String(service?.matchingStatus || ''));
}

function serializeProposal(doc, service = null) {
  const data = doc.data() || {};
  const usableEligibility = ['compatible', 'clarification_required'].includes(data.eligibilityStatus);
  const staleEligibility = data.status === 'proposed'
    && (matchingNeedsVerification(service) || !usableEligibility || data.eligibilityVersion !== CONCIERGE_ELIGIBILITY_VERSION
      || data.eligibilityCvStorageKey !== service?.cvStorageKey
      || !proposalUsesCurrentEligibilityFacts(data, service));
  const clarificationQuestions = !staleEligibility && data.eligibilityStatus === 'clarification_required'
    ? (Array.isArray(data.clarificationQuestions) ? data.clarificationQuestions : []).slice(0, MAX_CLARIFICATION_ANSWERS).map(question => ({
      id: boundedString(question?.id, 60),
      question: boundedString(question?.question, 300),
      why: boundedString(question?.why, 300),
      required: question?.required === true,
    })).filter(question => question.id && question.question && question.required)
    : [];
  return {
    proposalId: doc.id,
    jobId: boundedString(data.jobId, 200),
    jobUrl: boundedString(data.jobUrl, 500),
    companyId: boundedString(data.companyId, 200),
    companyName: boundedString(data.companyName, 200),
    jobTitle: boundedString(data.jobTitle, 300),
    location: optionalString(data.location, 200),
    applyMode: optionalString(data.applyMode, 60),
    status: proposalStatus(data.status),
    eligibilityStatus: staleEligibility ? 'needs_verification' : optionalString(data.eligibilityStatus, 40),
    clarificationQuestions,
    candidateInterestRecorded: Boolean(timestampMillis(data.interestedAt)),
    declineReason: optionalString(data.declineReason, 30),
    createdAt: timestampToIso(data.createdAt),
    proposedAt: timestampToIso(data.proposedAt || data.createdAt),
    acceptedAt: timestampToIso(data.acceptedAt),
    declinedAt: timestampToIso(data.declinedAt),
    childApplicationId: optionalString(data.childApplicationId, 200),
    childApplicationState: optionalString(data.childApplicationState, 60),
    childSubmissionStatus: optionalString(data.childSubmissionStatus, 60),
    childCandidateStatus: optionalString(data.childCandidateStatus, 40),
    childEmployerResponse: employerResponseView(data.childEmployerResponse),
    childEmployerResponseTimeline: employerResponseTimelineView(data.childEmployerResponseTimeline),
    childSendState: optionalString(data.childSendState, 20),
    childRetryScheduled: data.childRetryScheduled === true,
    withdrawnAt: timestampToIso(data.withdrawnAt),
    matchScore: Number.isFinite(Number(data.matchScore)) ? Number(data.matchScore) : null,
    matchReasons: Array.isArray(data.matchReasons) ? data.matchReasons.map((value) => boundedString(value, 180)).filter(Boolean).slice(0, 6) : [],
    matchedAt: timestampToIso(data.matchedAt),
    source: optionalString(data.source, 80),
  };
}

function proposalRankingValue(doc, field) {
  const data = doc?.data ? doc.data() || {} : doc || {};
  const value = Number(data[field]);
  return Number.isFinite(value) ? value : 0;
}

export function serializeApplicationConciergeService(doc, proposalDocs = [], { admin = false, renewalEnabled = false } = {}) {
  const data = doc.data ? doc.data() || {} : doc || {};
  const serviceId = doc.id || data.serviceId;
  const expired = serviceIsExpired(data);
  const proposals = [...proposalDocs]
    .sort((left, right) => (proposalRankingValue(right, 'matchRankingScore') || proposalRankingValue(right, 'matchScore'))
      - (proposalRankingValue(left, 'matchRankingScore') || proposalRankingValue(left, 'matchScore'))
      || proposalRankingValue(right, 'matchScore') - proposalRankingValue(left, 'matchScore'))
    .map((proposal) => serializeProposal(proposal, data));
  return {
    serviceId,
    serviceType: 'application_concierge',
    plan: boundedString(data.plan, 80) || '30d-10-positions',
    paymentStatus: boundedString(data.paymentStatus, 40),
    checkoutSessionStatus: boundedString(data.checkoutSessionStatus, 40),
    serviceStatus: expired && data.serviceStatus === 'active' ? 'expired' : boundedString(data.serviceStatus, 40),
    paymentProvider: boundedString(data.paymentProvider, 40),
    renewal: data.renewal === true,
    amountTotal: [2999, 3999].includes(data.nextAmountTotal) ? data.nextAmountTotal : [2999, 3999].includes(data.expectedAmountTotal) ? data.expectedAmountTotal : 3999,
    renewalOffer: admin || renewalEnabled ? conciergeRenewalOffer(data) : null,
    maxPositions: servicePositionLimit(data),
    acceptedPositionsCount: acceptedPositionsCount(data),
    openProposalsCount: openProposalsCount(data, proposals.filter(proposal => proposal.status === 'proposed').length),
    maxOpenProposals: APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS,
    remainingPositions: Math.max(0, servicePositionLimit(data) - acceptedPositionsCount(data)),
    paidAt: timestampToIso(data.paidAt),
    expiresAt: timestampToIso(data.expiresAt),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    customerEmail: optionalString(data.customerEmail, 320),
    applicantName: optionalString(data.applicantName, 200),
    applicantEmail: optionalString(data.applicantEmail, 320),
    applicantPhone: optionalString(data.applicantPhone, 80),
    applicantLocation: optionalString(data.applicantLocation, 120),
    applicantLocationCountry: optionalString(data.applicantLocationCountry, 2),
    hasConsent: data.consentVersion === APPLICATION_CONCIERGE_CONSENT_VERSION && timestampMillis(data.consentedAt) > 0,
    hasCv: Boolean(cvKeyForService(serviceId, data.cvStorageKey)),
    consentedAt: timestampToIso(data.consentedAt),
    cvUploadedAt: timestampToIso(data.cvUploadedAt),
    cvFileName: optionalString(data.cvFileName, 180) || (cvKeyForService(serviceId, data.cvStorageKey)?.split('/').pop() || null),
    cvProfileStatus: optionalString(data.cvProfileStatus, 40),
    matchingStatus: optionalString(data.matchingStatus, 40),
    matchingJobCount: Number.isFinite(Number(data.matchingJobCount)) ? Number(data.matchingJobCount) : null,
    matchingUnverifiedCount: Number.isFinite(Number(data.matchingUnverifiedCount)) ? Math.max(0, Math.floor(Number(data.matchingUnverifiedCount))) : 0,
    matchingClarificationCount: Number.isFinite(Number(data.matchingClarificationCount)) ? Math.max(0, Math.floor(Number(data.matchingClarificationCount))) : 0,
    matchingStartedAt: timestampToIso(data.matchingStartedAt),
    matchingCompletedAt: timestampToIso(data.matchingCompletedAt),
    matchingError: optionalString(data.matchingError, 80),
    proposals,
    ...(admin ? {
      userId: optionalString(data.userId, 200),
      consentVersion: optionalString(data.consentVersion, 120),
      cvStorageKey: cvKeyForService(serviceId, data.cvStorageKey) || null,
      paidReceiptEmails: conciergePaidEmailViews(data),
    } : {}),
  };
}

async function serializeCandidateApplicationConciergeService(doc, proposalDocs = []) {
  const data = doc.data ? doc.data() || {} : doc || {};
  const renewalEnabled = Boolean(conciergeRenewalOffer(data))
    && await isApplicationConciergeRenewalEnabledFor(data.userId);
  let candidateLanguageFacts = null;
  if (doc.ref?.collection) {
    const factsSnapshot = await doc.ref.collection('eligibility').doc(CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID).get();
    const record = factsSnapshot.data() || {};
    if (record.provenance === 'candidate_confirmed'
      && record.schemaVersion === APPLICATION_CONCIERGE_CANDIDATE_LANGUAGES_VERSION
      && timestampMillis(record.confirmedAt) > 0
      && Array.isArray(record.languages)) {
      candidateLanguageFacts = {
        confirmedAt: timestampToIso(record.confirmedAt),
        listComplete: record.listComplete === true,
        languages: record.languages.slice(0, MAX_CANDIDATE_LANGUAGES).map(item => ({
          languageCode: boundedString(item?.languageCode, 2).toLowerCase(),
          level: CANDIDATE_LANGUAGE_LEVEL_SET.has(item?.level) ? item.level : 'unknown',
        })).filter(item => CANDIDATE_LANGUAGE_CODES.has(item.languageCode)),
      };
    }
  }
  return {
    ...serializeApplicationConciergeService(doc, proposalDocs, { renewalEnabled }),
    candidateLanguageFacts,
  };
}

async function loadService(db, serviceId) {
  if (!validId(serviceId)) throw new ApplicationConciergeError('invalid_service_id', 400);
  const ref = serviceRefFor(db, serviceId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new ApplicationConciergeError('service_not_found', 404);
  const proposals = await ref.collection('proposals').get();
  const parent = snapshot.data() || {};
  const enriched = await Promise.all((proposals.docs || []).map(async proposal => {
    const data = proposal.data() || {};
    if (data.status === 'proposed' && data.eligibilityStatus === 'clarification_required'
      && data.eligibilityVersion === CONCIERGE_ELIGIBILITY_VERSION
      && /^job-[a-f0-9]{32}$/.test(String(data.eligibilityCacheId || ''))) {
      const cached = (await ref.collection('eligibility').doc(data.eligibilityCacheId).get()).data() || {};
      const questions = cached?.result?.status === 'clarification_required' && Array.isArray(cached.result.questions)
        ? cached.result.questions.slice(0, MAX_CLARIFICATION_ANSWERS).map(question => ({
          id: boundedString(question?.id, 60),
          question: boundedString(question?.question, 300),
          why: boundedString(question?.why, 300),
          required: question?.required === true,
        })).filter(question => question.id && question.question && question.required)
        : [];
      return { id: proposal.id, ref: proposal.ref || proposal, data: () => ({ ...data, clarificationQuestions: questions }) };
    }
    if ((data.status !== 'accepted' && !data.withdrawnAt) || !validId(data.childApplicationId)) return proposal;
    const childRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(data.childApplicationId);
    const [childDoc, flowDoc, submissionDoc] = await Promise.all([
      childRef.get(), childRef.collection('automation').doc('flow').get(), childRef.collection('automation').doc('submission').get(),
    ]);
    const child = childDoc.data();
    if (child?.userId !== parent.userId || child.parentServiceId !== serviceId || child.parentProposalId !== proposal.id) return proposal;
    const [employerResponse, employerResponseTimeline] = await Promise.all([
      loadEmployerResponse(childRef, child),
      loadEmployerResponseTimeline(childRef, child),
    ]);
    const flow = flowDoc.data();
    const childApplicationState = flow?.state || child.automationState || null;
    const send = submissionDoc.data()?.[`r${Number(flow?.round) || 1}`];
    return { id: proposal.id, ref: proposal.ref || proposal, data: () => ({ ...data,
      childEmployerResponse: employerResponseView(employerResponse),
      childEmployerResponseTimeline: employerResponseTimelineView(employerResponseTimeline),
      childApplicationState, childSubmissionStatus: child.submissionStatus || null,
      childCandidateStatus: candidateStatusForAssistedApplication({ ...child, automationState: childApplicationState }),
      childSendState: send?.state || null, childRetryScheduled: childApplicationState === 'owner_takeover' && Number(flow?.portalAutoRetryAt) > 0,
    }) };
  }));
  return { ref, snapshot, proposals: enriched };
}

function assertCandidateOwns(service, uid) {
  if (!service || service.userId !== uid) throw new ApplicationConciergeError('service_not_found', 404);
}

function assertActive(service) {
  if (service?.paymentStatus !== 'paid') throw new ApplicationConciergeError('payment_not_confirmed', 409);
  if (!serviceIsActive(service)) {
    throw new ApplicationConciergeError(serviceIsExpired(service) ? 'service_expired' : 'service_not_active', 409);
  }
}

function assertProfileInput(body) {
  const name = boundedString(body.applicantName, 200);
  const email = boundedString(body.applicantEmail, 320).toLowerCase();
  const phone = optionalString(body.applicantPhone, 80);
  if (!name || !EMAIL_RE.test(email)) throw new ApplicationConciergeError('invalid_candidate_details', 400);
  return { name, email, phone };
}

function applicantLocationPatch(service, serviceId, body) {
  if (!Object.hasOwn(body, 'applicantLocation')) return {};
  const value = String(body.applicantLocation ?? '').trim();
  if (value.length > 120) throw new ApplicationConciergeError('invalid_candidate_details', 400);
  const countryWasProvided = Object.hasOwn(body, 'applicantLocationCountry');
  const requestedCountry = countryWasProvided ? String(body.applicantLocationCountry ?? '').trim() : null;
  if (requestedCountry && !/^[A-Z]{2}$/.test(requestedCountry)) throw new ApplicationConciergeError('invalid_candidate_details', 400);
  const applicantLocation = value || null;
  const existingCountry = optionalString(service.applicantLocationCountry, 2);
  const applicantLocationCountry = !applicantLocation ? null
    : countryWasProvided ? requestedCountry || null
      : value !== String(service.applicantLocation || '').trim() ? null : existingCountry;
  const locationChanged = value !== String(service.applicantLocation || '').trim();
  return {
    applicantLocation,
    applicantLocationCountry,
    // The matcher is triggered by CV or location-text changes. Confirming a
    // country for an unchanged legacy location is metadata only; queueing it
    // here would leave the service stuck because the Firestore trigger ignores
    // country-code-only updates.
    ...(locationChanged && cvKeyForService(serviceId, service.cvStorageKey) ? {
      matchingStatus: 'queued',
      matchingError: null,
    } : {}),
  };
}

function assertConciergeProcessingConsent(service) {
  if (service?.consentVersion !== APPLICATION_CONCIERGE_CONSENT_VERSION || timestampMillis(service?.consentedAt) <= 0) {
    throw new ApplicationConciergeError('consent_required', 409);
  }
}

function candidateLanguageFactsInput(body) {
  if (typeof body.listComplete !== 'boolean' || !Array.isArray(body.languages)
    || body.languages.length > MAX_CANDIDATE_LANGUAGES) {
    throw new ApplicationConciergeError('invalid_candidate_language_facts', 400);
  }
  const seen = new Set();
  const languages = body.languages.map(item => {
    const languageCode = boundedString(item?.languageCode, 2).toLowerCase();
    const rawLevel = String(item?.level ?? '').trim().toLowerCase();
    const level = !rawLevel ? 'unknown' : ['native', 'unknown'].includes(rawLevel) ? rawLevel : rawLevel.toUpperCase();
    if (!CANDIDATE_LANGUAGE_CODES.has(languageCode) || !CANDIDATE_LANGUAGE_LEVEL_SET.has(level) || seen.has(languageCode)) {
      throw new ApplicationConciergeError('invalid_candidate_language_facts', 400);
    }
    seen.add(languageCode);
    return { languageCode, level };
  }).sort((left, right) => left.languageCode.localeCompare(right.languageCode));
  return { listComplete: body.listComplete, languages };
}

function storedCandidateLanguageFacts(record) {
  if (record?.provenance !== 'candidate_confirmed'
    || record.schemaVersion !== APPLICATION_CONCIERGE_CANDIDATE_LANGUAGES_VERSION
    || timestampMillis(record.confirmedAt) <= 0) return null;
  return {
    listComplete: record.listComplete === true,
    languages: (Array.isArray(record.languages) ? record.languages : []).map(item => ({
      languageCode: String(item?.languageCode || '').toLowerCase(),
      level: CANDIDATE_LANGUAGE_LEVEL_SET.has(item?.level) ? item.level : 'unknown',
    })).filter(item => CANDIDATE_LANGUAGE_CODES.has(item.languageCode))
      .sort((left, right) => left.languageCode.localeCompare(right.languageCode)),
  };
}

async function saveCandidateLanguageFacts(db, serviceId, uid, body) {
  const facts = candidateLanguageFactsInput(body);
  const { ref, snapshot } = await loadService(db, serviceId);
  const service = snapshot.data() || {};
  assertCandidateOwns(service, uid);
  assertActive(service);
  assertConciergeProcessingConsent(service);
  if (!cvKeyForService(serviceId, service.cvStorageKey)) throw new ApplicationConciergeError('cv_required', 409);
  const factsRef = ref.collection('eligibility').doc(CONCIERGE_CANDIDATE_LANGUAGE_FACTS_DOC_ID);
  const purgeBase = Math.max(timestampMillis(service.cvUploadedAt), timestampMillis(service.paidAt), Date.now());
  const purgeAt = new Date(purgeBase + 90 * 86400000);
  await db.runTransaction(async transaction => {
    const [currentServiceSnapshot, currentFactsSnapshot] = await Promise.all([
      transaction.get(ref), transaction.get(factsRef),
    ]);
    const currentService = currentServiceSnapshot.data() || {};
    assertCandidateOwns(currentService, uid);
    assertActive(currentService);
    assertConciergeProcessingConsent(currentService);
    const previous = storedCandidateLanguageFacts(currentFactsSnapshot.data());
    if (previous && JSON.stringify(previous) === JSON.stringify(facts)) return;
    const now = Timestamp.now();
    transaction.set(factsRef, {
      schemaVersion: APPLICATION_CONCIERGE_CANDIDATE_LANGUAGES_VERSION,
      provenance: 'candidate_confirmed',
      confirmedAt: now,
      listComplete: facts.listComplete,
      languages: facts.languages,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(ref, {
      eligibilityPurgeAt: purgeAt,
      eligibilityFactsRevision: FieldValue.increment(1),
      matchingStatus: 'queued',
      matchingError: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  const fresh = await loadService(db, serviceId);
  return serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals);
}

function candidateAnswerInput(body, questions) {
  if (!Array.isArray(body.answers) || body.answers.length > MAX_CLARIFICATION_ANSWERS) {
    throw new ApplicationConciergeError('invalid_proposal_answers', 400);
  }
  const required = (Array.isArray(questions) ? questions : [])
    .filter(question => question?.required === true && question?.id && question?.question).slice(0, MAX_CLARIFICATION_ANSWERS);
  if (!required.length) throw new ApplicationConciergeError('proposal_requires_verification', 409);
  const byId = new Map(required.map(question => [String(question.id), question]));
  const submitted = new Map();
  for (const item of body.answers) {
    const id = boundedString(item?.questionId, 60);
    const question = byId.get(id);
    const rawAnswer = String(item?.answer ?? '').trim();
    if (!question || submitted.has(id) || !rawAnswer || rawAnswer.length > 500) {
      throw new ApplicationConciergeError('invalid_proposal_answers', 400);
    }
    submitted.set(id, { questionId: id, question: boundedString(question.question, 300), answer: rawAnswer });
  }
  if (required.some(question => !submitted.has(String(question.id)))) {
    throw new ApplicationConciergeError('proposal_answers_required', 400);
  }
  return required.map(question => submitted.get(String(question.id)));
}

async function submitProposalInterest(db, serviceId, proposalId, uid, body) {
  if (!validId(serviceId)) throw new ApplicationConciergeError('invalid_service_id', 400);
  if (!validId(proposalId)) throw new ApplicationConciergeError('invalid_proposal_id', 400);
  const serviceRef = serviceRefFor(db, serviceId);
  const proposalRef = proposalRefFor(db, serviceId, proposalId);
  const serviceSnapshot = await serviceRef.get();
  if (!serviceSnapshot.exists) throw new ApplicationConciergeError('service_not_found', 404);
  const initialService = serviceSnapshot.data() || {};
  assertCandidateOwns(initialService, uid);
  assertActive(initialService);
  assertConciergeProcessingConsent(initialService);
  const initialProposal = (await proposalRef.get()).data() || {};
  const cacheId = String(initialProposal.eligibilityCacheId || '');
  if (!/^job-[a-f0-9]{32}$/.test(cacheId)) throw new ApplicationConciergeError('proposal_requires_verification', 409);
  const cacheRef = serviceRef.collection('eligibility').doc(cacheId);
  const answersRef = serviceRef.collection('eligibility').doc(candidateAnswersDocumentId(cacheId));
  await db.runTransaction(async transaction => {
    const [currentServiceSnapshot, currentProposalSnapshot, cacheSnapshot, previousAnswersSnapshot] = await Promise.all([
      transaction.get(serviceRef), transaction.get(proposalRef), transaction.get(cacheRef), transaction.get(answersRef),
    ]);
    const service = currentServiceSnapshot.data() || {};
    const proposal = currentProposalSnapshot.data() || {};
    const cached = cacheSnapshot.data() || {};
    assertCandidateOwns(service, uid);
    assertActive(service);
    assertConciergeProcessingConsent(service);
    if (!currentProposalSnapshot.exists || proposal.status !== 'proposed'
      || matchingNeedsVerification(service)
      || proposal.eligibilityStatus !== 'clarification_required'
      || proposal.eligibilityVersion !== CONCIERGE_ELIGIBILITY_VERSION
      || proposal.eligibilityCvStorageKey !== service.cvStorageKey
      || !proposalUsesCurrentEligibilityFacts(proposal, service)
      || proposal.eligibilityCacheId !== cacheId
      || proposal.eligibilityFingerprint !== cached.fingerprint
      || cached.version !== CONCIERGE_ELIGIBILITY_VERSION
      || cached.result?.status !== 'clarification_required') {
      throw new ApplicationConciergeError('proposal_requires_verification', 409);
    }
    const answers = candidateAnswerInput(body, cached.result.questions);
    const questionSetHash = eligibilityHash(JSON.stringify(answers.map(({ questionId, question }) => [questionId, question])));
    const previous = previousAnswersSnapshot.data() || {};
    if (previous.provenance === 'candidate_confirmed'
      && previous.schemaVersion === APPLICATION_CONCIERGE_CANDIDATE_ANSWERS_VERSION
      && previous.cacheId === cacheId
      && previous.questionSetHash === questionSetHash
      && JSON.stringify(previous.answers) === JSON.stringify(answers)
      && proposal.candidateInterestStatus === 'interested') return;
    const now = Timestamp.now();
    transaction.set(answersRef, {
      schemaVersion: APPLICATION_CONCIERGE_CANDIDATE_ANSWERS_VERSION,
      provenance: 'candidate_confirmed',
      confirmedAt: now,
      cacheId,
      questionSetHash,
      eligibilityFingerprint: cached.fingerprint,
      answers,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(proposalRef, {
      candidateInterestStatus: 'interested',
      interestedAt: now,
      candidateAnsweredAt: now,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(serviceRef, {
      eligibilityFactsRevision: FieldValue.increment(1),
      matchingStatus: 'queued',
      matchingError: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  const fresh = await loadService(db, serviceId);
  return serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals);
}

async function saveCandidateProfile(db, serviceId, uid, body) {
  const { ref, snapshot } = await loadService(db, serviceId);
  const service = snapshot.data() || {};
  assertCandidateOwns(service, uid);
  assertActive(service);
  const { name, email, phone } = assertProfileInput(body);
  const hasConsent = service.consentVersion === APPLICATION_CONCIERGE_CONSENT_VERSION && timestampMillis(service.consentedAt) > 0;
  // `consent: false` was used by the first client version as an explicit
  // attempt to save the whole form. Keep that request fail-closed when the
  // service has never been authorized, while an omitted consent field means
  // the new data-only save action.
  if (body.consent === false && !hasConsent) throw new ApplicationConciergeError('consent_required', 400);
  const currentKey = cvKeyForService(serviceId, service.cvStorageKey);
  const requestedKey = body.cvStorageKey === undefined
    ? currentKey
    : cvKeyForService(serviceId, body.cvStorageKey);
  if (body.cvStorageKey && !requestedKey) throw new ApplicationConciergeError('invalid_cv_reference', 400);
  if (requestedKey && requestedKey !== currentKey && !hasConsent && body.consent !== true) {
    throw new ApplicationConciergeError('consent_required', 400);
  }
  if (requestedKey && requestedKey !== currentKey) {
    const bucket = getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
    const [exists] = await bucket.file(requestedKey).exists();
    if (!exists) throw new ApplicationConciergeError('cv_not_found', 400);
    const [metadata] = await bucket.file(requestedKey).getMetadata();
    if (Number(metadata?.size) > MAX_CV_BYTES || !CV_CONTENT_TYPES.has(String(metadata?.contentType || '').toLowerCase())) {
      throw new ApplicationConciergeError('invalid_cv_file', 400);
    }
  }
  const now = Timestamp.now();
  const consentPatch = body.consent === true && !hasConsent
    ? { consentVersion: APPLICATION_CONCIERGE_CONSENT_VERSION, consentedAt: now }
    : {};
  await ref.set({
    applicantName: name,
    applicantEmail: email,
    applicantPhone: phone,
    ...applicantLocationPatch(service, serviceId, body),
    ...consentPatch,
    ...(requestedKey ? {
      cvStorageKey: requestedKey,
      ...(requestedKey !== currentKey ? {
        cvUploadedAt: now,
        cvFileName: optionalString(body.cvFileName, 180) || requestedKey.split('/').pop() || null,
        cvProfileStatus: 'queued',
        matchingStatus: 'queued',
        matchingJobCount: null,
        matchingError: null,
      } : {}),
    } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const fresh = await loadService(db, serviceId);
  return serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals);
}

async function recordCandidateConsent(db, serviceId, uid, body) {
  if (body.consent !== true) throw new ApplicationConciergeError('consent_required', 400);
  const { ref, snapshot } = await loadService(db, serviceId);
  const service = snapshot.data() || {};
  assertCandidateOwns(service, uid);
  assertActive(service);
  const { name, email, phone } = assertProfileInput(body);
  const alreadyRecorded = service.consentVersion === APPLICATION_CONCIERGE_CONSENT_VERSION
    && timestampMillis(service.consentedAt) > 0;
  await ref.set({
    applicantName: name,
    applicantEmail: email,
    applicantPhone: phone,
    ...applicantLocationPatch(service, serviceId, body),
    ...(alreadyRecorded ? {} : {
      consentVersion: APPLICATION_CONCIERGE_CONSENT_VERSION,
      consentedAt: Timestamp.now(),
    }),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const fresh = await loadService(db, serviceId);
  return serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals);
}

function proposalJobData(data) {
  const jobId = boundedString(data.jobId, 200);
  const jobUrl = boundedString(data.jobUrl, 500);
  const companyId = boundedString(data.companyId || data.companyName, 200);
  const companyName = boundedString(data.companyName, 200);
  const jobTitle = boundedString(data.jobTitle, 300);
  if (!jobId || !validHttpsUrl(jobUrl) || !companyId || !companyName || !jobTitle) {
    throw new ApplicationConciergeError('invalid_job', 400);
  }
  return {
    jobId,
    jobUrl,
    companyId,
    companyName,
    jobTitle,
    location: optionalString(data.location, 200),
    applyMode: optionalString(data.applyMode, 60),
  };
}

async function throwPositionLimitReachedIfCurrent(serviceRef) {
  const snapshot = await serviceRef.get();
  const service = snapshot.exists ? snapshot.data() || {} : null;
  if (service && acceptedPositionsCount(service) >= servicePositionLimit(service)) {
    throw new ApplicationConciergeError('position_limit_reached', 409);
  }
}

async function acceptProposal(db, serviceId, proposalId, uid, operationStartedAt = Date.now()) {
  if (!validId(proposalId)) throw new ApplicationConciergeError('invalid_proposal_id', 400);
  const loadedService = await loadService(db, serviceId);
  const { ref: serviceRef, snapshot: serviceSnapshot } = loadedService;
  const fallbackOpenCount = loadedService.proposals.filter(proposal => (proposal.data() || {}).status === 'proposed').length;
  const service = serviceSnapshot.data() || {};
  assertCandidateOwns(service, uid);
  const proposalRef = proposalRefFor(db, serviceId, proposalId);
  const proposalSnapshot = await proposalRef.get();
  if (!proposalSnapshot.exists) throw new ApplicationConciergeError('proposal_not_found', 404);
  const proposal = proposalSnapshot.data() || {};
  // A response may be lost after publication; return its same child on retry.
  if (proposal.status === 'accepted' && validId(proposal.childApplicationId)) {
    const child = (await db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(proposal.childApplicationId).get()).data();
    if (child?.userId === uid && child.parentServiceId === serviceId && child.parentProposalId === proposalId) {
      const fresh = await loadService(db, serviceId);
      return { service: await serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals),
        childApplicationId: proposal.childApplicationId };
    }
  }
  if (proposal.status !== 'proposed') throw new ApplicationConciergeError('proposal_already_decided', 409);
  assertActive(service);
  if (acceptedPositionsCount(service) >= servicePositionLimit(service)) {
    throw new ApplicationConciergeError('position_limit_reached', 409);
  }
  const sourceKey = cvKeyForService(serviceId, service.cvStorageKey);
  if (!sourceKey) throw new ApplicationConciergeError('cv_required', 409);
  if (service.consentVersion !== APPLICATION_CONCIERGE_CONSENT_VERSION || timestampMillis(service.consentedAt) <= 0) {
    throw new ApplicationConciergeError('consent_required', 409);
  }
  if (matchingNeedsVerification(service)
    || proposal.eligibilityStatus !== 'compatible'
    || proposal.eligibilityVersion !== CONCIERGE_ELIGIBILITY_VERSION
    || proposal.eligibilityCvStorageKey !== service.cvStorageKey
    || !proposalUsesCurrentEligibilityFacts(proposal, service)) {
    throw new ApplicationConciergeError('proposal_requires_verification', 409);
  }

  const childRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc();
  const bucket = getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
  const copy = conciergeMaterialCopy({ db, bucket, serviceId, proposalId, targetId: childRef.id,
    uid, source: service, proposal, purpose: 'proposal', operationStartedAt });
  let uploaded;
  try {
    uploaded = await copy.save();
  } catch (error) {
    if (error?.code === 'material_copy_in_progress') {
      throw new ApplicationConciergeError('material_copy_in_progress', 503);
    }
    if (error?.code === 'material_copy_source_missing') {
      throw new ApplicationConciergeError('cv_not_found', 409);
    }
    if (error?.code === 'material_copy_source_invalid') {
      throw new ApplicationConciergeError('invalid_cv_file', 400);
    }
    throw error;
  }
  if (!uploaded) {
    await throwPositionLimitReachedIfCurrent(serviceRef);
    throw new ApplicationConciergeError('proposal_requires_verification', 409);
  }
  const childApplicationId = uploaded.targetId;
  let published;
  try {
    published = await copy.publish((transaction, { service: currentService, proposal: currentProposal,
      key: targetKey, targetId, writeId, nowMs }) => {
      assertCandidateOwns(currentService, uid);
      assertActive(currentService);
      if (!currentProposal || currentProposal.status !== 'proposed') {
        throw new ApplicationConciergeError('proposal_already_decided', 409);
      }
      if (!proposalUsesCurrentEligibilityFacts(currentProposal, currentService)) {
        throw new ApplicationConciergeError('proposal_requires_verification', 409);
      }
      if (matchingNeedsVerification(currentService)
        || currentProposal.eligibilityStatus !== 'compatible'
        || currentProposal.eligibilityVersion !== CONCIERGE_ELIGIBILITY_VERSION
        || currentProposal.eligibilityCvStorageKey !== currentService.cvStorageKey
        || currentService.cvStorageKey !== service.cvStorageKey) {
        throw new ApplicationConciergeError('proposal_requires_verification', 409);
      }
      const accepted = acceptedPositionsCount(currentService);
      const maxPositions = servicePositionLimit(currentService);
      if (accepted >= maxPositions) throw new ApplicationConciergeError('position_limit_reached', 409);
      const openCount = openProposalsCount(currentService, fallbackOpenCount);
      const now = Timestamp.fromMillis(nowMs);
      transaction.set(proposalRef, {
        status: 'accepted',
        acceptedAt: now,
        childApplicationId,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(serviceRef, {
        acceptedPositionsCount: FieldValue.increment(1),
        matchingOpenProposalCount: Math.max(0, openCount - 1),
        matchingFeedbackRevision: FieldValue.increment(1),
        matchingStatus: 'queued',
        matchingError: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(targetId), {
        orderId: childApplicationId,
        userId: currentService.userId,
        billingMode: 'application_concierge',
        parentServiceId: serviceId,
        parentProposalId: proposalId,
        servicePositionNumber: accepted + 1,
        paymentProvider: 'parent_service',
        paymentStatus: 'paid',
        amountTotal: 0,
        currency: currentService.currency || 'eur',
        submissionStatus: 'awaiting_upload',
        locale: candidateCommunicationLocale(currentService),
        jobId: currentProposal.jobId,
        jobUrl: currentProposal.jobUrl,
        companyId: currentProposal.companyId,
        companyName: currentProposal.companyName,
        jobTitle: currentProposal.jobTitle,
        location: currentProposal.location || null,
        applyMode: currentProposal.applyMode || null,
        customerEmail: currentService.customerEmail || currentService.applicantEmail || null,
        applicantName: currentService.applicantName || null,
        applicantEmail: currentService.applicantEmail || null,
        applicantPhone: currentService.applicantPhone || null,
        consentVersion: ASSISTED_APPLICATION_CONSENT_VERSION,
        consentedAt: currentService.consentedAt || now,
        cvStorageKey: targetKey,
        cvMaterialCopyWriteId: writeId,
        cvUploadedAt: now,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
  } catch (error) {
    await copy.abandon().catch(() => {});
    throw error;
  }
  if (!published) {
    await copy.abandon();
    await throwPositionLimitReachedIfCurrent(serviceRef);
    throw new ApplicationConciergeError('proposal_requires_verification', 409);
  }

  const fresh = await loadService(db, serviceId);
  return {
    service: await serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals),
    childApplicationId,
  };
}

async function declineProposal(db, serviceId, proposalId, uid, rawReason = '') {
  if (!validId(serviceId)) throw new ApplicationConciergeError('invalid_service_id', 400);
  if (!validId(proposalId)) throw new ApplicationConciergeError('invalid_proposal_id', 400);
  const serviceRef = serviceRefFor(db, serviceId);
  const proposalRef = proposalRefFor(db, serviceId, proposalId);
  const declineReason = boundedString(rawReason, 30);
  if (declineReason && !CANDIDATE_DECLINE_REASONS.has(declineReason)) {
    throw new ApplicationConciergeError('invalid_decline_reason', 400);
  }
  const existingProposals = await serviceRef.collection('proposals').get();
  const fallbackOpenCount = (existingProposals.docs || []).filter(doc => (doc.data() || {}).status === 'proposed').length;
  await db.runTransaction(async (transaction) => {
    const [serviceSnapshot, proposalSnapshot] = await Promise.all([
      transaction.get(serviceRef),
      transaction.get(proposalRef),
    ]);
    const service = serviceSnapshot.exists ? serviceSnapshot.data() || {} : null;
    assertCandidateOwns(service, uid);
    assertActive(service);
    if (!proposalSnapshot.exists) throw new ApplicationConciergeError('proposal_not_found', 404);
    const proposal = proposalSnapshot.data() || {};
    if (proposal.status !== 'proposed') throw new ApplicationConciergeError('proposal_already_decided', 409);
    const openCount = openProposalsCount(service, fallbackOpenCount);
    transaction.set(proposalRef, {
      status: 'declined',
      declinedAt: Timestamp.now(),
      ...(declineReason ? { declineReason } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(serviceRef, {
      matchingOpenProposalCount: Math.max(0, openCount - 1),
      matchingFeedbackRevision: FieldValue.increment(1),
      matchingStatus: 'queued',
      matchingError: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  const fresh = await loadService(db, serviceId);
  return serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals);
}

async function handleCandidateGet(db, req, uid) {
  const serviceId = serviceIdFromRequest(req);
  if (!serviceId) {
    const collection = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION);
    const query = typeof collection.where === 'function' ? collection.where('userId', '==', uid) : collection;
    const snapshot = await query.get();
    const services = await Promise.all((snapshot.docs || [])
      .filter((doc) => (doc.data() || {}).userId === uid)
      .map(async (doc) => {
        const fresh = await loadService(db, doc.id);
        assertCandidateOwns(fresh.snapshot.data() || {}, uid);
        return serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals);
      }));
    services.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    return { status: 200, body: { ok: true, services } };
  }
  const fresh = await loadService(db, serviceId);
  assertCandidateOwns(fresh.snapshot.data() || {}, uid);
  return { status: 200, body: { ok: true, service: await serializeCandidateApplicationConciergeService(fresh.snapshot, fresh.proposals) } };
}

async function openChildReview(db, serviceId, proposalId, uid) {
  if (!validId(serviceId) || !validId(proposalId)) throw new ApplicationConciergeError('service_not_found', 404);
  const ref = serviceRefFor(db, serviceId);
  const [parentDoc, proposalDoc] = await Promise.all([ref.get(), ref.collection('proposals').doc(proposalId).get()]);
  const parent = parentDoc.data();
  assertCandidateOwns(parent, uid);
  const proposal = proposalDoc.data();
  const withdrawn = proposal?.status === 'declined' && Boolean(proposal?.withdrawnAt);
  if ((proposal?.status !== 'accepted' && !withdrawn) || !validId(proposal.childApplicationId)) throw new ApplicationConciergeError('proposal_not_found', 404);
  const childRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(proposal.childApplicationId);
  const [childDoc, flowDoc] = await Promise.all([childRef.get(), childRef.collection('automation').doc('flow').get()]);
  const child = childDoc.data();
  if (!childDoc.exists || child.userId !== uid || child.parentServiceId !== serviceId || child.parentProposalId !== proposalId
    || child.paymentStatus !== 'paid' || child.retentionPurgedAt || (withdrawn && !child.withdrawnAt)) throw new ApplicationConciergeError('proposal_not_found', 404);
  return mintReviewToken({ secret: await getReviewTokenSecret(), orderId: childRef.id, round: Number(flowDoc.data()?.round) || 1, ttlMs: 60 * 60 * 1000 });
}

export async function handleApplicationConcierge(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const action = method === 'POST' ? boundedString(req.body?.action, 40) : '';
  const decoded = await verifyCaller(req, { checkRevoked: ['recoverPaymentSession', 'openChildReview'].includes(action) });
  if (!decoded?.uid) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const db = getAdminDb();
  try {
    if (method === 'GET') return await handleCandidateGet(db, req, decoded.uid);
    const serviceId = serviceIdFromRequest(req);
    if (action === 'recoverPaymentSession') {
      if (!validId(serviceId)) throw new ApplicationConciergeError('service_not_found', 404);
      const snapshot = await serviceRefFor(db, serviceId).get();
      const service = snapshot.exists ? snapshot.data() || {} : null;
      const recipient = String(service?.customerEmail || service?.applicantEmail || '').trim().toLowerCase();
      const callerEmail = String(decoded.email || '').trim().toLowerCase();
      if (!service || decoded.email_verified !== true || !callerEmail || callerEmail !== recipient
        || !service.userId || service.paymentStatus === 'paid'
        || !['awaiting_payment', 'payment_failed'].includes(service.serviceStatus)) {
        throw new ApplicationConciergeError('service_not_found', 404);
      }
      // Historic unsigned links need an independently verified account first.
      // Preserve the checkout owner instead of transferring records to a new UID.
      const owner = await getAuth().getUser(String(service.userId));
      const ownerEmail = String(owner.email || '').trim().toLowerCase();
      const anonymousOwner = !owner.email && !owner.phoneNumber && !(owner.providerData || []).length;
      if (owner.disabled || (!anonymousOwner && ownerEmail !== callerEmail)) {
        throw new ApplicationConciergeError('service_not_found', 404);
      }
      const authToken = await getAuth().createCustomToken(owner.uid);
      return { status: 200, body: { ok: true, authToken } };
    }
    if (action === 'saveProfile') {
      const service = await saveCandidateProfile(db, serviceId, decoded.uid, req.body || {});
      return { status: 200, body: { ok: true, service } };
    }
    if (action === 'recordConsent') {
      const service = await recordCandidateConsent(db, serviceId, decoded.uid, req.body || {});
      return { status: 200, body: { ok: true, service } };
    }
    if (action === 'saveCandidateLanguageFacts') {
      const service = await saveCandidateLanguageFacts(db, serviceId, decoded.uid, req.body || {});
      return { status: 200, body: { ok: true, service } };
    }
    const proposalId = proposalIdFromRequest(req);
    if (action === 'submitProposalInterest') {
      const service = await submitProposalInterest(db, serviceId, proposalId, decoded.uid, req.body || {});
      return { status: 200, body: { ok: true, service } };
    }
    if (action === 'openChildReview') {
      const token = await openChildReview(db, serviceId, proposalId, decoded.uid);
      return { status: 200, body: { ok: true, token } };
    }
    if (action === 'acceptProposal') {
      const result = await acceptProposal(db, serviceId, proposalId, decoded.uid);
      return { status: 200, body: { ok: true, ...result } };
    }
    if (action === 'declineProposal') {
      const service = await declineProposal(db, serviceId, proposalId, decoded.uid, req.body?.declineReason);
      return { status: 200, body: { ok: true, service } };
    }
    throw new ApplicationConciergeError('invalid_action', 400);
  } catch (error) {
    if (error instanceof ApplicationConciergeError) return { status: error.status, body: { ok: false, error: error.code } };
    throw error;
  }
}

async function createProposal(db, raw, adminEmail) {
  const serviceId = boundedString(raw.serviceId, 200);
  if (!validId(serviceId)) throw new ApplicationConciergeError('invalid_service_id', 400);
  const serviceRef = serviceRefFor(db, serviceId);
  const snapshot = await serviceRef.get();
  if (!snapshot.exists) throw new ApplicationConciergeError('service_not_found', 404);
  const service = snapshot.data() || {};
  const evaluatedFactsRevision = eligibilityFactsRevision(service);
  assertActive(service);
  if (acceptedPositionsCount(service) >= servicePositionLimit(service)) {
    throw new ApplicationConciergeError('position_limit_reached', 409);
  }
  const job = proposalJobData(raw);
  const existing = await serviceRef.collection('proposals').get();
  const fallbackOpenCount = (existing.docs || []).filter(doc => (doc.data() || {}).status === 'proposed').length;
  if ((existing.docs || []).some((doc) => {
    const data = doc.data() || {};
    return data.jobId === job.jobId || data.jobUrl === job.jobUrl;
  })) throw new ApplicationConciergeError('duplicate_proposal', 409);
  const profileRecord = (await db.collection('user_cv_profiles').doc(service.userId).get()).data() || {};
  const evaluate = await prepareConciergeEligibility({ db, serviceRef, service, profileRecord });
  const qualification = await evaluate({ id: job.jobId, url: job.jobUrl, title: job.jobTitle, company: job.companyName });
  if (qualification.status !== 'compatible') throw new ApplicationConciergeError('proposal_requires_verification', 409);
  const proposalRef = serviceRef.collection('proposals').doc(proposalDocumentId(serviceId, {
    id: job.jobId, url: job.jobUrl, title: job.jobTitle, company: job.companyName,
  }, job.jobUrl));
  const proposal = {
    ...job,
    status: 'proposed',
    eligibilityStatus: qualification.status, eligibilityVersion: CONCIERGE_ELIGIBILITY_VERSION,
    eligibilityFactsRevision: evaluatedFactsRevision,
    eligibilityCacheId: qualification.cacheId, eligibilityFingerprint: qualification.fingerprint,
    eligibilityCvStorageKey: service.cvStorageKey,
    eligibilityCheckedAt: Timestamp.now(),
    rankingFeatures: rankingFeaturesForJob({
      id: job.jobId, url: job.jobUrl, title: job.jobTitle, company: job.companyName, location: job.location,
      applyMode: job.applyMode,
    }),
    matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
    createdBy: adminEmail,
    createdAt: FieldValue.serverTimestamp(),
    proposedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.runTransaction(async transaction => {
    const [currentServiceSnapshot, currentProposalSnapshot] = await Promise.all([
      transaction.get(serviceRef), transaction.get(proposalRef),
    ]);
    const currentService = currentServiceSnapshot.data() || {};
    if (!currentServiceSnapshot.exists || !serviceIsActive(currentService)) throw new ApplicationConciergeError('service_not_active', 409);
    if (currentService.cvStorageKey !== service.cvStorageKey
      || !proposalUsesCurrentEligibilityFacts({ eligibilityFactsRevision: evaluatedFactsRevision }, currentService)) {
      throw new ApplicationConciergeError('proposal_requires_verification', 409);
    }
    if (currentProposalSnapshot.exists) throw new ApplicationConciergeError('duplicate_proposal', 409);
    if (acceptedPositionsCount(currentService) >= servicePositionLimit(currentService)) {
      throw new ApplicationConciergeError('position_limit_reached', 409);
    }
    const openCount = openProposalsCount(currentService, fallbackOpenCount);
    if (openCount >= APPLICATION_CONCIERGE_MAX_OPEN_PROPOSALS) throw new ApplicationConciergeError('proposal_limit_reached', 409);
    transaction.set(serviceRef, { matchingOpenProposalCount: openCount + 1 }, { merge: true });
    transaction.set(proposalRef, proposal);
  });
  const fresh = await loadService(db, serviceId);
  return serializeApplicationConciergeService(fresh.snapshot, fresh.proposals, { admin: true });
}

export async function handleManageApplicationConcierge(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const auth = await assertSiteAdmin(req);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };
  const db = getAdminDb();
  try {
    if (method === 'POST') {
      if (boundedString(req.body?.action, 40) !== 'createProposal') throw new ApplicationConciergeError('invalid_action', 400);
      const service = await createProposal(db, req.body || {}, auth.email);
      await writeAdminAuditLog({
        db,
        auth,
        action: 'application_concierge_proposal_create',
        target: boundedString(req.body?.serviceId, 200),
        status: 200,
        details: { jobId: boundedString(req.body?.jobId, 200) },
      });
      return { status: 200, body: { ok: true, service } };
    }
    const snapshot = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).get();
    const services = await Promise.all((snapshot.docs || []).map(async (doc) => {
      const fresh = await loadService(db, doc.id);
      return serializeApplicationConciergeService(fresh.snapshot, fresh.proposals, { admin: true });
    }));
    services.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    return { status: 200, body: { ok: true, services } };
  } catch (error) {
    if (error instanceof ApplicationConciergeError) return { status: error.status, body: { ok: false, error: error.code } };
    throw error;
  }
}

/** Daily backstop: acceptance is also expiry-gated, so a late sweep is safe. */
export async function expireApplicationConciergeServices({ db = getAdminDb(), nowMs = Date.now() } = {}) {
  const snapshot = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION)
    .where('serviceStatus', '==', 'active')
    .get();
  let expired = 0;
  for (const doc of snapshot.docs || []) {
    const service = doc.data() || {};
    if (!serviceIsExpired(service, nowMs)) continue;
    const proposals = await doc.ref.collection('proposals').get();
    const batch = db.batch();
    batch.set(doc.ref, {
      serviceStatus: 'expired',
      matchingOpenProposalCount: 0,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    for (const proposal of proposals.docs || []) {
      if ((proposal.data() || {}).status === 'proposed') {
        batch.set(proposal.ref, { status: 'expired', expiredAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    }
    await batch.commit();
    expired += 1;
  }
  return { expired };
}
