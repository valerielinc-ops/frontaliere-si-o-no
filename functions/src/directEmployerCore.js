import { createHash, randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

export const DIRECT_EMPLOYER_FLAG = 'DIRECT_EMPLOYER_CHANNEL_ENABLED';
export const DIRECT_EMPLOYER_COLLECTION = 'direct_employer_submissions';
export const DIRECT_EMPLOYER_RATE_LIMIT_COLLECTION = 'direct_employer_rate_limits';
export const PERMANENT_EMPLOYER_COLLECTION = 'permanent_employer_signals';
export const DIRECT_EMPLOYER_SOURCE_KEY = 'direct-employers';
export const DIRECT_EMPLOYER_VALID_DAYS = 30;
export const DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS = 51;
export const DIRECT_EMPLOYER_PII_RETENTION_DAYS = 60;

const MAX_FIELD_LENGTHS = Object.freeze({
  companyName: 140,
  companyWebsite: 300,
  title: 160,
  description: 6000,
  location: 140,
  streetAddress: 180,
  postalCode: 16,
  canton: 8,
  contactEmail: 254,
  contactPhone: 32,
});

const GENERIC_COMPANY_NAMES = /^(?:azienda|impresa|privato|anonimo|anonima|azienda test|company|entreprise|unternehmen|firma|unknown|anonymous|n\/a|na|sconosciuto|inconnu|unbekannt|test|prova|none|null)$/iu;
const HIGH_RISK_COPY = /\b(?:multilevel|multi\s*level|mlm|network\s*marketing|marketing\s+(?:de\s+réseau|di\s+rete|de\s+red)|netzwerkmarketing|guadagno\s+facile|crypto\s*trading|investi\s+e\s+guadagna|pyram(?:id|ide|iden)|recluta\s+persone|recruit\s+people|recrutez?\s+des\s+personnes|personen\s+rekrutieren)\b/iu;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;
const PHONE_RE = /^\+?[0-9][0-9\s().-]{6,30}$/u;
const CANTON_RE = /^(?:AG|AI|AR|BE|BL|BS|FR|GE|GL|GR|JU|LU|NE|NW|OW|SG|SH|SO|SZ|TG|TI|UR|VD|VS|ZG|ZH)$/u;

function clean(value, maxLength) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}
function countWords(value) {
  const normalized = clean(value);
  return normalized ? normalized.split(/\s+/u).filter(Boolean).length : 0;
}

function normalizeEmail(value) {
  const normalized = clean(value, MAX_FIELD_LENGTHS.contactEmail).toLowerCase();
  return EMAIL_RE.test(normalized) ? normalized : '';
}

