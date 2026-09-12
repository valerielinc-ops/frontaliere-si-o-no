/**
 * Server-side signing gate for the Stabio-Gaggiolo petition.
 *
 * The browser may collect consent and authenticate, but it must not be able to
 * mint a signature or increment a public counter by writing Firestore directly.
 * One private document per verified Auth uid makes retries idempotent and keeps
 * the signature collection free of email addresses.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { hasConfirmationProof } from './lib/subscriberConsent.js';

export const PETITION_ID = 'stabio-dosso';
export const PETITION_SIGNATURES_COLLECTION = 'petition_signatures';
export const PETITION_META_COLLECTION = 'petition_meta';

const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const NEWSLETTER_BLOCKED_STATUSES = new Set([
  'unsubscribed',
  'bounced',
  'complained',
  'suppressed',
  'expired',
]);

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email && email.includes('@') ? email : '';
}

function normalizeLocale(value) {
  const locale = String(value || '').trim().toLowerCase();
  return LOCALES.has(locale) ? locale : null;
}

function normalizeSourcePath(value) {
  const source = String(value || '').trim().split(/[?#]/, 1)[0];
  if (!source || !source.startsWith('/') || source.length > 200) return null;
  return source;
}

/**
 * Newsletter eligibility is intentionally stricter than `status === confirmed`.
 * A historical silent-auth row may look active while carrying no displayed
 * communications notice; it cannot unlock this petition's newsletter gate.
 */
export function isPetitionNewsletterEligible(subscriber) {
  if (!subscriber || typeof subscriber !== 'object') return false;
  const status = String(subscriber.status || '').trim().toLowerCase();
  if (NEWSLETTER_BLOCKED_STATUSES.has(status)) return false;
  if (status !== 'confirmed' && status !== 'subscribed') return false;
  if (subscriber.isActive !== true && subscriber.active !== true) return false;
  if (subscriber.consent_given !== true && subscriber.consentGiven !== true) return false;
  return hasConfirmationProof(subscriber);
}

/** Pure request decision used by the HTTP handler and unit tests. */
export function decidePetitionSign({ method, token, petitionId, subscriber }) {
  if (String(method || '').toUpperCase() !== 'POST') {
    return { ok: false, status: 405, error: 'method_not_allowed' };
  }
  if (!token?.uid || token.email_verified !== true || !normalizeEmail(token.email)) {
    return { ok: false, status: 401, error: 'verified_account_required' };
  }
  if (petitionId !== PETITION_ID) {
    return { ok: false, status: 400, error: 'invalid_petition' };
  }
  if (!isPetitionNewsletterEligible(subscriber)) {
    return { ok: false, status: 403, error: 'newsletter_required' };
  }
  const tokenEmail = normalizeEmail(token.email);
  const subscriberEmail = normalizeEmail(subscriber.email);
  if (subscriberEmail && subscriberEmail !== tokenEmail) {
    return { ok: false, status: 403, error: 'account_email_mismatch' };
  }
  return { ok: true, email: tokenEmail };
}

function resultBody({ alreadySigned = false } = {}) {
  return {
    success: true,
    signed: true,
    ...(alreadySigned ? { alreadySigned: true } : {}),
  };
}

/**
 * Execute the idempotent Firestore write. `db` is injectable for tests and for
 * local emulators; production callers use the Admin SDK database by default.
 */
export async function handlePetitionSign({
  method,
  token,
  petitionId,
  locale,
  sourcePath,
  db: injectedDb,
} = {}) {
  const normalizedLocale = normalizeLocale(locale);
  if (!normalizedLocale) {
    return { status: 400, body: { success: false, error: 'invalid_locale' } };
  }

  // Reject malformed/anonymous requests before building a Firestore document
  // reference. `doc('')` is itself an invalid Firestore path and would turn a
  // normal 401 into a misleading 500 from the outer HTTP handler.
  const requestEmail = normalizeEmail(token?.email);
  const requestDecision = decidePetitionSign({
    method,
    token,
    petitionId,
    subscriber: null,
  });
  if (!requestDecision.ok && requestDecision.error !== 'newsletter_required') {
    return { status: requestDecision.status, body: { success: false, error: requestDecision.error } };
  }
  if (!requestEmail) {
    return { status: 401, body: { success: false, error: 'verified_account_required' } };
  }

  const db = injectedDb || getAdminDb();
  const email = requestEmail;
  const subscriberRef = db.collection('newsletter_subscribers').doc(email);
  const subscriberSnap = email ? await subscriberRef.get() : null;
  const subscriber = subscriberSnap?.exists ? subscriberSnap.data() : null;
  const decision = decidePetitionSign({ method, token, petitionId, subscriber });
  if (!decision.ok) return { status: decision.status, body: { success: false, error: decision.error } };

  const signatureRef = db.collection(PETITION_SIGNATURES_COLLECTION).doc(token.uid);
  const metaRef = db.collection(PETITION_META_COLLECTION).doc(PETITION_ID);
  const safeSourcePath = normalizeSourcePath(sourcePath);

  const body = await db.runTransaction(async (transaction) => {
    // Every read happens before a write so Firestore can retry the complete
    // decision atomically if an unsubscribe or duplicate sign races this one.
    const [currentSubscriberSnap, signatureSnap] = await Promise.all([
      transaction.get(subscriberRef),
      transaction.get(signatureRef),
    ]);
    if (signatureSnap.exists) return resultBody({ alreadySigned: true });

    const currentSubscriber = currentSubscriberSnap.exists ? currentSubscriberSnap.data() : null;
    const currentDecision = decidePetitionSign({ method, token, petitionId, subscriber: currentSubscriber });
    if (!currentDecision.ok) {
      return { success: false, error: currentDecision.error, rejected: true };
    }

    transaction.create(signatureRef, {
      petitionId: PETITION_ID,
      uid: token.uid,
      locale: normalizedLocale,
      sourcePath: safeSourcePath,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(metaRef, {
      petitionId: PETITION_ID,
      signatureCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return resultBody();
  });

  if (body.rejected) {
    return { status: 403, body: { success: false, error: body.error } };
  }
  return { status: 200, body };
}
