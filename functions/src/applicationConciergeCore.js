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
import { randomUUID } from 'node:crypto';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { assertAdmin } from './adminEmployerInsights.js';
import { verifyCaller } from './stripePublisherCore.js';
import { ASSISTED_APPLICATION_CONSENT_VERSION } from './assistedApplicationCheckout.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import {
  APPLICATION_CONCIERGE_CONSENT_VERSION,
  APPLICATION_CONCIERGE_CV_PREFIX,
  APPLICATION_CONCIERGE_MAX_POSITIONS,
  APPLICATION_CONCIERGE_PROPOSAL_STATUSES,
  APPLICATION_CONCIERGE_SERVICES_COLLECTION,
  acceptedPositionsCount,
  serviceIsActive,
  serviceIsExpired,
  timestampMillis,
} from './applicationConciergeConstants.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CV_BYTES = 5 * 1024 * 1024;
const CV_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

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

function timestampToIso(value) {
  const millis = timestampMillis(value);
  return millis > 0 ? new Date(millis).toISOString() : null;
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

function extensionForCvKey(key) {
  const extension = String(key || '').split('.').pop()?.toLowerCase() || 'pdf';
  return ['pdf', 'doc', 'docx'].includes(extension) ? extension : 'pdf';
}

function serializeProposal(doc) {
  const data = doc.data() || {};
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
    createdAt: timestampToIso(data.createdAt),
    proposedAt: timestampToIso(data.proposedAt || data.createdAt),
    acceptedAt: timestampToIso(data.acceptedAt),
    declinedAt: timestampToIso(data.declinedAt),
    childApplicationId: optionalString(data.childApplicationId, 200),
    matchScore: Number.isFinite(Number(data.matchScore)) ? Number(data.matchScore) : null,
    matchReasons: Array.isArray(data.matchReasons) ? data.matchReasons.map((value) => boundedString(value, 180)).filter(Boolean).slice(0, 6) : [],
    matchedAt: timestampToIso(data.matchedAt),
    source: optionalString(data.source, 80),
  };
}

