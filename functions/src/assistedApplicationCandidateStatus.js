import { getAdminDb } from './newsletterResendWebhookCore.js';
import { verifyCaller } from './stripePublisherCore.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';

const CANDIDATE_ACTION_STATES = new Set([
  'candidate_review',
  'needs_candidate_action',
  'candidate_handoff',
]);

function isoDate(value) {
  if (value == null) return null;
  let date;
  if (typeof value.toDate === 'function') date = value.toDate();
  else if (typeof value.toMillis === 'function') date = new Date(value.toMillis());
  else if (value instanceof Date) date = value;
  else if (typeof value === 'number') date = new Date(value);
  else date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestIsoDate(...values) {
  return values
    .map(isoDate)
    .filter((value) => value !== null)
    .reduce((latest, value) => (
      !latest || Date.parse(value) > Date.parse(latest) ? value : latest
    ), null);
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function candidateStatusForAssistedApplication(order) {
  const submissionStatus = boundedText(order?.submissionStatus, 80);
  const automationState = boundedText(order?.automationState, 80);

  if (order?.paymentStatus === 'refunded' || submissionStatus === 'refunded') return 'refunded';
  if (submissionStatus === 'submitted' || automationState === 'submitted') return 'submitted';
  if (CANDIDATE_ACTION_STATES.has(automationState)) return 'needs_candidate';
  if (submissionStatus === 'blocked' || ['failed', 'owner_takeover'].includes(automationState)) return 'under_review';
  if (submissionStatus === 'awaiting_upload' && !boundedText(order?.cvStorageKey, 300)) return 'awaiting_materials';
  return 'in_progress';
}

function serializeCandidateApplication(doc, order) {
  const status = candidateStatusForAssistedApplication(order);
  return {
    orderId: boundedText(doc.id, 200),
    jobTitle: boundedText(order.jobTitle, 300),
    companyName: boundedText(order.companyName, 200),
    source: order.billingMode === 'application_concierge' ? 'concierge' : 'single',
    status,
    updatedAt: latestIsoDate(order.automationUpdatedAt, order.updatedAt, order.statusChangedAt, order.createdAt),
    requiresCvUpload: status === 'awaiting_materials',
  };
}

/**
 * Lists only the caller's paid assisted applications. A concierge proposal
 * becomes a row here only after acceptance creates its paid child order.
 * The response is an explicit public projection: it never includes CV keys,
 * candidate contact details, internal notes, or automation payloads.
 */
export async function handleListMyAssistedApplications(
  req,
  { getDb = getAdminDb, verify = verifyCaller } = {},
) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const decoded = await verify(req);
  if (!decoded?.uid) return { status: 401, body: { ok: false, error: 'unauthenticated' } };

  const snapshot = await getDb()
    .collection(ASSISTED_APPLICATIONS_COLLECTION)
    .where('userId', '==', decoded.uid)
    .get();

  const applications = (snapshot.docs || [])
    .map((doc) => ({ doc, order: doc.data() || {} }))
    .filter(({ order }) => order.userId === decoded.uid
      && (order.paymentStatus === 'paid'
        || order.paymentStatus === 'refunded'
        || order.submissionStatus === 'refunded'))
    .map(({ doc, order }) => serializeCandidateApplication(doc, order))
    .filter((application) => application.orderId)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

  return { status: 200, body: { ok: true, applications } };
}
