#!/usr/bin/env node
import {
  commitInstagramLoginCredentialUpdate,
  INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY,
  isInstagramLoginCredentialWritePending,
  readInstagramLoginCredentials,
} from './lib/instagram-login-remote-config.mjs';

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} must be supplied in the environment`);
  return value;
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Firebase Remote Config credentials are unavailable');
  const stored = await readInstagramLoginCredentials({ allowMissingTemplate: true });
  const appId = requiredEnv('INSTAGRAM_LOGIN_APP_ID');
  const appSecret = requiredEnv('INSTAGRAM_LOGIN_APP_SECRET');
  const redirectUri = requiredEnv('INSTAGRAM_LOGIN_REDIRECT_URI');
  const recoverPending = isInstagramLoginCredentialWritePending(
    stored[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY],
    'INSTAGRAM_LOGIN_APP_SECRET',
  );
  const redirect = new URL(redirectUri);
  if (!/^\d{5,32}$/u.test(appId)) throw new Error('INSTAGRAM_LOGIN_APP_ID must be the Instagram app ID shown in Meta Developer settings');
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)
    || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error('INSTAGRAM_LOGIN_REDIRECT_URI must be a registered loopback http URL with an explicit port');
  }
  const result = await commitInstagramLoginCredentialUpdate({
    accessToken: appSecret,
    secretName: 'INSTAGRAM_LOGIN_APP_SECRET',
    expectedValues: {
      INSTAGRAM_LOGIN_APP_ID: stored.INSTAGRAM_LOGIN_APP_ID || '',
      INSTAGRAM_LOGIN_REDIRECT_URI: stored.INSTAGRAM_LOGIN_REDIRECT_URI || '',
    },
    previousValues: {
      INSTAGRAM_LOGIN_APP_ID: stored.INSTAGRAM_LOGIN_APP_ID || null,
      INSTAGRAM_LOGIN_REDIRECT_URI: stored.INSTAGRAM_LOGIN_REDIRECT_URI || null,
    },
    values: {
      INSTAGRAM_LOGIN_APP_ID: appId,
      INSTAGRAM_LOGIN_REDIRECT_URI: redirectUri,
    },
    recoverPending,
    expectedLockValue: recoverPending ? stored[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY] : undefined,
  });
  console.log(`Instagram Login app secret saved to GitHub Actions Secrets; secret omitted from output. App metadata in Firebase server Remote Config ${result.changed ? 'updated' : 'already current'}.`);
}

main().catch((error) => {
  console.error(`Instagram Login app configuration failed: ${error?.message || 'unexpected error'}`);
  process.exitCode = 1;
});