export function serializeApplicationConciergeService(doc, proposalDocs = [], { admin = false } = {}) {
  const data = doc.data ? doc.data() || {} : doc || {};
  const serviceId = doc.id || data.serviceId;
  const expired = serviceIsExpired(data);
  return {
    serviceId,
    serviceType: 'application_concierge',
    plan: boundedString(data.plan, 80) || '30d-10-positions',
    paymentStatus: boundedString(data.paymentStatus, 40),
    serviceStatus: expired && data.serviceStatus === 'active' ? 'expired' : boundedString(data.serviceStatus, 40),
    paymentProvider: boundedString(data.paymentProvider, 40),
    renewal: data.renewal === true,
    maxPositions: Number(data.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS,
    acceptedPositionsCount: acceptedPositionsCount(data),
    remainingPositions: Math.max(0, (Number(data.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS) - acceptedPositionsCount(data)),
    paidAt: timestampToIso(data.paidAt),
    expiresAt: timestampToIso(data.expiresAt),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    customerEmail: optionalString(data.customerEmail, 320),
    applicantName: optionalString(data.applicantName, 200),
    applicantEmail: optionalString(data.applicantEmail, 320),
    applicantPhone: optionalString(data.applicantPhone, 80),
    hasConsent: data.consentVersion === APPLICATION_CONCIERGE_CONSENT_VERSION && timestampMillis(data.consentedAt) > 0,
    hasCv: Boolean(cvKeyForService(serviceId, data.cvStorageKey)),
    consentedAt: timestampToIso(data.consentedAt),
    cvUploadedAt: timestampToIso(data.cvUploadedAt),
    cvFileName: optionalString(data.cvFileName, 180) || (cvKeyForService(serviceId, data.cvStorageKey)?.split('/').pop() || null),
    cvProfileStatus: optionalString(data.cvProfileStatus, 40),
    matchingStatus: optionalString(data.matchingStatus, 40),
    matchingJobCount: Number.isFinite(Number(data.matchingJobCount)) ? Number(data.matchingJobCount) : null,
    matchingStartedAt: timestampToIso(data.matchingStartedAt),
    matchingCompletedAt: timestampToIso(data.matchingCompletedAt),
    matchingError: optionalString(data.matchingError, 80),
    proposals: proposalDocs.map(serializeProposal),
    ...(admin ? {
      userId: optionalString(data.userId, 200),
      consentVersion: optionalString(data.consentVersion, 120),
      cvStorageKey: cvKeyForService(serviceId, data.cvStorageKey) || null,
    } : {}),
  };
}

async function loadService(db, serviceId) {
  if (!validId(serviceId)) throw new ApplicationConciergeError('invalid_service_id', 400);
  const ref = serviceRefFor(db, serviceId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new ApplicationConciergeError('service_not_found', 404);
  const proposals = await ref.collection('proposals').get();
  return { ref, snapshot, proposals: proposals.docs || [] };
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
  return serializeApplicationConciergeService(fresh.snapshot, fresh.proposals);
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
    ...(alreadyRecorded ? {} : {
      consentVersion: APPLICATION_CONCIERGE_CONSENT_VERSION,
      consentedAt: Timestamp.now(),
    }),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const fresh = await loadService(db, serviceId);
  return serializeApplicationConciergeService(fresh.snapshot, fresh.proposals);
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

async function acceptProposal(db, serviceId, proposalId, uid) {
  if (!validId(proposalId)) throw new ApplicationConciergeError('invalid_proposal_id', 400);
  const { ref: serviceRef, snapshot: serviceSnapshot } = await loadService(db, serviceId);
  const service = serviceSnapshot.data() || {};
  assertCandidateOwns(service, uid);
  assertActive(service);
  const sourceKey = cvKeyForService(serviceId, service.cvStorageKey);
  if (!sourceKey) throw new ApplicationConciergeError('cv_required', 409);
  if (service.consentVersion !== APPLICATION_CONCIERGE_CONSENT_VERSION || timestampMillis(service.consentedAt) <= 0) {
    throw new ApplicationConciergeError('consent_required', 409);
  }

  const proposalRef = proposalRefFor(db, serviceId, proposalId);
  const proposalSnapshot = await proposalRef.get();
  if (!proposalSnapshot.exists) throw new ApplicationConciergeError('proposal_not_found', 404);
  const proposal = proposalSnapshot.data() || {};
  if (proposal.status !== 'proposed') throw new ApplicationConciergeError('proposal_already_decided', 409);

  const childRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc();
  const extension = extensionForCvKey(sourceKey);
  const targetKey = `assisted-application-uploads/${childRef.id}/${Date.now()}-${randomUUID()}-cv.${extension}`;
  const bucket = getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
  let childApplicationId;
  try {
    const [exists] = await bucket.file(sourceKey).exists();
    if (!exists) throw new ApplicationConciergeError('cv_not_found', 409);
    await bucket.file(sourceKey).copy(bucket.file(targetKey));

    await db.runTransaction(async (transaction) => {
      const [currentServiceSnapshot, currentProposalSnapshot] = await Promise.all([
        transaction.get(serviceRef),
        transaction.get(proposalRef),
      ]);
      const currentService = currentServiceSnapshot.exists ? currentServiceSnapshot.data() || {} : null;
      const currentProposal = currentProposalSnapshot.exists ? currentProposalSnapshot.data() || {} : null;
      assertCandidateOwns(currentService, uid);
      assertActive(currentService);
      if (!currentProposalSnapshot.exists || currentProposal.status !== 'proposed') {
        throw new ApplicationConciergeError('proposal_already_decided', 409);
      }
      const accepted = acceptedPositionsCount(currentService);
      const maxPositions = Number(currentService.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS;
      if (accepted >= maxPositions) throw new ApplicationConciergeError('position_limit_reached', 409);
      childApplicationId = childRef.id;
      const now = Timestamp.now();
      transaction.set(proposalRef, {
        status: 'accepted',
        acceptedAt: now,
        childApplicationId,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(serviceRef, {
        acceptedPositionsCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(childRef, {
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
        cvUploadedAt: now,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    await bucket.file(targetKey).delete({ ignoreNotFound: true }).catch(() => {});
    throw error;
  }

  const fresh = await loadService(db, serviceId);
  return {
    service: serializeApplicationConciergeService(fresh.snapshot, fresh.proposals),
    childApplicationId,
  };
}

async function declineProposal(db, serviceId, proposalId, uid) {
  if (!validId(proposalId)) throw new ApplicationConciergeError('invalid_proposal_id', 400);
  const serviceRef = serviceRefFor(db, serviceId);
  const proposalRef = proposalRefFor(db, serviceId, proposalId);
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
    transaction.set(proposalRef, { status: 'declined', declinedAt: Timestamp.now(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  const fresh = await loadService(db, serviceId);
  return serializeApplicationConciergeService(fresh.snapshot, fresh.proposals);
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
        const serviceRef = doc.ref || doc;
        const proposals = await serviceRef.collection('proposals').get();
        return serializeApplicationConciergeService(doc, proposals.docs || []);
      }));
    services.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    return { status: 200, body: { ok: true, services } };
  }
  const fresh = await loadService(db, serviceId);
  assertCandidateOwns(fresh.snapshot.data() || {}, uid);
  return { status: 200, body: { ok: true, service: serializeApplicationConciergeService(fresh.snapshot, fresh.proposals) } };
}

export async function handleApplicationConcierge(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const decoded = await verifyCaller(req);
  if (!decoded?.uid) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const db = getAdminDb();
  try {
    if (method === 'GET') return await handleCandidateGet(db, req, decoded.uid);
    const serviceId = serviceIdFromRequest(req);
    const action = boundedString(req.body?.action, 40);
    if (action === 'saveProfile') {
      const service = await saveCandidateProfile(db, serviceId, decoded.uid, req.body || {});
      return { status: 200, body: { ok: true, service } };
    }
    if (action === 'recordConsent') {
      const service = await recordCandidateConsent(db, serviceId, decoded.uid, req.body || {});
      return { status: 200, body: { ok: true, service } };
    }
    const proposalId = proposalIdFromRequest(req);
    if (action === 'acceptProposal') {
      const result = await acceptProposal(db, serviceId, proposalId, decoded.uid);
      return { status: 200, body: { ok: true, ...result } };
    }
    if (action === 'declineProposal') {
      const service = await declineProposal(db, serviceId, proposalId, decoded.uid);
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
  assertActive(service);
  if (acceptedPositionsCount(service) >= (Number(service.maxPositions) || APPLICATION_CONCIERGE_MAX_POSITIONS)) {
    throw new ApplicationConciergeError('position_limit_reached', 409);
  }
  const job = proposalJobData(raw);
  const existing = await serviceRef.collection('proposals').get();
  if ((existing.docs || []).some((doc) => {
    const data = doc.data() || {};
    return data.status !== 'declined' && (data.jobId === job.jobId || data.jobUrl === job.jobUrl);
  })) throw new ApplicationConciergeError('duplicate_proposal', 409);
  const proposalRef = serviceRef.collection('proposals').doc();
  await proposalRef.set({
    ...job,
    status: 'proposed',
    createdBy: adminEmail,
    createdAt: FieldValue.serverTimestamp(),
    proposedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const fresh = await loadService(db, serviceId);
  return serializeApplicationConciergeService(fresh.snapshot, fresh.proposals, { admin: true });
}

export async function handleManageApplicationConcierge(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  const auth = await assertAdmin(req);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };
  const db = getAdminDb();
  try {
    if (method === 'POST') {
      if (boundedString(req.body?.action, 40) !== 'createProposal') throw new ApplicationConciergeError('invalid_action', 400);
      return { status: 200, body: { ok: true, service: await createProposal(db, req.body || {}, auth.adminEmail) } };
    }
    const snapshot = await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).get();
    const services = await Promise.all((snapshot.docs || []).map(async (doc) => {
      const proposals = await doc.ref.collection('proposals').get();
      return serializeApplicationConciergeService(doc, proposals.docs || [], { admin: true });
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
    batch.set(doc.ref, { serviceStatus: 'expired', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
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
