import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { getFirestoreDb } from './firestore-admin.mjs';

export const SOCIAL_PUBLISH_RESERVATION_COLLECTION = 'social_publish_reservations';
export const SOCIAL_PUBLISH_RESERVATION_DOCUMENT_MISSING = 'SOCIAL_PUBLISH_RESERVATION_DOCUMENT_MISSING';
export const SOCIAL_PUBLISH_RESERVATION_SCHEMA_VERSION = 1;
export const SOCIAL_PUBLISH_TIME_ZONE = 'Europe/Zurich';
export const SOCIAL_PUBLISH_RESERVATION_RETENTION_DAYS = 3;
export const SOCIAL_PUBLISH_LOOKAHEAD_DAYS = 7;
export const SOCIAL_PUBLISH_RESERVATION_STALE_AFTER_MS = 30 * 60 * 1000;
export const SOCIAL_PUBLISH_MAX_UNRESOLVED_RESERVATIONS = 2_000;
export const SOCIAL_LINKEDIN_MEMBER_DEDUP_WINDOW_DAYS = 30;
const SOCIAL_PUBLISH_ROLLOVER_GUARD_MS = 60 * 60 * 1000;
const SOCIAL_PUBLISH_RECONCILIATION_EARLY_DRIFT_MS = 10 * 60 * 1000;
const SOCIAL_PUBLISH_RECONCILIATION_LATE_DRIFT_MS = 24 * 60 * 60 * 1000;
const SOCIAL_LINKEDIN_MEMBER_IDENTITY_TTL_MS = SOCIAL_LINKEDIN_MEMBER_DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const SOCIAL_PUBLISH_DAILY_CAPS = Object.freeze({
  facebook: 144,
  instagram: 2,
  instagramStory: 6,
  linkedinMember: 2,
  telegram: 2,
});

const LEDGER_FILES = Object.freeze({
  facebook: Object.freeze([
    ['data/fb-posted-jobs.json', 'job'],
    ['data/fb-posted-articles.json', 'article'],
    ['data/fb-posted-events.json', 'event'],
  ]),
  instagram: Object.freeze([['data/instagram-posted.json', 'post']]),
  linkedinMember: Object.freeze([['data/linkedin-member-posted.json', 'member-post']]),
  telegram: Object.freeze([
    ['data/telegram-posted-jobs.json', 'jobs-digest'],
    ['data/telegram-posted-announcements.json', 'announcement'],
  ]),
});
const ACTIVE_STATUSES = new Set(['reserved', 'published']);

export function isMissingSocialPublishReservationDocumentError(error) {
  return error?.code === SOCIAL_PUBLISH_RESERVATION_DOCUMENT_MISSING;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date.toISOString();
}

