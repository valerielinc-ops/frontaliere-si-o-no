import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { generationSlotMinute } from './generationSlotSchedule.js';

export const GENERATION_SLOT_COLLECTION = 'generationSlotClaims';
export const GENERATION_SLOT_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const GENERATION_SLOT_RETRY_DELAY_MS = 2 * 60 * 1000;

function dateMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

function slotDate(section, year, month, day, hour, minute) {
  if (generationSlotMinute(section) !== minute) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute) return null;
  return date;
}

export function parseGenerationSlotKey(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^generate-article\/(frontaliere|svizzera)\/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/u);
  if (!match) return null;
  const [, section, yearText, monthText, dayText, hourText, minuteText] = match;
  const date = slotDate(section, Number(yearText), Number(monthText), Number(dayText), Number(hourText), Number(minuteText));
  if (!date) return null;
  return { key: value, section, slot: date };
}

export function generationSlotKey(section, value) {
  if (generationSlotMinute(section) === null) throw new TypeError('generation slot section is invalid');
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0
    || date.getUTCMinutes() !== generationSlotMinute(section)) {
    throw new TypeError('generation slot must be a nominal UTC schedule minute');
  }
  return `generate-article/${section}/${date.toISOString().slice(0, 16)}Z`;
}

export function generationSlotDocumentId(slotKey) {
  if (!parseGenerationSlotKey(slotKey)) throw new TypeError('generation slot key is invalid');
  return createHash('sha256').update(slotKey).digest('hex');
}

function slotReference(db, slotKey) {
  return db.collection(GENERATION_SLOT_COLLECTION).doc(generationSlotDocumentId(slotKey));
}

export async function getGenerationSlotClaim(db, slotKey) {
  const snapshot = await slotReference(db, slotKey).get();
  return snapshot.exists ? snapshot.data() : null;
}

/** Atomically create or renew the short dispatch lease for one nominal slot. */
export async function claimGenerationSlot(db, slotKey, {
  now = Date.now(),
  leaseMs = GENERATION_SLOT_CLAIM_LEASE_MS,
  retryDelayMs = GENERATION_SLOT_RETRY_DELAY_MS,
  claimTokenFactory = randomUUID,
} = {}) {
  const parsed = parseGenerationSlotKey(slotKey);
  if (!parsed) throw new TypeError('generation slot key is invalid');
  const nowMs = dateMs(now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new TypeError('generation slot claim timing is invalid');
  }
  const ref = slotReference(db, slotKey);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const previous = snapshot.exists ? snapshot.data() : null;
    const leaseUntilMs = dateMs(previous?.leaseUntil);
    const retryAfterMs = dateMs(previous?.retryAfter);
    if (previous?.status === 'admitted') return { claimed: false, reason: 'slot_admitted' };
    if (previous?.status === 'claimed' && leaseUntilMs > nowMs) {
      return { claimed: false, reason: 'claim_lease_active' };
    }
    if (previous?.status === 'pending' && retryAfterMs > nowMs) {
      return { claimed: false, reason: 'claim_retry_delayed' };
    }

    const claimToken = claimTokenFactory();
    const attempt = Number.isSafeInteger(previous?.attempt) && previous.attempt > 0
      ? previous.attempt + 1
      : 1;
    const nowDate = new Date(nowMs);
    transaction.set(ref, {
      slotKey,
      section: parsed.section,
      status: 'claimed',
      claimToken,
      attempt,
      leaseUntil: new Date(nowMs + leaseMs),
      retryAfter: null,
      admittedRunId: null,
      createdAt: previous?.createdAt || nowDate,
      updatedAt: nowDate,
    }, { merge: true });
    return { claimed: true, claimToken, attempt };
  });
}

export async function renewGenerationSlotClaim(db, slotKey, claimToken, {
  now = Date.now(),
  leaseMs = GENERATION_SLOT_CLAIM_LEASE_MS,
} = {}) {
  const nowMs = dateMs(now);
  const ref = slotReference(db, slotKey);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    if (current?.status !== 'claimed' || current.claimToken !== claimToken) return false;
    transaction.update(ref, {
      leaseUntil: new Date(nowMs + leaseMs),
      updatedAt: new Date(nowMs),
    });
    return true;
  });
}

export async function releaseGenerationSlotClaim(db, slotKey, claimToken, {
  now = Date.now(),
  retryDelayMs = GENERATION_SLOT_RETRY_DELAY_MS,
} = {}) {
  const nowMs = dateMs(now);
  const ref = slotReference(db, slotKey);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    if (current?.status !== 'claimed' || current.claimToken !== claimToken) return false;
    transaction.update(ref, {
      status: 'pending',
      claimToken: null,
      leaseUntil: null,
      retryAfter: new Date(nowMs + retryDelayMs),
      updatedAt: new Date(nowMs),
    });
    return true;
  });
}

export async function admitGenerationSlotClaim(db, slotKey, claimToken, runId, { now = Date.now() } = {}) {
  const parsed = parseGenerationSlotKey(slotKey);
  const normalizedRunId = String(runId ?? '').trim();
  if (!parsed || !/^\d{1,24}$/u.test(normalizedRunId)) return { admitted: false, reason: 'request_invalid' };
  const nowMs = dateMs(now);
  const ref = slotReference(db, slotKey);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    if (current?.status === 'admitted'
      && tokensEqual(current.claimToken, claimToken)
      && current.admittedRunId === normalizedRunId) {
      return { admitted: true, reason: 'already_admitted' };
    }
    if (current?.status !== 'claimed' || !tokensEqual(current.claimToken, claimToken)
      || dateMs(current.leaseUntil) <= nowMs) {
      return { admitted: false, reason: 'claim_not_current' };
    }
    transaction.update(ref, {
      status: 'admitted',
      admittedRunId: normalizedRunId,
      admittedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    return { admitted: true, reason: 'admitted' };
  });
}

function tokensEqual(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function handleGenerationSlotClaimRequest(req, db, { now = Date.now(), claims } = {}) {
  if (req?.method !== 'POST') return { status: 405, body: { ok: false, reason: 'method_not_allowed' } };
  if (!claims || !/^\d{1,24}$/u.test(String(claims.run_id ?? ''))) {
    return { status: 401, body: { ok: false, reason: 'unauthorized' } };
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || !['admit', 'release'].includes(body.action)) {
    return { status: 400, body: { ok: false, reason: 'request_invalid' } };
  }
  const slotKey = body.slotKey;
  const runId = String(body.runId ?? '').trim();
  const claimToken = body.claimToken;
  if (!parseGenerationSlotKey(slotKey)
    || !/^\d{1,24}$/u.test(runId)
    || runId !== String(claims.run_id)
    || typeof claimToken !== 'string'
    || !/^[0-9a-f-]{36}$/iu.test(claimToken)) {
    return { status: 400, body: { ok: false, reason: 'request_invalid' } };
  }
  if (body.action === 'release') {
    const released = await releaseGenerationSlotClaim(db, slotKey, claimToken, { now });
    if (!released) return { status: 409, body: { ok: false, reason: 'claim_not_current' } };
    return { status: 200, body: { ok: true, released: true } };
  }
  const result = await admitGenerationSlotClaim(db, slotKey, claimToken, runId, { now });
  if (!result.admitted) return { status: 409, body: { ok: false, reason: result.reason } };
  return { status: 200, body: { ok: true, admitted: true } };
}
