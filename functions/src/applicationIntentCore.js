/**
 * Server-side application-intent writer for the job-board "Candidati" click.
 *
 * The click is an explicit consent signal for recording interest in a listing;
 * it is not evidence that the employer received or completed an application.
 * The browser may submit the displayed consent copy, but only this module can
 * write the Firestore record. A deterministic document id makes retries and
 * double delivery one logical intent per actor and stable job key.
 */

import { createHash } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import {
  anonymizeIp,
  extractClientIp,
  truncateUserAgent,
} from './lib/requestForensics.js';

export const APPLICATION_INTENTS_COLLECTION = 'application_intents';
export const APPLICATION_INTENT_CONSENT_VERSION = 'application-intent-v1';
export const APPLICATION_INTENT_STATUS = 'redirect_only';
export const APPLICATION_INTENT_RETENTION_DAYS = 90;

// These limits are part of the storage contract. They bound attacker-controlled
// strings and keep a consent proof useful without turning it into an arbitrary
// document-sized payload.
export const APPLICATION_INTENT_LIMITS = Object.freeze({
  jobKey: 240,
  jobSlug: 200,
  companyKey: 160,
  jobTitle: 240,
  origin: 240,
  surface: 80,
  consentText: 1000,
  clientIdentifier: 128,
  identifier: 128,
});

const MAX_RETRY_COUNT = 8;

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredBounded(value, max) {
  const normalized = trimmedString(value);
  return normalized && normalized.length <= max ? normalized : '';
}

