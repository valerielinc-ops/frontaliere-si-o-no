/**
 * Privacy gates for the application-intent signal.
 *
 * Application intent is a purpose-specific signal, not a newsletter, job
 * alert or saved-jobs preference.  Keep its account identity equally
 * purpose-specific: an intent may be associated with a verified Auth uid,
 * never guessed from an email address or an anonymous browser identifier.
 */

export const APPLICATION_INTENTS_COLLECTION = 'application_intents';
export const APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION = 'application_intent_account_tombstones';
export const APPLICATION_INTENT_OPT_OUT_FIELD = 'applicationIntent.optedOut';
export const APPLICATION_INTENT_ACCOUNT_DELETED_STATUS = 'account_deleted';
export const APPLICATION_INTENT_RETENTION_DAYS = 90;

const RETENTION_MS = APPLICATION_INTENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function normalizeUid(value) {
  const uid = typeof value === 'string' ? value.trim() : '';
  return uid || null;
}

function timestampToMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The preference is deliberately nested and purpose-specific.  In
 * particular, this must never read savedJobsDigest, newsletter or alert
 * state as a substitute for the application-intent choice.
 */
export function isApplicationIntentOptedOut(profile) {
  return profile?.applicationIntent?.optedOut === true;
}

/**
 * A tombstone is intentionally recognizable even after the original record
 * has been replaced with only deletion metadata.
 */
export function isApplicationIntentTombstone(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.account_deleted_at || record.deleted_at) return true;
  return String(record.status || '').trim().toLowerCase() === APPLICATION_INTENT_ACCOUNT_DELETED_STATUS;
}

/**
 * Resolve only an Auth identity.  No email argument is accepted here on
 * purpose: an anonymous signal cannot become account-linked by supposition.
 */
export function resolveApplicationIntentIdentity(identity) {
  const uid = normalizeUid(identity?.uid || identity?.userId);
  return uid ? { userId: uid } : null;
}

export function hasResolvedApplicationIntentIdentity(identity) {
  return resolveApplicationIntentIdentity(identity) !== null;
}

function isWithinApplicationIntentRetention(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return false;
  const explicitExpiry = timestampToMillis(record.retentionUntil || record.expiresAt);
  if (explicitExpiry !== null) return now < explicitExpiry;
  const occurredAt = timestampToMillis(
    record.occurred_at || record.occurredAt || record.created_at || record.createdAt,
  );
  return occurredAt !== null && now < occurredAt + RETENTION_MS;
}

function canUseApplicationIntent({ profile, intent, identity, accountDeleted = false, now = Date.now(), requireRetention = false }) {
  if (accountDeleted || isApplicationIntentOptedOut(profile) || isApplicationIntentTombstone(intent)) {
    return false;
  }
  const resolved = resolveApplicationIntentIdentity(identity || intent);
  if (!resolved) return false;
  if (intent && (intent.userId || intent.uid) && resolveApplicationIntentIdentity(intent)?.userId !== resolved.userId) {
    return false;
  }
  return !requireRetention || isWithinApplicationIntentRetention(intent, now);
}

/**
 * Registration gate.  Callers should pass the authenticated uid and the
 * user's profile; an anonymous caller is rejected and therefore cannot cause
 * a reminder/ranking record containing personal data to be created.
 */
export function canRegisterApplicationIntent({ profile, userId, accountDeleted = false } = {}) {
  return canUseApplicationIntent({
    profile,
    identity: { userId },
    accountDeleted,
  });
}

/** Gate for an application-intent reminder sender. */
export function canSendApplicationIntentReminder({ profile, intent, userId, accountDeleted = false, now = Date.now() } = {}) {
  return canUseApplicationIntent({
    profile,
    intent,
    identity: { userId },
    accountDeleted,
    now,
    requireRetention: true,
  });
}

/** Gate for ranking application-intent signals. */
export function canUseApplicationIntentForRanking({ profile, intent, userId, accountDeleted = false, now = Date.now() } = {}) {
  return canUseApplicationIntent({
    profile,
    intent,
    identity: { userId },
    accountDeleted,
    now,
    requireRetention: true,
  });
}

/**
 * Read the durable account-deletion boundary before a provider callback or a
 * late write.  Read failures intentionally propagate so callers fail closed.
 */
export async function isApplicationIntentAccountDeleted(db, rawUid) {
  const uid = normalizeUid(rawUid);
  if (!uid) return true;
  const snapshot = await db
    .collection(APPLICATION_INTENT_ACCOUNT_TOMBSTONES_COLLECTION)
    .doc(uid)
    .get();
  return snapshot.exists && isApplicationIntentTombstone(snapshot.data());
}

/**
 * Combined server-side write gate.  Future registration/callback handlers can
 * use this single predicate so the preference and deletion tombstone cannot
 * drift apart.
 */
export async function canWriteApplicationIntentForAccount(db, { uid, profile } = {}) {
  if (!canRegisterApplicationIntent({ profile, userId: uid })) return false;
  return !(await isApplicationIntentAccountDeleted(db, uid));
}

/** Build the metadata retained after account-linked intent data is erased. */
export function buildApplicationIntentAccountTombstone(uid, stamp = new Date().toISOString()) {
  const resolved = resolveApplicationIntentIdentity({ uid });
  if (!resolved) return null;
  return {
    userId: resolved.userId,
    status: APPLICATION_INTENT_ACCOUNT_DELETED_STATUS,
    account_deleted_at: stamp,
    deleted_at: stamp,
  };
}
