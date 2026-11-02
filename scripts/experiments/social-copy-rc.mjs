#!/usr/bin/env node
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { setRcParamWithEtag } from '../lib/remote-config-admin.mjs';

export const SOCIAL_COPY_EXPERIMENT_CONFIG = Object.freeze({
  schemaVersion: 1,
  experimentId: 'social-copy-balanced-v1',
  enabled: true,
});
export const SOCIAL_COPY_EXPERIMENT_PARAM = 'SOCIAL_COPY_EXPERIMENT_CONFIG';

export function parseServiceAccount(raw) {
  try {
    const credentials = JSON.parse(raw || '');
    if (
      credentials?.type !== 'service_account'
      || typeof credentials.project_id !== 'string'
      || typeof credentials.client_email !== 'string'
      || typeof credentials.private_key !== 'string'
    ) return null;
    return credentials;
  } catch {
    return null;
  }
}

export async function run({
  env = process.env,
  setParam = setRcParamWithEtag,
  stdout = process.stdout,
} = {}) {
  const credentials = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!credentials) {
    stdout.write('Social copy experiment config skipped: Firebase service account unavailable.\n');
    return 0;
  }

  const value = JSON.stringify(SOCIAL_COPY_EXPERIMENT_CONFIG);
  const result = await setParam({
    credentials,
    name: SOCIAL_COPY_EXPERIMENT_PARAM,
    value,
    description: 'Enables stable, balanced Firebase assignment for validated social-copy variants.',
    versionDescription: 'Enable balanced Codex social-copy assignment',
  });
  if (!result?.ok) throw new Error('Remote Config social-copy experiment update failed: ' + (result?.detail || 'unknown error'));
  stdout.write(result.changed
    ? 'Published balanced social-copy assignment config to Firebase Remote Config.\n'
    : 'Balanced social-copy assignment config is already current.\n');
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write('Social copy experiment config failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
