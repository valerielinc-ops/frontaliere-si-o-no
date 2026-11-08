import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setInstagramLoginGithubSecret } from './instagram-login-github-secrets.mjs';
import { getServiceAccountAccessToken } from './google-service-account-token.mjs';
import { fetchRemoteConfigTemplate } from '../load-rc-env.mjs';
import { RC_SCOPE, stageRcParamValue, updateRcTemplateWithEtag } from './remote-config-admin.mjs';

export const INSTAGRAM_LOGIN_RC_NAMESPACE = 'firebase-server';
export const INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY = 'INSTAGRAM_LOGIN_CREDENTIALS_WRITE_LOCK';
const LOCK_IDLE_VALUE = 'idle';

const INSTAGRAM_LOGIN_RC_KEYS = new Set([
  'INSTAGRAM_LOGIN_APP_ID',
  'INSTAGRAM_LOGIN_REDIRECT_URI',
  'INSTAGRAM_PUBLISHING_AUTH_MODE',
  'INSTAGRAM_LOGIN_USER_ID',
  'INSTAGRAM_LOGIN_USERNAME',
  'INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT',
  'INSTAGRAM_LOGIN_GRANTED_SCOPES',
  INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY,
]);

export const INSTAGRAM_LOGIN_ACCOUNT_METADATA_KEYS = Object.freeze([
  'INSTAGRAM_PUBLISHING_AUTH_MODE',
  'INSTAGRAM_LOGIN_USER_ID',
  'INSTAGRAM_LOGIN_USERNAME',
  'INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT',
  'INSTAGRAM_LOGIN_GRANTED_SCOPES',
]);

function currentValue(template, key) {
  const value = template?.parameters?.[key]?.defaultValue?.value;
  return typeof value === 'string' ? value.trim() : '';
}

function parseCredentialWriteLock(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === LOCK_IDLE_VALUE) return null;
  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed.id === 'string' && parsed.id.trim()) {
      const expiresAt = Date.parse(String(parsed.expiresAt || ''));
      const pending = parsed.state === 'pending';
      return {
        id: parsed.id,
        state: pending ? 'pending' : 'lease',
        secretName: typeof parsed.secretName === 'string' ? parsed.secretName : '',
        expiresAt: pending || !Number.isFinite(expiresAt) ? Number.POSITIVE_INFINITY : expiresAt,
      };
    }
  } catch {
    // An unrecognized lock value is treated as active so writers fail closed.
  }
  return { id: null, expiresAt: Number.POSITIVE_INFINITY };
}

export function isInstagramLoginCredentialWriteLocked(value, now = Date.now()) {
  const lock = parseCredentialWriteLock(value);
  return Boolean(lock && lock.expiresAt > now);
}

export function isInstagramLoginCredentialWritePending(value, secretName) {
  const lock = parseCredentialWriteLock(value);
  return Boolean(lock?.state === 'pending' && (!secretName || lock.secretName === secretName));
}

