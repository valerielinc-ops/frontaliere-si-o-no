const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WARNING_DAYS = 14;

const TOKEN_FIELDS = Object.freeze([
  {
    label: 'Meta user token',
    token: 'FB_USER_ACCESS_TOKEN',
    expiry: 'FB_USER_ACCESS_TOKEN_EXPIRES_AT',
  },
  {
    label: 'Facebook Page token',
    token: 'FB_PAGE_ACCESS_TOKEN',
    expiry: 'FB_PAGE_ACCESS_TOKEN_EXPIRES_AT',
  },
  {
    label: 'Instagram publisher token',
    token: 'INSTAGRAM_ACCESS_TOKEN',
    expiry: 'INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT',
  },
]);

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseExpiry(value) {
  const normalized = String(value ?? '').trim();
  if (normalized === '0') return { never: true, timestamp: null };
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  return { never: false, timestamp };
}

/**
 * Assess only the expiry metadata saved by the token setup flow. This is an
 * alert, not proof that Meta still accepts a token; publishing readiness makes
 * the live read-only permission probes separately.
 */
export function classifyMetaTokenLifecycle({ env = {}, now = Date.now(), warningDays = DEFAULT_WARNING_DAYS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const thresholdDays = Number.isFinite(Number(warningDays)) && Number(warningDays) > 0
    ? Math.min(90, Number(warningDays))
    : DEFAULT_WARNING_DAYS;
  const configured = TOKEN_FIELDS.map((field) => ({
    ...field,
    tokenPresent: present(env[field.token]),
    expiryPresent: present(env[field.expiry]),
    parsedExpiry: parseExpiry(env[field.expiry]),
  })).filter((field) => field.tokenPresent || field.expiryPresent);

  if (configured.length === 0) {
    return {
      state: 'not-configured',
      actionRequired: false,
      reason: 'No Meta user or Facebook Page token is configured; channel readiness owns the setup alert.',
      earliestExpiryAt: null,
    };
  }

  const unknown = configured.filter((field) => !field.tokenPresent || !field.parsedExpiry);
  const expired = configured.filter((field) => field.parsedExpiry?.timestamp !== null
    && field.parsedExpiry?.timestamp !== undefined
    && field.parsedExpiry.timestamp <= nowMs);
  if (expired.length) {
    return {
      state: 'expired',
      actionRequired: true,
      reason: `${expired.map((field) => field.label).join(' and ')} expiry metadata is at or before the current time. Re-provision before relying on unattended publishing.`,
      earliestExpiryAt: new Date(Math.min(...expired.map((field) => field.parsedExpiry.timestamp))).toISOString(),
    };
  }
  if (unknown.length) {
    return {
      state: 'expiry-unverified',
      actionRequired: true,
      reason: `${unknown.map((field) => field.label).join(' and ')} is configured without verifiable expiry metadata. Re-run the safe Meta token setup before relying on unattended publishing.`,
      earliestExpiryAt: null,
    };
  }

  const finiteExpiries = configured
    .map((field) => ({ field, timestamp: field.parsedExpiry.timestamp }))
    .filter((item) => item.timestamp !== null);
  if (finiteExpiries.length === 0) {
    return {
      state: 'healthy',
      actionRequired: false,
      reason: 'Meta reports no scheduled expiry for the configured tokens; live permission probes remain authoritative.',
      earliestExpiryAt: null,
    };
  }

  const earliest = finiteExpiries.reduce((current, item) => item.timestamp < current.timestamp ? item : current);
  const expiresInMs = earliest.timestamp - nowMs;
  const expiryDate = new Date(earliest.timestamp).toISOString();
  if (expiresInMs <= thresholdDays * DAY_MS) {
    return {
      state: 'expiring-soon',
      actionRequired: true,
      reason: `${earliest.field.label} is due to expire at ${expiryDate}; renew before the unattended publishing credentials lapse.`,
      earliestExpiryAt: expiryDate,
    };
  }

  return {
    state: 'healthy',
    actionRequired: false,
    reason: `The earliest verified Meta token expiry is ${expiryDate}; renewal alert threshold is ${thresholdDays} days.`,
    earliestExpiryAt: expiryDate,
  };
}
