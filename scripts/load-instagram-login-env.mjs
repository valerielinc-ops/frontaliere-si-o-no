#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY,
  isInstagramLoginCredentialWriteLocked,
  isInstagramLoginCredentialWritePending,
  readInstagramLoginCredentials,
} from './lib/instagram-login-remote-config.mjs';
import {
  hasInstagramLoginPublishScopes,
  INSTAGRAM_LOGIN_PUBLISH_ENV,
} from './lib/instagram-publisher-credentials.mjs';

export { INSTAGRAM_LOGIN_PUBLISH_ENV };
export const INSTAGRAM_PUBLISHER_READY_ENV = 'INSTAGRAM_PUBLISHER_CREDENTIALS_PRESENT';

export function collectInstagramLoginPublishEnv(rcValues, {
  currentEnv = process.env,
  allowIncomplete = false,
  allowPendingTokenWriteLock = false,
  now = Date.now(),
} = {}) {
  const credentialLock = rcValues?.[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY];
  const pendingTokenWrite = allowPendingTokenWriteLock
    && isInstagramLoginCredentialWritePending(credentialLock, 'INSTAGRAM_LOGIN_ACCESS_TOKEN');
  if (isInstagramLoginCredentialWriteLocked(credentialLock, now) && !pendingTokenWrite) {
    throw new Error('Instagram Login credentials are being updated; publishing is held until the credential transaction finishes');
  }
  const mode = String(currentEnv.INSTAGRAM_PUBLISHING_AUTH_MODE || rcValues?.INSTAGRAM_PUBLISHING_AUTH_MODE || '').trim();
  if (mode && !['facebook_login', 'instagram_login'].includes(mode)) {
    return { selected: false, values: { [INSTAGRAM_PUBLISHER_READY_ENV]: 'false' } };
  }
  if (mode !== 'instagram_login') {
    const legacyReady = Boolean(
      String(currentEnv.INSTAGRAM_ACCESS_TOKEN || '').trim()
      && String(currentEnv.INSTAGRAM_BUSINESS_ACCOUNT_ID || '').trim(),
    );
    return { selected: false, values: { [INSTAGRAM_PUBLISHER_READY_ENV]: String(legacyReady) } };
  }

  const values = {};
  for (const [envName, rcName] of Object.entries(INSTAGRAM_LOGIN_PUBLISH_ENV)) {
    if (currentEnv[envName]) continue;
    const value = String(rcValues?.[rcName] || '').trim();
    if (value) values[envName] = value;
  }
  if (!currentEnv.INSTAGRAM_PUBLISHING_AUTH_MODE) values.INSTAGRAM_PUBLISHING_AUTH_MODE = mode;

  if (!allowIncomplete && !pendingTokenWrite) {
    const accessToken = String(currentEnv.INSTAGRAM_LOGIN_ACCESS_TOKEN || values.INSTAGRAM_LOGIN_ACCESS_TOKEN || '').trim();
    const userId = String(currentEnv.INSTAGRAM_LOGIN_USER_ID || values.INSTAGRAM_LOGIN_USER_ID || '').trim();
    const username = String(currentEnv.INSTAGRAM_LOGIN_USERNAME || values.INSTAGRAM_LOGIN_USERNAME || '').trim();
    const scopes = String(currentEnv.INSTAGRAM_LOGIN_GRANTED_SCOPES || values.INSTAGRAM_LOGIN_GRANTED_SCOPES || '').trim();
    const expiry = Date.parse(String(currentEnv.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT || values.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT || ''));
    if (!accessToken || !/^\d{5,32}$/u.test(userId) || !username || !hasInstagramLoginPublishScopes(scopes)
      || !Number.isFinite(expiry) || expiry <= now) {
      throw new Error('Instagram Login is selected but its GitHub token secret, publish grant, account identity, or valid expiry is missing');
    }
  }
  const accessToken = String(currentEnv.INSTAGRAM_LOGIN_ACCESS_TOKEN || values.INSTAGRAM_LOGIN_ACCESS_TOKEN || '').trim();
  const userId = String(currentEnv.INSTAGRAM_LOGIN_USER_ID || values.INSTAGRAM_LOGIN_USER_ID || '').trim();
  const username = String(currentEnv.INSTAGRAM_LOGIN_USERNAME || values.INSTAGRAM_LOGIN_USERNAME || '').trim();
  const scopes = String(currentEnv.INSTAGRAM_LOGIN_GRANTED_SCOPES || values.INSTAGRAM_LOGIN_GRANTED_SCOPES || '').trim();
  const expiry = Date.parse(String(currentEnv.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT || values.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT || ''));
  values[INSTAGRAM_PUBLISHER_READY_ENV] = String(
    Boolean(accessToken && /^\d{5,32}$/u.test(userId) && username && hasInstagramLoginPublishScopes(scopes)
      && Number.isFinite(expiry) && expiry > now),
  );

  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n\u0000]/u.test(value)) throw new Error(`Instagram Login Remote Config value for ${key} contains an invalid line break`);
  }
  return { selected: true, values };
}

function parseArgs(argv) {
  const allowed = new Set(['--allow-incomplete', '--allow-pending-token-write-lock']);
  if (argv.some((arg) => !allowed.has(arg)) || new Set(argv).size !== argv.length) {
    throw new Error('usage: load-instagram-login-env.mjs [--allow-incomplete] [--allow-pending-token-write-lock]');
  }
  return {
    allowIncomplete: argv.includes('--allow-incomplete'),
    allowPendingTokenWriteLock: argv.includes('--allow-pending-token-write-lock'),
  };
}

function exportValues(values) {
  const entries = Object.entries(values).filter(([key]) => !process.env[key]);
  if (process.env.GITHUB_ENV) {
    if (entries.length) appendFileSync(process.env.GITHUB_ENV, `${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
    return;
  }
  for (const [key, value] of entries) {
    const escaped = value.replace(/'/g, "'\\''");
    console.log(`export ${key}='${escaped}'`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const { allowIncomplete, allowPendingTokenWriteLock } = parseArgs(argv);
  const rcValues = await readInstagramLoginCredentials({ allowMissingTemplate: true });
  const result = collectInstagramLoginPublishEnv(rcValues, { allowIncomplete, allowPendingTokenWriteLock });
  exportValues(result.values);
  console.error(result.selected
    ? `Instagram Login publisher metadata loaded from server Remote Config (${Object.keys(result.values).length} unset environment values).`
    : 'Instagram Login is not selected; no publisher metadata loaded.');
}

const directInvocation = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (directInvocation) {
  main().catch((error) => {
    console.error(`Instagram Login environment loading failed: ${error?.message || 'unexpected error'}`);
    process.exitCode = 1;
  });
}