function normalizePhone(value) {
  const normalized = clean(value, MAX_FIELD_LENGTHS.contactPhone).replace(/\s+/gu, ' ');
  return PHONE_RE.test(normalized) ? normalized : '';
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

function normalizeCanton(value) {
  const normalized = clean(value, MAX_FIELD_LENGTHS.canton).toUpperCase();
  return CANTON_RE.test(normalized) ? normalized : 'TI';
}

function normalizeLocale(value) {
  const normalized = clean(value, 2).toLowerCase();
  return ['it', 'en', 'de', 'fr'].includes(normalized) ? normalized : 'it';
}

function normalizeOrigin(value) {
  const normalized = clean(value, 48).toLowerCase();
  return /^[a-z0-9_-]{1,48}$/u.test(normalized) ? normalized : 'vetrina';
}

function hashValue(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function token() {
  return randomBytes(32).toString('hex');
}

function asDate(value, fallback = null) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    return Number.isFinite(date.getTime()) ? date : fallback;
  }
  if (value && typeof value.toMillis === 'function') {
    const date = new Date(value.toMillis());
    return Number.isFinite(date.getTime()) ? date : fallback;
  }
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date : fallback;
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

export function buildReviewRiskFlags(input = {}) {
  const text = `${input.companyName || ''} ${input.title || ''} ${input.description || ''}`.trim();
  const flags = [];
  if (GENERIC_COMPANY_NAMES.test(clean(input.companyName))) flags.push('unidentifiable_company');
  if (HIGH_RISK_COPY.test(text)) flags.push('high_risk_recruitment_copy');
  if (clean(input.companyWebsite) && !normalizeWebsite(input.companyWebsite)) flags.push('invalid_company_website');
  return flags;
}

export function normalizeDirectEmployerSubmission(data = {}) {
  const source = data && typeof data === 'object' ? data : {};
  const contactEmail = normalizeEmail(source.contactEmail);
  const contactPhone = normalizePhone(source.contactPhone);
  const companyName = clean(source.companyName, MAX_FIELD_LENGTHS.companyName);
  const title = clean(source.title, MAX_FIELD_LENGTHS.title);
  const description = clean(source.description, MAX_FIELD_LENGTHS.description);
  const locationLabel = clean(source.locationLabel || source.location, MAX_FIELD_LENGTHS.location);
  const streetAddress = clean(source.streetAddress, MAX_FIELD_LENGTHS.streetAddress);
  const postalCode = clean(source.postalCode, MAX_FIELD_LENGTHS.postalCode);
  const canton = normalizeCanton(source.canton);
  const employmentType = clean(source.employmentType, 40).toUpperCase();
  const salaryMin = Number.isFinite(Number(source.salaryMin)) && Number(source.salaryMin) > 0 ? Number(source.salaryMin) : null;
  const salaryMax = Number.isFinite(Number(source.salaryMax)) && Number(source.salaryMax) > 0 ? Number(source.salaryMax) : null;
  const website = normalizeWebsite(source.companyWebsite || source.website);
  const honeypot = clean(source.websiteConfirm || source.honeypot, 200);
  const contactType = contactEmail ? 'email' : contactPhone ? 'phone' : '';
  const locale = normalizeLocale(source.locale);
  const origin = normalizeOrigin(source.origin);

  const errors = [];
  if (!companyName || companyName.length < 2 || GENERIC_COMPANY_NAMES.test(companyName)) errors.push('company_required');
  if (!title || title.length < 3) errors.push('title_required');
  if (!locationLabel) errors.push('location_required');
  if (!employmentType) errors.push('contract_required');
  if (countWords(description) < DIRECT_EMPLOYER_MIN_DESCRIPTION_WORDS) errors.push('description_too_short');
  if (!contactType) errors.push('contact_required');
  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) errors.push('salary_range_invalid');
  if (source.companyWebsite && !website) errors.push('website_invalid');

  const riskFlags = buildReviewRiskFlags({ companyName, title, description, companyWebsite: website || source.companyWebsite });
  if (honeypot) errors.push('honeypot');
  if (riskFlags.includes('unidentifiable_company')) errors.push('company_not_identifiable');
  if (riskFlags.includes('high_risk_recruitment_copy')) errors.push('prohibited_recruitment_copy');

  return {
    ok: errors.length === 0,
    errors,
    riskFlags,
    input: {
      companyName,
      companyWebsite: website,
      title,
      description,
      descriptionWordCount: countWords(description),
      locationLabel,
      streetAddress,
      postalCode,
      canton,
      employmentType,
      salaryMin,
      salaryMax,
      currency: 'CHF',
      contactType,
      contactEmail,
      contactPhone,
      locale,
      origin,
    },
  };
}