function dayKey(value, timeZone = SOCIAL_PUBLISH_TIME_ZONE) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const key = `${get('year')}-${get('month')}-${get('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(key)) throw new Error('publishAt cannot be assigned to a local day');
  return key;
}

export function socialPublishLocalDay(value) {
  return dayKey(value);
}

function dayOffset(key, offset) {
  const noonUtc = new Date(`${key}T12:00:00.000Z`);
  noonUtc.setUTCDate(noonUtc.getUTCDate() + offset);
  return noonUtc.toISOString().slice(0, 10);
}

function reservationDocId(platform, accountId, capGroup) {
  return `${platform}_${digest(accountId)}_${digest(capGroup).slice(0, 16)}`;
}

function publishedIdentityDocId(platform, accountId, keyHash) {
  return `published_${digest(`${platform}\u0000${accountId}`)}_${keyHash}`;
}

function defaultDailyCap(platform, capGroup) {
  if (platform === 'instagram' && capGroup === 'story') return SOCIAL_PUBLISH_DAILY_CAPS.instagramStory;
  return SOCIAL_PUBLISH_DAILY_CAPS[platform];
}

function reservationKeyHash(platform, key) {
  return digest(`${platform}\u0000${key}`);
}

function normalizeFingerprintValue(value) {
  if (typeof value === 'string') return value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
  if (Array.isArray(value)) return value.map(normalizeFingerprintValue);
  if (record(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeFingerprintValue(child)]));
  }
  return value ?? null;
}

/** Hash only exact public-facing payload fields; never persist the payload itself. */
export function socialPublishContentFingerprint(platform, content = {}) {
  if (!record(content)) throw new Error('social publish content fingerprint input must be an object');
  let selected;
  if (platform === 'facebook') {
    selected = { message: content.message ?? '', link: content.link ?? '' };
  } else if (platform === 'instagram') {
    selected = { caption: content.caption ?? '' };
  } else if (platform === 'linkedinMember') {
    selected = { commentary: content.commentary ?? '', content: content.content ?? null };
  } else {
    throw new Error('content fingerprints are unsupported for this social platform');
  }
  const normalized = normalizeFingerprintValue(selected);
  const hasContent = Object.values(normalized).some((value) => (
    typeof value === 'string' ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0
        : Boolean(value)
  ));
  if (!hasContent) throw new Error('social publish content fingerprint requires at least one public content field');
  return digest(JSON.stringify(normalized));
}

export function socialPublishReservationKey(platform, contentType, contentId) {
  if (!Object.hasOwn(LEDGER_FILES, platform)) throw new Error('unsupported social publishing platform');
  const type = String(contentType || '').trim();
  const id = String(contentId || '').trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(type)) throw new Error('invalid social publication content type');
  if (!id || id.length > 256 || /[\r\n\u0000]/u.test(id)) throw new Error('invalid social publication content id');
  return `${platform}:${type}:${id}`;
}

function ledgerRows(raw, relativePath) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error(`Malformed social publish ledger: ${relativePath}`);
  }
  if (!record(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.posted)
    || parsed.posted.some((row) => !record(row))) {
    throw new Error(`Invalid social publish ledger shape: ${relativePath}`);
  }
  return parsed.posted;
}

/**
 * Read the existing per-channel ledgers so first use and prior API successes
 * seed the shared reservation state. Digest rows that only cover source
 * events are intentionally not counted as separate Page posts.
 */
export function collectSocialPublishLedgerReservations({ platform, repoRoot, publishDays, ledgerData, capGroup = 'feed' } = {}) {
  const files = LEDGER_FILES[platform];
  if (!files) throw new Error('unsupported social publishing platform');
  if (capGroup === 'story' && platform === 'instagram') return [];
  if (capGroup !== 'feed') throw new Error('unsupported social publication cap group');
  const root = path.resolve(repoRoot || process.cwd());
  const selectedDays = new Set(publishDays || []);
  const reservations = new Map();

  for (const [relativePath, contentType] of files) {
    const file = path.join(root, relativePath);
    const suppliedLedger = ledgerData && Object.hasOwn(ledgerData, relativePath);
    if (!suppliedLedger && !existsSync(file)) throw new Error(`Required social publish ledger is missing: ${relativePath}`);
    const raw = suppliedLedger ? ledgerData[relativePath] : readFileSync(file, 'utf8');
    const rows = ledgerRows(raw, relativePath);
    for (const [index, row] of rows.entries()) {
      if (platform === 'facebook' && row.viaDigest) continue;
      if (platform === 'facebook' && row.scheduledFor && !Number.isFinite(Date.parse(String(row.actualPublishedAt || '')))) continue;
      const postedAt = platform === 'facebook'
        ? row.actualPublishedAt || row.postedAt || row.ts || row.publishedAt
        : row.ts || row.publishedAt || row.confirmedAt;
      const timestamp = Date.parse(String(postedAt || ''));
      if (!Number.isFinite(timestamp)) throw new Error(`Undated social publish ledger row: ${relativePath}#${index}`);
      const at = new Date(timestamp).toISOString();
      const day = dayKey(at);
      if (selectedDays.size && !selectedDays.has(day)) continue;

      let type = contentType;
      let contentId;
      if (platform === 'instagram') {
        contentId = row.queueId || (row.kind && row.day ? `${row.kind}-${row.day}` : row.id);
        type = 'post';
      } else if (platform === 'linkedinMember') {
        contentId = row.socialReservationId || `${row.kind || 'post'}:${row.id || ''}`;
        type = row.socialReservationType || 'member-post';
      } else if (platform === 'telegram') {
        if (typeof row.socialReservationType === 'string' && typeof row.socialReservationId === 'string') {
          type = row.socialReservationType;
          contentId = row.socialReservationId;
        } else {
          const sourceId = typeof row.telegramDeliveryId === 'string' && row.telegramDeliveryId.trim()
            ? `delivery:${row.telegramDeliveryId.trim()}`
            : Number.isSafeInteger(row.telegramMessageId) && row.telegramMessageId > 0
              ? `message:${row.telegramMessageId}`
              : relativePath.endsWith('telegram-posted-jobs.json')
                ? `legacy:${at}`
                : `legacy:${row.id || index}`;
          type = relativePath.endsWith('telegram-posted-jobs.json') ? 'jobs-digest' : 'announcement';
          contentId = sourceId;
        }
      } else {
        contentId = row.id;
      }
      if ((typeof contentId !== 'string' && typeof contentId !== 'number') || !String(contentId).trim()) {
        throw new Error(`Social publish ledger row has no stable content id: ${relativePath}#${index}`);
      }
      const key = socialPublishReservationKey(platform, type, String(contentId));
      reservations.set(key, { key, publishAt: at });
    }
  }
  return [...reservations.values()];
}

