import { createHash } from 'node:crypto';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

export const DIRECT_EMPLOYER_FLAG = 'DIRECT_EMPLOYER_CHANNEL_ENABLED';
export const PERMANENT_EMPLOYER_COLLECTION = 'permanent_employer_signals';
export const PERMANENT_EMPLOYER_MAX_CANDIDATE_MARKS = 100;

const MAX_FIELD_LENGTHS = Object.freeze({
  companyName: 140,
  companyWebsite: 300,
  location: 140,
});

function clean(value, maxLength) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeWebsite(value) {
  const normalized = clean(value, MAX_FIELD_LENGTHS.companyWebsite);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || !url.hostname) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function hashValue(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function nowDate(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

export function isDirectEmployerChannelEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

export async function readDirectEmployerChannelEnabled(read = getRemoteConfigValue) {
  try {
    return isDirectEmployerChannelEnabled(await read(DIRECT_EMPLOYER_FLAG));
  } catch {
    return false;
  }
}

async function listModerationPage({ db, collectionName, status, limit, cursor }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const collection = db.collection(collectionName);
  let query = collection.where('status', '==', clean(status, 40) || 'pending_moderation').orderBy('__name__').limit(safeLimit + 1);
  const cursorId = clean(cursor, 160);
  if (cursorId) {
    const cursorSnapshot = await collection.doc(cursorId).get();
    if (cursorSnapshot.exists) query = query.startAfter(cursorSnapshot);
  }
  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, safeLimit);
  return {
    items: pageDocs.map((doc) => ({ id: doc.id, ...doc.data() })),
    nextPageToken: snapshot.docs.length > safeLimit ? pageDocs[pageDocs.length - 1]?.id || null : null,
  };
}

export async function listPermanentEmployers({ db = getAdminDb(), limit = 50 } = {}) {
  const snapshot = await db.collection(PERMANENT_EMPLOYER_COLLECTION)
    .where('status', '==', 'approved')
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      companyName: clean(data.companyName, MAX_FIELD_LENGTHS.companyName),
      website: normalizeWebsite(data.website),
      locationLabel: clean(data.locationLabel, MAX_FIELD_LENGTHS.location),
    };
  }).filter((item) => item.companyName && item.website);
}

export async function listPermanentEmployerSignals({ db = getAdminDb(), status = 'pending_moderation', limit = 50, cursor = '' }) {
  return listModerationPage({ db, collectionName: PERMANENT_EMPLOYER_COLLECTION, status, limit, cursor });
}

export async function moderatePermanentEmployerSignal({ id, action, db = getAdminDb(), now = new Date() }) {
  const signalId = clean(id, 160);
  if (!signalId || !['approve', 'reject'].includes(action)) return { ok: false, error: 'invalid_moderation_action' };
  const ref = db.collection(PERMANENT_EMPLOYER_COLLECTION).doc(signalId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { ok: false, error: 'not_found' };
  const data = snapshot.data();
  if (data.status !== 'pending_moderation') return { ok: false, error: 'not_moderatable' };
  if (action === 'approve' && (!clean(data.companyName, MAX_FIELD_LENGTHS.companyName) || !normalizeWebsite(data.website))) {
    return { ok: false, error: 'invalid_company_profile' };
  }
  const current = nowDate(now);
  await ref.update({
    status: action === 'approve' ? 'approved' : 'rejected',
    moderatedAt: current,
    updatedAt: current,
  });
  return { ok: true, status: action === 'approve' ? 'approved' : 'rejected' };
}

export async function markPermanentEmployer({ data, db = getAdminDb(), now = new Date() }) {
  const companyName = clean(data?.companyName, MAX_FIELD_LENGTHS.companyName);
  const website = normalizeWebsite(data?.website);
  const locationLabel = clean(data?.locationLabel, MAX_FIELD_LENGTHS.location);
  if (!companyName || !website) return { ok: false, error: 'company_and_website_required' };
  const id = hashValue(`${companyName.toLowerCase()}\u0000${website}`).slice(0, 40);
  const ref = db.collection(PERMANENT_EMPLOYER_COLLECTION).doc(id);
  const current = nowDate(now);
  let resultingStatus = 'pending_moderation';
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const existing = snapshot.exists ? snapshot.data() : {};
    const candidateMarks = Math.min(
      PERMANENT_EMPLOYER_MAX_CANDIDATE_MARKS,
      Math.max(0, Number(existing.candidateMarks) || 0) + 1,
    );
    resultingStatus = existing.status === 'approved' ? 'approved' : 'pending_moderation';
    transaction.set(ref, {
      companyName,
      website,
      locationLabel,
      status: existing.status === 'approved' ? 'approved' : 'pending_moderation',
      updatedAt: current,
      candidateMarks,
    }, { merge: true });
  });
  return { ok: true, status: resultingStatus };
}
