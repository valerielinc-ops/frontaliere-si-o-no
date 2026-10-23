import { assertSiteAdmin } from './adminAuth.js';
import { getRemoteConfigTemplate } from './remoteConfigSecrets.js';

const SECRET_NAME = /KEY|TOKEN|SECRET|PAT|PASSWORD|PASS|AUTH|SID|DSN|CERT|SALT|SIGNING|SERVICE_ACCOUNT|PRIVATE|CLIENT_SECRET|CREDENTIAL|WEBHOOK/iu;
const CREDENTIAL_VALUE = /(?:sk[-_]|gh[pousr]_|AIza|Bearer\s+|-----BEGIN|eyJ[a-zA-Z0-9_-]{16,}|[a-f0-9]{32,})/iu;
const SAFE_VARIANT = /^[a-z][a-z0-9_.-]{0,31}$/iu;
const SAFE_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const URL_LIKE = /(?:https?:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|\s|$)/iu;

function response(status, body) { return { status, body }; }

function valueOf(value) {
  return value && typeof value === 'object' && 'value' in value && value.value !== null && value.value !== undefined ? String(value.value) : '';
}

function hasLongMixedAlphanumericSequence(value) {
  return String(value).split(/[^a-z0-9]+/iu).some((sequence) => sequence.length >= 16 && /[a-z]/iu.test(sequence) && /\d/u.test(sequence));
}

function isSafeFlagAtom(value) {
  const normalized = String(value).trim();
  if (!normalized) return false;
  if (/^(?:true|false)$/iu.test(normalized)) return true;
  if (SAFE_NUMBER.test(normalized)) return true;
  return SAFE_VARIANT.test(normalized) && !hasLongMixedAlphanumericSequence(normalized);
}

function normalizeSafeFlagValue(value) {
  const normalized = String(value).trim();
  const parts = normalized.split(',').map((part) => part.trim());
  return parts.join(',');
}

function isSafeFlagValue(value) {
  const normalized = String(value).trim();
  if (!normalized) return false;
  const parts = normalized.split(',');
  return parts.every(isSafeFlagAtom);
}

function isSafeDescription(value) {
  const description = String(value).trim();
  return description.length <= 240 && !URL_LIKE.test(description) && !CREDENTIAL_VALUE.test(description) && !hasLongMixedAlphanumericSequence(description);
}

function hiddenReason(name, parameter) {
  if (SECRET_NAME.test(name)) return 'nome sensibile';
  const values = [valueOf(parameter?.defaultValue), ...Object.values(parameter?.conditionalValues || {}).map(valueOf)];
  return values.some((value) => !isSafeFlagValue(value)) ? 'non è un flag' : null;
}

export function isRemoteConfigSecret(name, parameter) {
  return hiddenReason(name, parameter) !== null;
}

export function sanitizeRemoteConfigParameters(template) {
  const parameters = template?.parameters && typeof template.parameters === 'object' ? template.parameters : {};
  return Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)).map(([name, parameter]) => {
    const reason = hiddenReason(name, parameter);
    if (reason) return { name, hidden: true, reason };
    const description = typeof parameter?.description === 'string' && isSafeDescription(parameter.description) ? parameter.description.trim() : '';
    return {
      name,
      defaultValue: normalizeSafeFlagValue(valueOf(parameter?.defaultValue)),
      conditionalValues: Object.entries(parameter?.conditionalValues || {}).map(([condition, value]) => ({ condition, value: normalizeSafeFlagValue(valueOf(value)) })),
      description,
    };
  });
}

export async function handleAdminRemoteConfig(req, dependencies = {}) {
  if (String(req?.method || 'GET').toUpperCase() !== 'GET') return response(405, { ok: false, error: 'method_not_allowed' });
  const authGate = dependencies.assertSiteAdmin || assertSiteAdmin;
  const auth = await authGate(req);
  if (!auth.ok) return response(auth.status, { ok: false, error: auth.error });
  try {
    const template = await (dependencies.getTemplate || getRemoteConfigTemplate)();
    return response(200, { ok: true, parameters: sanitizeRemoteConfigParameters(template) });
  } catch (error) {
    console.error('adminRemoteConfig GET failed', error);
    return response(500, { ok: false, error: 'remote_config_read_failed' });
  }
}