function validateStoredDocument(value, platform, accountHash, capGroup) {
  if (!record(value)) return { schemaVersion: SOCIAL_PUBLISH_RESERVATION_SCHEMA_VERSION, platform, accountHash, capGroup, days: {}, pending: {} };
  if (value.schemaVersion !== SOCIAL_PUBLISH_RESERVATION_SCHEMA_VERSION
    || value.platform !== platform
    || value.accountHash !== accountHash
    || value.capGroup !== capGroup
    || !record(value.days)
    || (value.pending !== undefined && !record(value.pending))) {
    throw new Error('Invalid shared social publish reservation document');
  }
  for (const [day, bucket] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !record(bucket)
      || !Number.isSafeInteger(bucket.cap) || bucket.cap < 1 || bucket.cap > 10_000
      || !record(bucket.reservations)) {
      throw new Error('Invalid shared social publish reservation day bucket');
    }
    for (const reservation of Object.values(bucket.reservations)) {
      if (!record(reservation) || !ACTIVE_STATUSES.has(reservation.status)
        || typeof reservation.keyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(reservation.keyHash)
        || typeof reservation.publishAt !== 'string' || !Number.isFinite(Date.parse(reservation.publishAt))
        || (reservation.nativeContentFingerprint !== undefined
          && (typeof reservation.nativeContentFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(reservation.nativeContentFingerprint)))
        || (reservation.pendingGroup !== undefined
          && (typeof reservation.pendingGroup !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(reservation.pendingGroup)))) {
        throw new Error('Invalid shared social publish reservation entry');
      }
    }
  }
  const pending = value.pending || {};
  if (Object.keys(pending).length > SOCIAL_PUBLISH_MAX_UNRESOLVED_RESERVATIONS) {
    throw new Error('Too many unresolved shared social publish reservations');
  }
  for (const [keyHash, reservation] of Object.entries(pending)) {
    if (!/^[a-f0-9]{64}$/u.test(keyHash) || !record(reservation)
      || reservation.keyHash !== keyHash || reservation.status !== 'reserved'
      || !/^\d{4}-\d{2}-\d{2}$/u.test(reservation.day)
      || typeof reservation.publishAt !== 'string' || !Number.isFinite(Date.parse(reservation.publishAt))
      || (reservation.nativeContentFingerprint !== undefined
        && (typeof reservation.nativeContentFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(reservation.nativeContentFingerprint)))
      || (reservation.pendingGroup !== undefined
        && (typeof reservation.pendingGroup !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(reservation.pendingGroup)))) {
      throw new Error('Invalid unresolved shared social publish reservation');
    }
  }
  return { ...value, pending };
}

function validatePublishedIdentity(value, platform, accountHash, keyHash) {
  if (!record(value) || value.schemaVersion !== SOCIAL_PUBLISH_RESERVATION_SCHEMA_VERSION
    || value.kind !== 'published-identity'
    || value.platform !== platform
    || value.accountHash !== accountHash
    || value.keyHash !== keyHash
    || typeof value.publishedAt !== 'string'
    || !Number.isFinite(Date.parse(value.publishedAt))) {
    throw new Error('Invalid shared social published identity marker');
  }
  return value;
}

function normalizeReservationScope({ platform, capGroup = 'feed', accountId } = {}) {
  if (!LEDGER_FILES[platform]) throw new Error('unsupported social publishing platform');
  if (capGroup !== 'feed' && !(platform === 'instagram' && capGroup === 'story')) {
    throw new Error('unsupported social publication cap group');
  }
  const account = String(accountId || '').trim();
  if (!account || account.length > 256 || /[\r\n\u0000]/u.test(account)) {
    throw new Error('valid social account id is required');
  }
  return { platform, capGroup, account, accountHash: digest(account) };
}

/**
 * List only reservations past their planned publication time by the configured
 * grace period. The account is an exact lookup scope and is never returned;
 * each result contains only the already-hashed reservation identity.
 */
export async function listStaleSocialPublishReservations({
  db: suppliedDb,
  platform,
  capGroup = 'feed',
  accountId,
  now = new Date(),
  minimumAgeMs = SOCIAL_PUBLISH_RESERVATION_STALE_AFTER_MS,
} = {}) {
  const scope = normalizeReservationScope({ platform, capGroup, accountId });
  const nowIso = iso(now, 'now');
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 60_000 || minimumAgeMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('minimum reservation age must be between one minute and seven days');
  }
  const db = suppliedDb || await getFirestoreDb();
  const ref = db.collection(SOCIAL_PUBLISH_RESERVATION_COLLECTION)
    .doc(reservationDocId(scope.platform, scope.account, scope.capGroup));
  const snapshot = await ref.get();
  if (!snapshot.exists) return [];
  const stored = validateStoredDocument(snapshot.data(), scope.platform, scope.accountHash, scope.capGroup);
  const nowMs = Date.parse(nowIso);
  const candidates = new Map();
  for (const reservation of Object.values(stored.pending)) {
    if (reservation.status === 'reserved') candidates.set(reservation.keyHash, reservation);
  }
  // Include valid legacy entries in day buckets that predate the pending map.
  for (const [day, bucket] of Object.entries(stored.days)) {
    for (const reservation of Object.values(bucket.reservations)) {
      if (reservation.status !== 'reserved') continue;
      if (!candidates.has(reservation.keyHash)) {
        candidates.set(reservation.keyHash, {
          ...reservation,
          day,
        });
      }
    }
  }
  return [...candidates.values()]
    .map((reservation) => ({
      platform: scope.platform,
      capGroup: scope.capGroup,
      keyHash: reservation.keyHash,
      reservedDay: reservation.day,
      publishAt: reservation.publishAt,
      ageMs: nowMs - Date.parse(reservation.publishAt),
      fingerprintAvailable: typeof reservation.nativeContentFingerprint === 'string',
      ...(reservation.pendingGroup ? { pendingGroup: reservation.pendingGroup } : {}),
    }))
    .filter((reservation) => reservation.ageMs >= minimumAgeMs)
    .sort((a, b) => a.publishAt.localeCompare(b.publishAt) || a.keyHash.localeCompare(b.keyHash));
}