export function stageInstagramLoginValues(template, values, {
  expectedValues = {},
  lockId,
  recoverySecretName,
  allowLockValue = false,
  now = Date.now(),
} = {}) {
  for (const [key, expectedValue] of Object.entries(expectedValues)) {
    if (!INSTAGRAM_LOGIN_RC_KEYS.has(key)) {
      return { changed: false, error: `refused Instagram Login Remote Config compare key: ${key}` };
    }
    const expected = expectedValue == null ? '' : String(expectedValue).trim();
    if (currentValue(template, key) !== expected) {
      return { changed: false, error: `Instagram Login metadata changed during credential update: ${key}` };
    }
  }

  const lockValue = currentValue(template, INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY);
  const currentLock = parseCredentialWriteLock(lockValue);
  if (lockId) {
    if (currentLock?.id !== lockId) {
      return { changed: false, error: 'Instagram Login credential-write lock is no longer owned by this update' };
    }
  } else if (currentLock?.state === 'pending' && currentLock.secretName === recoverySecretName) {
    // Only an explicit rewrite of the same secret can recover an uncertain write.
  } else if (isInstagramLoginCredentialWriteLocked(lockValue, now)) {
    return { changed: false, error: 'Instagram Login credentials are being updated by another process' };
  }

  let nextTemplate = template;
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    if (!INSTAGRAM_LOGIN_RC_KEYS.has(key) || (key === INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY && !allowLockValue)) {
      return { changed: false, error: `refused Instagram Login Remote Config key: ${key}` };
    }
    if (value === null) {
      for (const [group, definition] of Object.entries(nextTemplate?.parameterGroups ?? {})) {
        if (definition?.parameters && key in definition.parameters) {
          return { changed: false, error: `${key} sits in parameter group ${JSON.stringify(group.slice(0, 60))}; it must be a top-level parameter` };
        }
      }
      const parameters = nextTemplate?.parameters ?? {};
      if (key in parameters) {
        const nextParameters = { ...parameters };
        delete nextParameters[key];
        nextTemplate = { ...nextTemplate, parameters: nextParameters };
        changed = true;
      }
      continue;
    }
    if (typeof value !== 'string' || !value.trim() || /[\r\n\u0000]/u.test(value)) {
      return { changed: false, error: `refused invalid Instagram Login Remote Config value: ${key}` };
    }
    const staged = stageRcParamValue(nextTemplate, key, value, 'Instagram Login publishing metadata');
    if (staged.error) return staged;
    changed ||= staged.changed;
    nextTemplate = staged.template;
  }
  return { changed, template: nextTemplate };
}

async function updateInstagramLoginValues(values, {
  expectedValues = {},
  lockId,
  recoverySecretName,
  allowLockValue = false,
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS,
  now = new Date(),
  description = 'Instagram Login metadata update',
} = {}) {
  if (!credentialsPath) throw new Error('Firebase Remote Config credentials are unavailable');
  const serviceAccount = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const result = await updateRcTemplateWithEtag({
    credentials: serviceAccount,
    namespace: INSTAGRAM_LOGIN_RC_NAMESPACE,
    versionDescription: `${description} ${now.toISOString().slice(0, 10)}`,
    stage: (template) => stageInstagramLoginValues(template, values, {
      expectedValues,
      lockId,
      recoverySecretName,
      allowLockValue,
      now: now.valueOf(),
    }),
  });
  if (!result.ok) {
    const error = new Error(`Firebase Remote Config update failed (${result.detail || 'unknown error'})`);
    error.instagramRemoteConfigWriteAmbiguous = result.ambiguous === true;
    throw error;
  }
  return { changed: result.changed === true, attempt: result.attempt };
}

export async function writeInstagramLoginCredentials(values, {
  expectedCurrentExpiresAt,
  expectedValues = {},
  lockId,
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS,
  now = new Date(),
} = {}) {
  const comparisons = { ...expectedValues };
  if (expectedCurrentExpiresAt !== undefined) {
    comparisons.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT = expectedCurrentExpiresAt;
  }
  return updateInstagramLoginValues(values, { expectedValues: comparisons, lockId, credentialsPath, now });
}