function optionalBounded(value, max) {
  const normalized = trimmedString(value);
  return normalized ? normalized.slice(0, max) : null;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function requestUserAgent(req) {
  const value = typeof req?.get === 'function'
    ? req.get('user-agent')
    : req?.headers?.['user-agent'];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function bearerToken(req) {
  const header = typeof req?.get === 'function'
    ? req.get('Authorization') || req.get('authorization')
    : req?.headers?.authorization || req?.headers?.Authorization;
  const match = String(header || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

/**
 * Optional authentication: anonymous visitors can record an intent using a
 * local opaque identifier, while a verified Firebase uid is preferred when it
 * is available. An invalid optional token never upgrades the caller's
 * identity; it falls back to the anonymous path.
 */
export async function verifyOptionalApplicationIntentCaller(req) {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    return await getAuth().verifyIdToken(token);
  } catch {
    return null;
  }
}

function normalizedClientIdentifier(value) {
  const candidate = requiredBounded(value, APPLICATION_INTENT_LIMITS.clientIdentifier);
  return /^[A-Za-z0-9_-]{16,128}$/.test(candidate) ? candidate : '';
}

function actorIdentity({ token, clientIdentifier, ipAnonymized, userAgent }) {
  const uid = requiredBounded(token?.uid, APPLICATION_INTENT_LIMITS.identifier);
  if (uid) {
    return {
      identifier: uid,
      identifierType: 'firebase_uid',
      identityKey: `uid:${uid}`,
    };
  }

  if (clientIdentifier) {
    const identifier = sha256(`client:${clientIdentifier}`).slice(0, APPLICATION_INTENT_LIMITS.identifier);
    return {
      identifier,
      identifierType: 'anonymous_client',
      identityKey: `client:${identifier}`,
    };
  }

  // The browser normally supplies clientIdentifier. This fallback keeps a
  // server-only caller deterministic without storing a raw IP or UA.
  const identifier = sha256(`request:${ipAnonymized || ''}|${userAgent || ''}`).slice(
    0,
    APPLICATION_INTENT_LIMITS.identifier,
  );
  return {
    identifier,
    identifierType: 'anonymous_request',
    identityKey: `request:${identifier}`,
  };
}

export function buildApplicationIntentId({ identityKey, jobKey }) {
  const normalizedIdentity = requiredBounded(identityKey, 256);
  const normalizedJobKey = requiredBounded(jobKey, APPLICATION_INTENT_LIMITS.jobKey);
  if (!normalizedIdentity || !normalizedJobKey) return '';
  return `ai_${sha256(`${normalizedIdentity}\u0000${normalizedJobKey}`).slice(0, 48)}`;
}

/**
 * Validate and normalize only the fields the writer owns. Unknown request
 * fields are intentionally ignored, including any attempted
 * `application_completed` value.
 */
export function normalizeApplicationIntentRequest(body = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const jobKey = requiredBounded(source.jobKey, APPLICATION_INTENT_LIMITS.jobKey);
  const origin = requiredBounded(source.origin, APPLICATION_INTENT_LIMITS.origin);
  const surface = requiredBounded(source.surface, APPLICATION_INTENT_LIMITS.surface);
  const consentVersion = requiredBounded(source.consentVersion, 80);
  const consentText = requiredBounded(source.consentText, APPLICATION_INTENT_LIMITS.consentText);
  const clientIdentifier = normalizedClientIdentifier(source.clientIdentifier || source.visitorId);

  if (!jobKey || !origin || !surface || !consentText) {
    return { ok: false, error: 'invalid_application_intent' };
  }
  if (consentVersion !== APPLICATION_INTENT_CONSENT_VERSION) {
    return { ok: false, error: 'invalid_consent_version' };
  }

  return {
    ok: true,
    input: {
      jobKey,
      jobSlug: optionalBounded(source.jobSlug, APPLICATION_INTENT_LIMITS.jobSlug),
      companyKey: optionalBounded(source.companyKey, APPLICATION_INTENT_LIMITS.companyKey),
      jobTitle: optionalBounded(source.jobTitle, APPLICATION_INTENT_LIMITS.jobTitle),
      origin,
      surface,
      consentVersion,
      consentText,
      clientIdentifier,
    },
  };
}

export function buildApplicationIntentRecord({ req, token, input, now = Date.now() }) {
  const ipAnonymized = anonymizeIp(extractClientIp(req));
  const userAgent = truncateUserAgent(requestUserAgent(req));
  const identity = actorIdentity({
    token,
    clientIdentifier: input.clientIdentifier,
    ipAnonymized,
    userAgent,
  });
  const intentId = buildApplicationIntentId({ identityKey: identity.identityKey, jobKey: input.jobKey });
  if (!intentId) return null;

  const retentionUntil = new Date(
    Number(now) + APPLICATION_INTENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  return {
    intentId,
    jobKey: input.jobKey,
    jobSlug: input.jobSlug,
    companyKey: input.companyKey,
    jobTitle: input.jobTitle,
    origin: input.origin,
    surface: input.surface,
    identifier: identity.identifier,
    identifierType: identity.identifierType,
    consentVersion: input.consentVersion,
    consentText: input.consentText,
    application_status: APPLICATION_INTENT_STATUS,
    timestamp: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    retentionUntil,
    retryCount: 0,
    ipAnonymized,
    userAgent,
  };
}

function boundedRetryCount(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return 0;
  return Math.min(number, MAX_RETRY_COUNT);
}

/**
 * Persist one logical intent. The transaction is the idempotency boundary:
 * concurrent first deliveries cannot create two records, and retries only
 * update a bounded retry counter without changing the original consent proof.
 */
export async function persistApplicationIntent({ db, record }) {
  const intentRef = db.collection(APPLICATION_INTENTS_COLLECTION).doc(record.intentId);
  let recorded = false;
  let retryCount = 0;

  await db.runTransaction(async (transaction) => {
    recorded = false;
    const existing = await transaction.get(intentRef);
    if (existing.exists) {
      const current = existing.data() || {};
      retryCount = Math.min(boundedRetryCount(current.retryCount) + 1, MAX_RETRY_COUNT);
      transaction.set(intentRef, {
        retryCount,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    retryCount = 0;
    transaction.create(intentRef, record);
    recorded = true;
  });

  return { recorded, duplicate: !recorded, retryCount };
}

/** Injectable core used by the HTTP wrapper and unit tests. */
export async function handleRecordApplicationIntent({
  req,
  token = null,
  db: injectedDb,
} = {}) {
  if (String(req?.method || '').toUpperCase() !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }

  const normalized = normalizeApplicationIntentRequest(req?.body || {});
  if (!normalized.ok) {
    return { status: 400, body: { ok: false, error: normalized.error } };
  }

  const record = buildApplicationIntentRecord({ req, token, input: normalized.input });
  if (!record) {
    return { status: 400, body: { ok: false, error: 'invalid_application_intent' } };
  }

  const db = injectedDb || getAdminDb();
  const result = await persistApplicationIntent({ db, record });
  return {
    status: 200,
    body: {
      ok: true,
      intentId: record.intentId,
      recorded: result.recorded,
      duplicate: result.duplicate,
      application_status: APPLICATION_INTENT_STATUS,
    },
  };
}

/** Production HTTP entry point; auth is optional because job-board clicks can be anonymous. */
export async function recordApplicationIntent(req) {
  const token = await verifyOptionalApplicationIntentCaller(req);
  return handleRecordApplicationIntent({ req, token });
}