/**
 * Atomically reserve a batch across publishers sharing an account/cap group.
 * Recent day buckets enforce
 * per-day volume; unresolved reservations stay in a bounded pending map across
 * day rollover. Stored records contain only hashed identities and timestamps,
 * never captions, URLs, or tokens.
 */
export async function reserveSocialPublishBatch({
  db: suppliedDb,
  platform,
  capGroup = 'feed',
  accountId,
  reservations: requested,
  repoRoot,
  ledgerData,
  cap = defaultDailyCap(platform, capGroup),
  now = new Date(),
} = {}) {
  if (!LEDGER_FILES[platform]) throw new Error('unsupported social publishing platform');
  if (capGroup !== 'feed' && !(platform === 'instagram' && capGroup === 'story')) {
    throw new Error('unsupported social publication cap group');
  }
  const account = String(accountId || '').trim();
  if (!account || account.length > 256 || /[\r\n\u0000]/u.test(account)) throw new Error('valid social account id is required');
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 10_000) throw new Error('social publish daily cap must be between 1 and 10000');
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > 500) {
    throw new Error('social publish reservation batch must contain 1..500 items');
  }

  const nowIso = iso(now, 'now');
  const today = dayKey(nowIso);
  const firstRetainedDay = dayOffset(today, -SOCIAL_PUBLISH_RESERVATION_RETENTION_DAYS);
  const lastAllowedDay = dayOffset(today, SOCIAL_PUBLISH_LOOKAHEAD_DAYS);
  const normalized = requested.map((item) => {
    if (!record(item)) throw new Error('social publish reservation item must be an object');
    const key = String(item.key || '').trim();
    if (!key || key.length > 320 || /[\r\n\u0000]/u.test(key)) throw new Error('invalid social publish reservation key');
    const publishAt = iso(item.publishAt ?? nowIso, 'publishAt');
    const day = dayKey(publishAt);
    if (day < firstRetainedDay || day > lastAllowedDay) throw new Error('social publish time is outside the supported reservation window');
    const nowNearRollover = dayKey(new Date(Date.parse(nowIso) + SOCIAL_PUBLISH_ROLLOVER_GUARD_MS)) !== today;
    const publishNearRollover = dayKey(new Date(Date.parse(publishAt) + SOCIAL_PUBLISH_ROLLOVER_GUARD_MS)) !== day;
    const reserveNextDay = item.reserveNextDay === true;
    if (item.reserveNextDay !== undefined && typeof item.reserveNextDay !== 'boolean') {
      throw new Error('reserveNextDay must be a boolean');
    }
    if (reserveNextDay && platform !== 'facebook') throw new Error('reserveNextDay is supported only for Facebook schedules');
    const reservationDays = reserveNextDay || ((nowNearRollover && day === today) || publishNearRollover)
      ? [day, dayOffset(day, 1)]
      : [day];
    const pendingGroup = String(item.pendingGroup || '').trim();
    if (pendingGroup && !/^[a-z][a-z0-9-]{0,63}$/u.test(pendingGroup)) throw new Error('invalid social publish pending group');
    const nativeContentFingerprint = item.nativeContentFingerprint === undefined
      ? undefined
      : String(item.nativeContentFingerprint || '').trim();
    if (nativeContentFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(nativeContentFingerprint)) {
      throw new Error('native social publish content fingerprint must be a SHA-256 hex digest');
    }
    return {
      key,
      keyHash: reservationKeyHash(platform, key),
      publishAt,
      day,
      reservationDays,
      ...(nativeContentFingerprint ? { nativeContentFingerprint } : {}),
      ...(pendingGroup ? { pendingGroup } : {}),
    };
  });
  if (new Set(normalized.map((item) => item.keyHash)).size !== normalized.length) {
    throw new Error('social publish reservation batch contains duplicate keys');
  }

  const publishDays = new Set(normalized.map((item) => item.day));
  for (const item of normalized) for (const day of item.reservationDays) publishDays.add(day);
  for (let offset = -SOCIAL_PUBLISH_RESERVATION_RETENTION_DAYS; offset <= SOCIAL_PUBLISH_LOOKAHEAD_DAYS; offset += 1) {
    publishDays.add(dayOffset(today, offset));
  }
  const ledgerReservations = collectSocialPublishLedgerReservations({ platform, repoRoot, publishDays: [...publishDays], ledgerData, capGroup });
  const historicalLedgerReservations = collectSocialPublishLedgerReservations({ platform, repoRoot, ledgerData, capGroup });
  const ledgerItems = ledgerReservations.map((item) => ({
    ...item,
    keyHash: reservationKeyHash(platform, item.key),
    day: dayKey(item.publishAt),
  }));
  const historicalLedgerKeyHashes = new Set(historicalLedgerReservations
    .filter((item) => platform !== 'linkedinMember'
      || Date.parse(nowIso) - Date.parse(item.publishAt) <= SOCIAL_LINKEDIN_MEMBER_IDENTITY_TTL_MS)
    .map((item) => reservationKeyHash(platform, item.key)));
  const db = suppliedDb || await getFirestoreDb();
  const accountHash = digest(account);
  const ref = db.collection(SOCIAL_PUBLISH_RESERVATION_COLLECTION).doc(reservationDocId(platform, account, capGroup));
  const identityRefs = normalized.map((item) => db.collection(SOCIAL_PUBLISH_RESERVATION_COLLECTION)
    .doc(publishedIdentityDocId(platform, account, item.keyHash)));

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const identitySnapshots = await Promise.all(identityRefs.map((identityRef) => transaction.get(identityRef)));
    const stored = validateStoredDocument(snapshot.exists ? snapshot.data() : null, platform, accountHash, capGroup);
    const publishedIdentities = new Set();
    for (const [index, identitySnapshot] of identitySnapshots.entries()) {
      if (!identitySnapshot.exists) continue;
      const identity = validatePublishedIdentity(identitySnapshot.data(), platform, accountHash, normalized[index].keyHash);
      const identityAgeMs = Date.parse(nowIso) - Date.parse(identity.publishedAt);
      if (platform !== 'linkedinMember' || identityAgeMs <= SOCIAL_LINKEDIN_MEMBER_IDENTITY_TTL_MS) {
        publishedIdentities.add(normalized[index].keyHash);
      }
    }
    const days = Object.fromEntries(Object.entries(stored.days)
      .filter(([day]) => day >= firstRetainedDay && day <= lastAllowedDay)
      .map(([day, bucket]) => [day, structuredClone(bucket)]));
    const pending = structuredClone(stored.pending);
    for (const [day, bucket] of Object.entries(stored.days)) {
      for (const [keyHash, reservation] of Object.entries(bucket.reservations)) {
        if (reservation.status === 'reserved') {
          pending[keyHash] ||= {
            keyHash,
            status: 'reserved',
            day,
            publishAt: reservation.publishAt,
            ...(reservation.nativeContentFingerprint ? { nativeContentFingerprint: reservation.nativeContentFingerprint } : {}),
            ...(reservation.pendingGroup ? { pendingGroup: reservation.pendingGroup } : {}),
          };
        }
      }
    }

    const bucketFor = (day) => {
      days[day] ||= { cap, reservations: {} };
      days[day].cap = cap;
      return days[day];
    };

    for (const item of ledgerItems) {
      const bucket = bucketFor(item.day);
      for (const [otherDay, otherBucket] of Object.entries(days)) {
        if (otherDay === item.day) continue;
        if (otherBucket.reservations[item.keyHash]?.status === 'reserved') {
          delete otherBucket.reservations[item.keyHash];
          if (Object.keys(otherBucket.reservations).length === 0) delete days[otherDay];
        }
      }
      bucket.reservations[item.keyHash] = {
        keyHash: item.keyHash,
        status: 'published',
        publishAt: item.publishAt,
        source: 'ledger',
      };
      delete pending[item.keyHash];
    }
    for (const keyHash of Object.keys(pending)) {
      if (historicalLedgerKeyHashes.has(keyHash)) delete pending[keyHash];
    }

    const retainedReservations = new Map();
    for (const bucket of Object.values(days)) {
      for (const reservation of Object.values(bucket.reservations)) {
        const existing = retainedReservations.get(reservation.keyHash);
        if (!existing || reservation.status === 'published') retainedReservations.set(reservation.keyHash, reservation);
      }
    }

    const results = [];
    for (const item of normalized) {
      const buckets = item.reservationDays.map((day) => bucketFor(day));
      if (publishedIdentities.has(item.keyHash)) {
        results.push({ key: item.key, allowed: false, reason: 'already-published' });
        continue;
      }
      const existing = buckets.map((bucket) => bucket.reservations[item.keyHash]).find(Boolean)
        || retainedReservations.get(item.keyHash)
        || pending[item.keyHash];
      if (existing) {
        results.push({ key: item.key, allowed: false, reason: existing.status === 'published' ? 'already-published' : 'already-reserved' });
        continue;
      }
      if (historicalLedgerKeyHashes.has(item.keyHash)) {
        results.push({ key: item.key, allowed: false, reason: 'already-published' });
        continue;
      }
      if (item.pendingGroup && Object.values(pending).some((reservation) => (
        reservation.keyHash !== item.keyHash && reservation.pendingGroup === item.pendingGroup
      ))) {
        results.push({ key: item.key, allowed: false, reason: 'pending-publish-reconciliation' });
        continue;
      }
      if (buckets.some((bucket) => Object.values(bucket.reservations)
        .filter((reservation) => ACTIVE_STATUSES.has(reservation.status)).length >= bucket.cap)) {
        results.push({ key: item.key, allowed: false, reason: 'daily-cap' });
        continue;
      }
      for (const bucket of buckets) {
        bucket.reservations[item.keyHash] = {
          keyHash: item.keyHash,
          status: 'reserved',
          publishAt: item.publishAt,
          source: 'publisher',
          ...(item.nativeContentFingerprint ? { nativeContentFingerprint: item.nativeContentFingerprint } : {}),
          ...(item.pendingGroup ? { pendingGroup: item.pendingGroup } : {}),
        };
      }
      if (Object.keys(pending).length >= SOCIAL_PUBLISH_MAX_UNRESOLVED_RESERVATIONS) {
        throw new Error('Too many unresolved shared social publish reservations; publishing is held');
      }
      pending[item.keyHash] = {
        keyHash: item.keyHash,
        status: 'reserved',
        day: item.day,
        publishAt: item.publishAt,
        ...(item.nativeContentFingerprint ? { nativeContentFingerprint: item.nativeContentFingerprint } : {}),
        ...(item.pendingGroup ? { pendingGroup: item.pendingGroup } : {}),
      };
      retainedReservations.set(item.keyHash, buckets[0].reservations[item.keyHash]);
      results.push({ key: item.key, allowed: true, reason: null });
    }

    transaction.set(ref, {
      schemaVersion: SOCIAL_PUBLISH_RESERVATION_SCHEMA_VERSION,
      platform,
      accountHash,
      capGroup,
      days,
      pending,
      updatedAt: nowIso,
    });
    return results;
  });
}