export function buildDirectEmployerJob(submission, now = new Date()) {
  const approvedAt = asDate(submission.approvedAt, now) || now;
  const expiresAt = asDate(submission.expiresAt, new Date(approvedAt.getTime() + DIRECT_EMPLOYER_VALID_DAYS * 86400000));
  const companyName = clean(submission.companyName, MAX_FIELD_LENGTHS.companyName);
  const companyKey = hashValue(`${companyName.toLowerCase()}\u0000${clean(submission.locationLabel).toLowerCase()}`).slice(0, 24);
  return {
    id: `direct-${submission.id}`,
    directEmployerSubmissionId: submission.id,
    title: clean(submission.title, MAX_FIELD_LENGTHS.title),
    description: clean(submission.description, MAX_FIELD_LENGTHS.description),
    company: companyName,
    companyKey,
    companyDomain: submission.companyWebsite ? new URL(submission.companyWebsite).hostname : null,
    companyWebsite: submission.companyWebsite || null,
    location: clean(submission.locationLabel, MAX_FIELD_LENGTHS.location),
    addressLocality: clean(submission.locationLabel, MAX_FIELD_LENGTHS.location),
    streetAddress: clean(submission.streetAddress, MAX_FIELD_LENGTHS.streetAddress) || null,
    postalCode: clean(submission.postalCode, MAX_FIELD_LENGTHS.postalCode) || null,
    addressRegion: normalizeCanton(submission.canton),
    addressCountry: 'CH',
    canton: normalizeCanton(submission.canton),
    country: 'CH',
    source: DIRECT_EMPLOYER_SOURCE_KEY,
    sourceLang: 'it',
    employmentType: clean(submission.employmentType, 40),
    contractType: clean(submission.employmentType, 40),
    salaryMin: submission.salaryMin ?? null,
    salaryMax: submission.salaryMax ?? null,
    currency: 'CHF',
    datePosted: approvedAt.toISOString(),
    postedDate: approvedAt.toISOString(),
    firstSeenAt: approvedAt.toISOString(),
    crawledAt: approvedAt.toISOString().slice(0, 10),
    validThrough: expiresAt.toISOString(),
    applyMode: 'external_url',
    applyUrl: `https://frontaliereticino.ch/candidati-offerta/?job=${encodeURIComponent(`direct-${submission.id}`)}`,
    tier: 'free',
    featured: false,
    submissionOrigin: normalizeOrigin(submission.origin),
  };
}

function verifyPhoneAuth(auth, phone) {
  const verifiedPhone = clean(auth?.token?.phone_number || auth?.phone_number, MAX_FIELD_LENGTHS.contactPhone);
  return Boolean(verifiedPhone && phone && verifiedPhone.replace(/\D/gu, '') === phone.replace(/\D/gu, ''));
}

function nowDate(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

export async function submitDirectEmployerListing({ data, auth = null, db = getAdminDb(), now = new Date(), sendVerificationEmail, verificationUrlBase = 'https://frontaliereticino.ch/verifica-offerta/', renewalUrlBase = 'https://frontaliereticino.ch/rinnova-offerta/' }) {
  const enabled = await readDirectEmployerChannelEnabled();
  if (!enabled) return { ok: false, error: 'channel_disabled' };
  const normalized = normalizeDirectEmployerSubmission(data);
  if (!normalized.ok) return { ok: false, error: 'invalid_submission', fields: normalized.errors };
  const input = normalized.input;
  if (input.contactType === 'phone' && !verifyPhoneAuth(auth, input.contactPhone)) return { ok: false, error: 'phone_verification_required' };

  const current = nowDate(now);
  const rateKey = hashValue(`${input.contactType}:${input.contactEmail || input.contactPhone}`);
  const rateRef = db.collection(DIRECT_EMPLOYER_RATE_LIMIT_COLLECTION).doc(rateKey);
  const submissionRef = db.collection(DIRECT_EMPLOYER_COLLECTION).doc();
  const windowMs = 24 * 60 * 60 * 1000;
  const verificationToken = input.contactType === 'email' ? token() : '';
  // Phone verification has no email delivery channel. Give the verified
  // employer a capability link immediately; moderation still controls whether
  // that link can renew anything. Only the hash is retained server-side.
  const phoneManageToken = input.contactType === 'phone' ? token() : '';
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rateRef);
    const previous = snapshot.exists ? snapshot.data() : {};
    const windowStart = asDate(previous.windowStartAt, current);
    const activeWindow = current.getTime() - windowStart.getTime() < windowMs;
    const count = activeWindow ? Number(previous.count || 0) : 0;
    if (count >= 3) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
    transaction.set(rateRef, { windowStartAt: activeWindow ? windowStart : current, count: count + 1, updatedAt: current });
    transaction.set(submissionRef, {
      ...input,
      status: input.contactType === 'email' ? 'awaiting_email_verification' : 'pending_moderation',
      riskFlags: normalized.riskFlags,
      verifiedAt: input.contactType === 'phone' ? current : null,
      createdAt: current,
      updatedAt: current,
      expiresAt: new Date(current.getTime() + DIRECT_EMPLOYER_VALID_DAYS * 86400000),
      piiRetentionUntil: new Date(current.getTime() + DIRECT_EMPLOYER_PII_RETENTION_DAYS * 86400000),
      emailVerificationTokenHash: verificationToken ? hashValue(verificationToken) : null,
      emailVerificationExpiresAt: verificationToken ? new Date(current.getTime() + 24 * 60 * 60 * 1000) : null,
      manageTokenHash: phoneManageToken ? hashValue(phoneManageToken) : null,
      moderation: { source: 'direct_employer', automaticDecision: normalized.riskFlags.length ? 'manual_review' : 'eligible_for_human_review' },
    });
  });

  if (input.contactType === 'email') {
    if (typeof sendVerificationEmail !== 'function') {
      await submissionRef.delete();
      return { ok: false, error: 'verification_delivery_unavailable' };
    }
    try {
      await sendVerificationEmail({
        to: input.contactEmail,
        verificationUrl: `${verificationUrlBase}?token=${encodeURIComponent(verificationToken)}`,
        locale: input.locale,
      });
    } catch {
      await submissionRef.delete();
      return { ok: false, error: 'verification_delivery_failed' };
    }
    return { ok: true, submissionId: submissionRef.id, status: 'awaiting_email_verification' };
  }
  return {
    ok: true,
    submissionId: submissionRef.id,
    status: 'pending_moderation',
    renewalUrl: `${renewalUrlBase}?token=${encodeURIComponent(phoneManageToken)}`,
  };
}

