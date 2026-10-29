import { getAdminDb } from './newsletterResendWebhookCore.js';
import { verifyCaller } from './stripePublisherCore.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { candidateStatusForAssistedApplication } from './assistedApplicationCandidateStatusCore.js';
import { flowRefFor } from './assistedApplicationAutomation.js';
import {
  buildOrderPageUrl,
  buildReviewPageUrl,
  resolveOrderLocale,
  submittedReviewUrl,
} from './assistedApplicationNotifications.js';
import { getReviewTokenSecret, mintReviewToken } from './assistedApplicationReviewToken.js';

export { candidateStatusForAssistedApplication } from './assistedApplicationCandidateStatusCore.js';

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

function safeHttpsUrl(value) {
  const candidate = boundedText(value, 2048);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function candidateLocation(value) {
  const location = boundedText(value, 240).replace(/\s+/g, ' ').slice(0, 180);
  return location || null;
}

async function applicationUrlFor(db, orderId, order, status, getSecret) {
  const locale = resolveOrderLocale(order);
  const orderPageUrl = buildOrderPageUrl(order, orderId, locale);

  try {
    if (status === 'needs_candidate') {
      const snapshot = await flowRefFor(db, orderId).get();
      const flow = snapshot.exists ? snapshot.data() || {} : {};
      if (!CANDIDATE_ACTION_STATES.has(flow.state)) return orderPageUrl;

      const token = mintReviewToken({
        secret: await getSecret(),
        orderId,
        round: flow.round,
      });
      return buildReviewPageUrl(order, token, locale);
    }

    if (status === 'submitted') {
      return await submittedReviewUrl({ db, orderId, order, getSecret }) || orderPageUrl;
    }
  } catch {
    // The stable authenticated order page remains useful when a review token
    // cannot be minted (for example during a secret rotation or after expiry).
  }

  return orderPageUrl;
}

async function serializeCandidateApplication(db, doc, order, getSecret) {
  const status = candidateStatusForAssistedApplication(order);
  return {
    orderId: boundedText(doc.id, 200),
    jobTitle: boundedText(order.jobTitle, 300),
    companyName: boundedText(order.companyName, 200),
    companyKey: boundedText(order.companyId || order.companyName, 200) || null,
    location: candidateLocation(order.location),
    jobUrl: safeHttpsUrl(order.jobUrl),
    source: order.billingMode === 'application_concierge' ? 'concierge' : 'single',
    status,
    updatedAt: latestIsoDate(order.automationUpdatedAt, order.updatedAt, order.statusChangedAt, order.createdAt),
    requiresCvUpload: status === 'awaiting_materials',
    applicationUrl: await applicationUrlFor(db, doc.id, order, status, getSecret),
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

  const db = await getDb();
  const snapshot = await db
    .collection(ASSISTED_APPLICATIONS_COLLECTION)
    .where('userId', '==', decoded.uid)
    .get();

  let reviewSecretPromise = null;
  const getSecret = () => {
    reviewSecretPromise ||= getReviewTokenSecret();
    return reviewSecretPromise;
  };
  const eligible = (snapshot.docs || [])
    .map((doc) => ({ doc, order: doc.data() || {} }))
    .filter(({ order }) => order.userId === decoded.uid
      && (order.paymentStatus === 'paid'
        || order.paymentStatus === 'refunded'
        || order.submissionStatus === 'refunded'));
  const applications = (await Promise.all(eligible.map(({ doc, order }) => (
    serializeCandidateApplication(db, doc, order, getSecret)
  ))))
    .filter((application) => application.orderId)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

  return { status: 200, body: { ok: true, applications } };
}