export async function acquireInstagramLoginCredentialWriteLock({
  expectedValues = {},
  recoverySecretName,
  expectedLockValue,
  secretName,
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS,
  now = new Date(),
} = {}) {
  if (!['INSTAGRAM_LOGIN_ACCESS_TOKEN', 'INSTAGRAM_LOGIN_APP_SECRET'].includes(secretName)) {
    throw new Error('Instagram Login credential-write lock secret is invalid');
  }
  const lockId = randomUUID();
  const lockValue = JSON.stringify({ id: lockId, state: 'pending', secretName });
  const comparisons = { ...expectedValues };
  if (recoverySecretName) {
    if (recoverySecretName !== secretName || !expectedLockValue) {
      throw new Error('Instagram Login pending-lock recovery requires the exact prior lock snapshot');
    }
    comparisons[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY] = expectedLockValue;
  }
  await updateInstagramLoginValues({
    [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: lockValue,
  }, {
    expectedValues: comparisons,
    recoverySecretName,
    allowLockValue: true,
    credentialsPath,
    now,
    description: 'Instagram Login credential update lock',
  });
  return { id: lockId, secretName };
}

export async function releaseInstagramLoginCredentialWriteLock(lock, {
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS,
  now = new Date(),
} = {}) {
  if (!lock?.id) throw new Error('Instagram Login credential-write lock identity is missing');
  return updateInstagramLoginValues({
    [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: LOCK_IDLE_VALUE,
  }, {
    lockId: lock.id,
    allowLockValue: true,
    credentialsPath,
    now,
    description: 'Instagram Login credential update lock release',
  });
}

/** Write public metadata under the Remote Config lock, then atomically rotate the private token secret. */
export async function commitInstagramLoginCredentialUpdate({
  accessToken,
  values,
  previousValues,
  expectedValues = {},
  secretName = 'INSTAGRAM_LOGIN_ACCESS_TOKEN',
  now = new Date(),
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS,
  acquireLock = acquireInstagramLoginCredentialWriteLock,
  releaseLock = releaseInstagramLoginCredentialWriteLock,
  writeCredentials = writeInstagramLoginCredentials,
  setSecret = setInstagramLoginGithubSecret,
  recoverPending = false,
  expectedLockValue,
} = {}) {
  if (!accessToken || !values || !previousValues) throw new Error('Instagram Login credential transaction is incomplete');
  const lock = await acquireLock({
    expectedValues,
    ...(recoverPending ? { recoverySecretName: secretName } : {}),
    ...(recoverPending ? { expectedLockValue } : {}),
    secretName,
    credentialsPath,
    now,
  });
  let release = !recoverPending;
  try {
    let saved;
    try {
      saved = await writeCredentials(values, { lockId: lock.id, credentialsPath, now });
    } catch (metadataError) {
      if (metadataError?.instagramRemoteConfigWriteAmbiguous) release = false;
      throw metadataError;
    }
    try {
      setSecret(secretName, accessToken);
    } catch (secretError) {
      if (secretError?.instagramSecretWriteAmbiguous) {
        release = false;
        throw new Error(`GitHub secret update outcome is ambiguous; rerun the ${secretName === 'INSTAGRAM_LOGIN_APP_SECRET' ? 'app provisioning' : 'OAuth or token refresh'} flow to reconcile it`, { cause: secretError });
      }
      try {
        await writeCredentials(previousValues, { lockId: lock.id, credentialsPath, now });
      } catch (rollbackError) {
        release = false;
        throw new Error('GitHub secret update failed and prior Remote Config metadata could not be restored; publishing remains held for explicit recovery', { cause: rollbackError });
      }
      throw secretError;
    }
    release = true;
    return saved;
  } finally {
    if (release) await releaseLock(lock, { credentialsPath, now });
  }
}

export async function readInstagramLoginCredentials({
  credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS,
  keys = [...INSTAGRAM_LOGIN_RC_KEYS],
  allowMissingTemplate = false,
} = {}) {
  if (!credentialsPath) throw new Error('Firebase Remote Config credentials are unavailable');
  for (const key of keys) {
    if (!INSTAGRAM_LOGIN_RC_KEYS.has(key)) throw new Error(`refused Instagram Login Remote Config read key: ${key}`);
  }
  const serviceAccount = JSON.parse(await readFile(credentialsPath, 'utf8'));
  if (!serviceAccount?.project_id) throw new Error('Firebase service-account JSON has no project_id');
  const accessToken = await getServiceAccountAccessToken(serviceAccount, RC_SCOPE);
  let template;
  try {
    template = await fetchRemoteConfigTemplate({
      projectId: serviceAccount.project_id,
      accessToken,
      namespace: INSTAGRAM_LOGIN_RC_NAMESPACE,
    });
  } catch (error) {
    if (allowMissingTemplate && /\b404\b/u.test(String(error?.message || ''))) {
      return Object.fromEntries(keys.map((key) => [key, '']));
    }
    throw error;
  }
  return Object.fromEntries(keys.map((key) => {
    const value = template?.parameters?.[key]?.defaultValue?.value;
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (/[\r\n\u0000]/u.test(normalized)) throw new Error(`Instagram Login Remote Config value for ${key} contains an invalid line break`);
    return [key, normalized];
  }));
}