export async function verifyDirectEmployerEmail({ token: rawToken, db = getAdminDb(), now = new Date() }) {
  const value = clean(rawToken, 128);
  if (!value) return { ok: false, error: 'invalid_token' };
  const snapshot = await db.collection(DIRECT_EMPLOYER_COLLECTION).where('emailVerificationTokenHash', '==', hashValue(value)).limit(1).get();
  if (snapshot.empty) return { ok: false, error: 'invalid_token' };
  const doc = snapshot.docs[0];
  const data = doc.data();
  if (data.status !== 'awaiting_email_verification' || !asDate(data.emailVerificationExpiresAt, new Date(0)) || asDate(data.emailVerificationExpiresAt).getTime() < nowDate(now).getTime()) return { ok: false, error: 'expired_token' };
  await doc.ref.update({ status: 'pending_moderation', verifiedAt: nowDate(now), updatedAt: nowDate(now), emailVerificationTokenHash: FieldValue.delete(), emailVerificationExpiresAt: FieldValue.delete() });
  return { ok: true, status: 'pending_moderation' };
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

export async function listDirectEmployerSubmissions({ db = getAdminDb(), status = 'pending_moderation', limit = 50, cursor = '' }) {
  return listModerationPage({ db, collectionName: DIRECT_EMPLOYER_COLLECTION, status, limit, cursor });
}

export async function moderateDirectEmployerSubmission({ id, action, db = getAdminDb(), now = new Date(), sendApprovalEmail, approvalUrlBase = 'https://frontaliereticino.ch/rinnova-offerta/' }) {
  const submissionId = clean(id, 160);
  if (!submissionId || !['approve', 'reject'].includes(action)) return { ok: false, error: 'invalid_moderation_action' };
  const ref = db.collection(DIRECT_EMPLOYER_COLLECTION).doc(submissionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { ok: false, error: 'not_found' };
  const data = snapshot.data();
  if (data.status !== 'pending_moderation') return { ok: false, error: 'not_moderatable' };
  const riskFlags = Array.isArray(data.riskFlags) ? data.riskFlags : [];
  if (action === 'approve' && !asDate(data.verifiedAt)) return { ok: false, error: 'contact_not_verified' };
  if (action === 'approve' && riskFlags.some((flag) => ['unidentifiable_company', 'high_risk_recruitment_copy'].includes(flag))) return { ok: false, error: 'manual_review_required' };
  const current = nowDate(now);
  if (action === 'reject') {
    await ref.update({ status: 'rejected', rejectedAt: current, updatedAt: current });
    return { ok: true, status: 'rejected' };
  }
  // A phone submission already received a one-time capability link because
  // there is no email channel. Email submissions get a fresh link only after
  // the human approval decision. Never expose or store the raw token.
  const manageToken = data.contactType === 'phone' && data.manageTokenHash ? '' : token();
  await ref.update({
    status: 'approved',
    approvedAt: current,
    expiresAt: new Date(current.getTime() + DIRECT_EMPLOYER_VALID_DAYS * 86400000),
    publicEligible: true,
    ...(manageToken ? { manageTokenHash: hashValue(manageToken) } : {}),
    updatedAt: current,
  });
  if (sendApprovalEmail && data.contactEmail) {
    await sendApprovalEmail({ to: data.contactEmail, renewalUrl: `${approvalUrlBase}?token=${encodeURIComponent(manageToken)}`, locale: data.locale });
  }
  return { ok: true, status: 'approved' };
}

export async function renewDirectEmployerListing({ token: rawToken, auth = null, submissionId = '', db = getAdminDb(), now = new Date() }) {
  const current = nowDate(now);
  let ref = null;
  if (rawToken) {
    const snapshot = await db.collection(DIRECT_EMPLOYER_COLLECTION).where('manageTokenHash', '==', hashValue(clean(rawToken, 128))).limit(1).get();
    if (!snapshot.empty) ref = snapshot.docs[0].ref;
  } else if (submissionId && auth?.token?.phone_number) {
    ref = db.collection(DIRECT_EMPLOYER_COLLECTION).doc(clean(submissionId, 160));
  }
  if (!ref) return { ok: false, error: 'invalid_renewal' };
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data || data.status !== 'approved') return { ok: false, error: 'not_renewable' };
  if (!data.contactEmail && !data.contactPhone) return { ok: false, error: 'contact_retention_expired' };
  if (!rawToken && !verifyPhoneAuth(auth, data.contactPhone)) return { ok: false, error: 'phone_verification_required' };
  const nextExpiry = new Date(current.getTime() + DIRECT_EMPLOYER_VALID_DAYS * 86400000);
  await ref.update({ expiresAt: nextExpiry, updatedAt: current, renewalCount: Number(data.renewalCount || 0) + 1 });
  return { ok: true, expiresAt: nextExpiry.toISOString() };
}

export async function listPermanentEmployers({ db = getAdminDb(), limit = 50 }) {
  const snapshot = await db.collection(PERMANENT_EMPLOYER_COLLECTION).where('status', '==', 'approved').limit(Math.min(Math.max(Number(limit) || 50, 1), 100)).get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return { id: doc.id, companyName: clean(data.companyName, MAX_FIELD_LENGTHS.companyName), website: normalizeWebsite(data.website), locationLabel: clean(data.locationLabel, MAX_FIELD_LENGTHS.location) };
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
  await db.collection(PERMANENT_EMPLOYER_COLLECTION).doc(id).set({ companyName, website, locationLabel, status: 'pending_moderation', updatedAt: nowDate(now), candidateMarks: FieldValue.increment(1) }, { merge: true });
  return { ok: true, status: 'pending_moderation' };
}

export async function getDirectEmployerContact({ jobId, db = getAdminDb() }) {
  const normalizedId = clean(jobId, 160).replace(/^direct-/u, '');
  if (!normalizedId) return { ok: false, error: 'not_found' };
  const snapshot = await db.collection(DIRECT_EMPLOYER_COLLECTION).doc(normalizedId).get();
  if (!snapshot.exists) return { ok: false, error: 'not_found' };
  const data = snapshot.data();
  const expiresAt = asDate(data.expiresAt, new Date(0));
  if (data.status !== 'approved' || expiresAt.getTime() <= Date.now()) return { ok: false, error: 'listing_expired' };
  if (!data.contactEmail && !data.contactPhone) return { ok: false, error: 'contact_unavailable' };
  return { ok: true, email: data.contactEmail || null, phone: data.contactPhone || null };
}

export async function purgeDirectEmployerPii({ db = getAdminDb(), now = new Date(), batchSize = 100 }) {
  const snapshot = await db.collection(DIRECT_EMPLOYER_COLLECTION).where('piiRetentionUntil', '<=', nowDate(now)).limit(Math.min(Math.max(Number(batchSize) || 100, 1), 500)).get();
  if (snapshot.empty) return 0;
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.update(doc.ref, {
    ...(doc.data().status === 'approved' ? { status: 'expired', publicEligible: false, expiresAt: nowDate(now) } : {}),
    contactEmail: FieldValue.delete(),
    contactPhone: FieldValue.delete(),
    emailVerificationTokenHash: FieldValue.delete(),
    emailVerificationExpiresAt: FieldValue.delete(),
    piiPurgedAt: nowDate(now),
  }));
  await batch.commit();
  return snapshot.size;
}