async function updateSocialPublishReservation({
  db: suppliedDb,
  platform,
  capGroup = 'feed',
  accountId,
  key,
  keyHash: suppliedKeyHash,
  reconciliationEvidence = null,
  minimumAgeMs = SOCIAL_PUBLISH_RESERVATION_STALE_AFTER_MS,
  publishAt,
  publishedAt,
  now = new Date(),
  release = false,
  refresh = false,
  unpublishedConfirmed = false,
} = {}) {
  if (!LEDGER_FILES[platform]) throw new Error('unsupported social publishing platform');
  if (capGroup !== 'feed' && !(platform === 'instagram' && capGroup === 'story')) {
    throw new Error('unsupported social publication cap group');
  }
  if (refresh && platform !== 'facebook') throw new Error('reservation refresh is supported only for Facebook schedules');
  const scope = normalizeReservationScope({ platform, capGroup, accountId });
  const account = scope.account;
  const reservationKey = String(key || '').trim();
  if (suppliedKeyHash !== undefined && !reconciliationEvidence) {
    throw new Error('hashed reservation updates require exact native-post verification evidence');
  }
  if (suppliedKeyHash === undefined && (!reservationKey || reservationKey.length > 320)) {
    throw new Error('valid social publish reservation key is required');
  }
  if (suppliedKeyHash !== undefined && !/^[a-f0-9]{64}$/u.test(String(suppliedKeyHash))) {
    throw new Error('valid hashed social publish reservation identity is required');
  }
  if (reconciliationEvidence) {
    const expectedProvider = {
      facebook: 'facebook-graph',
      instagram: 'instagram-graph',
      linkedinMember: 'linkedin-posts',
    }[platform];
    if (!expectedProvider || reconciliationEvidence.provider !== expectedProvider
      || typeof reconciliationEvidence.nativePostId !== 'string'
      || !reconciliationEvidence.nativePostId.trim()
      || reconciliationEvidence.nativePostId.length > 256
      || /[\r\n\u0000]/u.test(reconciliationEvidence.nativePostId)
      || typeof reconciliationEvidence.nativeContentFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/u.test(reconciliationEvidence.nativeContentFingerprint)
      || !Number.isFinite(Date.parse(String(reconciliationEvidence.publishedAt || '')))
      || !Number.isFinite(Date.parse(String(reconciliationEvidence.verifiedAt || '')))) {
      throw new Error('invalid exact native-post reconciliation evidence');
    }
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 60_000 || minimumAgeMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error('minimum reservation age must be between one minute and seven days');
    }
  }
  const at = iso(publishAt ?? now, 'publishAt');
  const day = dayKey(at);
  const keyHash = suppliedKeyHash || reservationKeyHash(platform, reservationKey);
  const db = suppliedDb || await getFirestoreDb();
  const accountHash = scope.accountHash;
  const ref = db.collection(SOCIAL_PUBLISH_RESERVATION_COLLECTION).doc(reservationDocId(platform, account, capGroup));
  const identityRef = db.collection(SOCIAL_PUBLISH_RESERVATION_COLLECTION)
    .doc(publishedIdentityDocId(platform, account, keyHash));

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const identitySnapshot = await transaction.get(identityRef);
    const identity = identitySnapshot.exists
      ? validatePublishedIdentity(identitySnapshot.data(), platform, accountHash, keyHash)
      : null;
    if (identity) {
      const identityAgeMs = Date.parse(iso(now, 'now')) - Date.parse(identity.publishedAt);
      const identityStillActive = platform !== 'linkedinMember' || identityAgeMs <= SOCIAL_LINKEDIN_MEMBER_IDENTITY_TTL_MS;
      if (identityStillActive && release) return false;
      if (identityStillActive && refresh && !unpublishedConfirmed) return false;
    }
    if (!snapshot.exists && !identity) {
      const error = new Error('social publish reservation document is missing');
      error.code = SOCIAL_PUBLISH_RESERVATION_DOCUMENT_MISSING;
      throw error;
    }
    const stored = validateStoredDocument(snapshot.exists ? snapshot.data() : null, platform, accountHash, capGroup);
    const bucket = stored.days[day];
    const locatedBucket = Object.entries(stored.days)
      .find(([, candidate]) => candidate.reservations?.[keyHash]);
    const existing = bucket?.reservations?.[keyHash]
      || locatedBucket?.[1].reservations[keyHash]
      || stored.pending[keyHash];
    if (reconciliationEvidence) {
      const verifiedAtMs = Date.parse(iso(reconciliationEvidence.verifiedAt, 'verifiedAt'));
      const publishAtMs = Date.parse(String(existing?.publishAt || ''));
      const publishedAtMs = Date.parse(String(reconciliationEvidence.publishedAt || ''));
      if (!existing || existing.status !== 'reserved'
        || !Number.isFinite(publishAtMs)
        || verifiedAtMs - publishAtMs < minimumAgeMs
        || existing.nativeContentFingerprint !== reconciliationEvidence.nativeContentFingerprint
        || !Number.isFinite(publishedAtMs)
        || publishedAtMs < publishAtMs - SOCIAL_PUBLISH_RECONCILIATION_EARLY_DRIFT_MS
        || publishedAtMs > publishAtMs + SOCIAL_PUBLISH_RECONCILIATION_LATE_DRIFT_MS) {
        throw new Error('social publish reservation is not stale and unresolved for this account');
      }
    }
    if (refresh) {
      if ((!existing || existing.status !== 'reserved') && !unpublishedConfirmed) return false;
      if (existing?.status === 'published' && !unpublishedConfirmed) return false;
      const refreshAt = iso(publishAt ?? now, 'publishAt');
      const refreshDay = dayKey(refreshAt);
      const days = structuredClone(stored.days);
      const pending = structuredClone(stored.pending);
      for (const [reservedDay, reservedBucket] of Object.entries(days)) {
        if (!reservedBucket.reservations?.[keyHash]) continue;
        delete reservedBucket.reservations[keyHash];
        if (Object.keys(reservedBucket.reservations).length === 0) delete days[reservedDay];
      }
      const refreshedReservation = {
        keyHash,
        status: 'reserved',
        publishAt: refreshAt,
        source: 'publisher',
        ...(existing.nativeContentFingerprint ? { nativeContentFingerprint: existing.nativeContentFingerprint } : {}),
        ...(existing.pendingGroup ? { pendingGroup: existing.pendingGroup } : {}),
      };
      const refreshedDays = [refreshDay, dayOffset(refreshDay, 1)];
      for (const refreshedDay of refreshedDays) {
        const bucket = days[refreshedDay] || { cap: defaultDailyCap(platform, capGroup), reservations: {} };
        const activeCount = Object.values(bucket.reservations)
          .filter((reservation) => ACTIVE_STATUSES.has(reservation.status)).length;
        if (activeCount >= bucket.cap) return false;
      }
      for (const refreshedDay of refreshedDays) {
        days[refreshedDay] ||= { cap: defaultDailyCap(platform, capGroup), reservations: {} };
        days[refreshedDay].reservations[keyHash] = refreshedReservation;
      }
      pending[keyHash] = {
        keyHash,
        status: 'reserved',
        day: refreshDay,
        publishAt: refreshAt,
        ...(existing.nativeContentFingerprint ? { nativeContentFingerprint: existing.nativeContentFingerprint } : {}),
        ...(existing.pendingGroup ? { pendingGroup: existing.pendingGroup } : {}),
      };
      transaction.set(ref, { ...stored, days, pending, updatedAt: iso(now, 'now') });
      if (unpublishedConfirmed && identitySnapshot.exists) transaction.delete(identityRef);
      return true;
    }
    if (!existing && !identity) throw new Error('social publish reservation is missing');
    const confirmedAt = iso(publishedAt ?? existing?.publishAt ?? identity?.publishedAt ?? at, 'publishedAt');
    if (existing?.status === 'published' && existing.publishAt === confirmedAt) return true;
    if (release) {
      if (existing.status === 'published') return false;
      const days = structuredClone(stored.days);
      const pending = structuredClone(stored.pending);
      for (const [reservedDay, bucket] of Object.entries(days)) {
        if (bucket.reservations?.[keyHash]?.status !== 'reserved') continue;
        delete bucket.reservations[keyHash];
        if (Object.keys(bucket.reservations).length === 0) delete days[reservedDay];
      }
      delete pending[keyHash];
      transaction.set(ref, { ...stored, days, pending, updatedAt: iso(now, 'now') });
      return true;
    }
    const days = structuredClone(stored.days);
    const pending = structuredClone(stored.pending);
    const confirmedDay = dayKey(confirmedAt);
    for (const [reservedDay, bucket] of Object.entries(days)) {
      if (!bucket.reservations?.[keyHash]) continue;
      delete bucket.reservations[keyHash];
      if (Object.keys(bucket.reservations).length === 0 && reservedDay !== confirmedDay) delete days[reservedDay];
    }
    days[confirmedDay] ||= { cap: defaultDailyCap(platform, capGroup), reservations: {} };
    days[confirmedDay].reservations[keyHash] = {
      ...(existing || {}),
      keyHash,
      day: confirmedDay,
      publishAt: confirmedAt,
      status: 'published',
      source: existing?.source || 'publisher',
      ...(reconciliationEvidence ? { nativePostIdHash: digest(reconciliationEvidence.nativePostId) } : {}),
    };
    delete pending[keyHash];
    transaction.set(ref, { ...stored, days, pending, updatedAt: iso(now, 'now') });
    transaction.set(identityRef, {
      schemaVersion: SOCIAL_PUBLISH_RESERVATION_SCHEMA_VERSION,
      kind: 'published-identity',
      platform,
      accountHash,
      keyHash,
      publishedAt: confirmedAt,
    });
    if (reconciliationEvidence) {
      const verifiedAt = iso(reconciliationEvidence.verifiedAt, 'verifiedAt');
      const nativePostIdHash = digest(reconciliationEvidence.nativePostId);
      const auditId = `reconciliation_${digest(`${platform}\u0000${account}\u0000${keyHash}\u0000${nativePostIdHash}\u0000${verifiedAt}`).slice(0, 48)}`;
      const auditRef = db.collection(SOCIAL_PUBLISH_RESERVATION_COLLECTION).doc(auditId);
      transaction.set(auditRef, {
        schemaVersion: SOCIAL_PUBLISH_RESERVATION_SCHEMA_VERSION,
        kind: 'exact-native-post-reconciliation',
        platform,
        capGroup,
        accountHash,
        keyHash,
        nativePostIdHash,
        provider: reconciliationEvidence.provider,
        nativeContentFingerprint: reconciliationEvidence.nativeContentFingerprint,
        publishedAt: confirmedAt,
        verifiedAt,
      });
    }
    return true;
  });
}

