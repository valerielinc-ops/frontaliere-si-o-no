export const APPLICATION_INTENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_APPLICATION_INTENT_SIGNALS = 100;
export const MAX_APPLICATION_INTENT_SCAN = MAX_APPLICATION_INTENT_SIGNALS * 5;

// One exact, non-stacking score increment: larger than a passive job-view
// signal, while bounded independently of how many times the person clicked.
export const PERSONAL_APPLICATION_INTENT_BOOST = 8;
export const ALERT_APPLICATION_INTENT_BOOST = 6;

const MAX_JOB_KEY_LENGTH = 240;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === 'function') {
    const timestamp = value.toMillis();
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }
  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }
  return NaN;
}

/** Stable identity shared by the apply-click writer and ranking consumers. */
export function buildApplicationIntentJobKey(job = {}) {
  const companyKey = clean(job.companyKey) || 'unknown-company';
  const canonicalSlug = clean(job.slugByLocale?.it) || clean(job.slug);
  const key = canonicalSlug
    ? `${companyKey}:${canonicalSlug}`
    : `${companyKey}:id:${clean(job.id) || 'unknown-job'}`;
  return key.length <= MAX_JOB_KEY_LENGTH ? key : '';
}

/**
 * Return only exact-job signals that are valid, unexpired and within the
 * server's 90-day retention window. A ranking opt-out is fail-closed.
 */
export function activeApplicationIntentJobKeys(applicationIntent, now = Date.now()) {
  if (!applicationIntent || typeof applicationIntent !== 'object') return new Set();
  if (applicationIntent.optedOut === true || !Array.isArray(applicationIntent.intents)) return new Set();

  const validKeys = [];
  for (const intent of applicationIntent.intents.slice(-MAX_APPLICATION_INTENT_SCAN)) {
    if (!intent || intent.application_status !== 'redirect_only') continue;
    const jobKey = clean(intent.jobKey);
    const timestamp = toEpochMs(intent.timestamp ?? intent.ts ?? intent.createdAt);
    const retentionUntil = toEpochMs(intent.retentionUntil);
    if (!jobKey || jobKey.length > MAX_JOB_KEY_LENGTH) continue;
    if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > APPLICATION_INTENT_RETENTION_MS) continue;
    if (!Number.isFinite(retentionUntil) || retentionUntil <= now) continue;
    if (retentionUntil > timestamp + APPLICATION_INTENT_RETENTION_MS) continue;
    validKeys.push(jobKey);
  }
  const keys = new Set(validKeys.slice(-MAX_APPLICATION_INTENT_SIGNALS));
  return keys;
}

/** Add/update one consented redirect-only signal without allowing growth. */
export function recordApplicationIntentSignal(applicationIntent, jobKey, now = Date.now()) {
  const current = applicationIntent && typeof applicationIntent === 'object' ? applicationIntent : {};
  const optedOut = current.optedOut === true;
  const existing = Array.isArray(current.intents)
    ? current.intents.slice(-MAX_APPLICATION_INTENT_SCAN)
    : [];
  const cutoff = now - APPLICATION_INTENT_RETENTION_MS;
  const intents = existing.filter((intent) => {
    if (!intent || intent.application_status !== 'redirect_only') return false;
    const timestamp = toEpochMs(intent.timestamp ?? intent.ts ?? intent.createdAt);
    const retentionUntil = toEpochMs(intent.retentionUntil);
    return Number.isFinite(timestamp)
      && timestamp <= now
      && timestamp > cutoff
      && Number.isFinite(retentionUntil)
      && retentionUntil > now
      && retentionUntil <= timestamp + APPLICATION_INTENT_RETENTION_MS
      && clean(intent.jobKey).length <= MAX_JOB_KEY_LENGTH;
  });

  if (optedOut || typeof jobKey !== 'string' || !jobKey.trim() || jobKey.length > MAX_JOB_KEY_LENGTH) {
    const unchangedProfile = { ...current, intents: intents.slice(-MAX_APPLICATION_INTENT_SIGNALS) };
    if (optedOut) unchangedProfile.optedOut = true;
    return { applicationIntent: unchangedProfile, recorded: false };
  }

  const normalizedKey = jobKey.trim();
  const next = intents.filter((intent) => intent.jobKey !== normalizedKey);
  next.push({
    jobKey: normalizedKey,
    application_status: 'redirect_only',
    timestamp: now,
    retentionUntil: now + APPLICATION_INTENT_RETENTION_MS,
  });
  const updatedProfile = { ...current, intents: next.slice(-MAX_APPLICATION_INTENT_SIGNALS) };
  if (optedOut) updatedProfile.optedOut = true;
  return { applicationIntent: updatedProfile, recorded: true };
}

/** Stable exact-job key ordering used only when the treatment is enabled. */
export function compareApplicationIntentJobKeys(a, b) {
  const keyA = buildApplicationIntentJobKey(a);
  const keyB = buildApplicationIntentJobKey(b);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}