export function markSocialPublishReservationPublished(options = {}) {
  return updateSocialPublishReservation(options);
}

/** Settle an unresolved reservation only after an exact native API read confirms publication. */
export function reconcileSocialPublishReservationPublished({
  db,
  platform,
  capGroup = 'feed',
  accountId,
  keyHash,
  nativePostId,
  provider,
  nativeContentFingerprint,
  publishedAt,
  verifiedAt = new Date(),
  minimumAgeMs = SOCIAL_PUBLISH_RESERVATION_STALE_AFTER_MS,
} = {}) {
  const verifiedTime = iso(verifiedAt, 'verifiedAt');
  const confirmedTime = iso(publishedAt, 'publishedAt');
  return updateSocialPublishReservation({
    db,
    platform,
    capGroup,
    accountId,
    keyHash,
    publishAt: confirmedTime,
    publishedAt: confirmedTime,
    now: verifiedTime,
    minimumAgeMs,
    reconciliationEvidence: {
      nativePostId: String(nativePostId || '').trim(),
      provider,
      nativeContentFingerprint,
      publishedAt: confirmedTime,
      verifiedAt: verifiedTime,
    },
  });
}

export function releaseSocialPublishReservation(options = {}) {
  return updateSocialPublishReservation({ ...options, release: true });
}

export function refreshSocialPublishReservation(options = {}) {
  return updateSocialPublishReservation({ ...options, refresh: true });
}
