import { randomUUID } from 'node:crypto';
import { readFirebaseServiceAccountCredentials } from './firebase-service-account-credentials.mjs';
import {
  RC_SERVER_NAMESPACE,
  stageRcParamValue,
  updateRcTemplateWithEtag,
} from './remote-config-admin.mjs';

const PRIVATE_OAUTH_PARAMETERS = Object.freeze({
  'linkedin-member': new Set([
    'SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN',
    'SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT',
    'SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN',
    'SERVER_LINKEDIN_MEMBER_URN',
  ]),
  'reddit': new Set(['SERVER_REDDIT_REFRESH_TOKEN']),
  'tiktok-production': new Set([
    'SERVER_TIKTOK_ACCESS_TOKEN',
    'SERVER_TIKTOK_ACCESS_TOKEN_EXPIRES_AT',
    'SERVER_TIKTOK_REFRESH_TOKEN',
    'SERVER_TIKTOK_REFRESH_TOKEN_EXPIRES_AT',
  ]),
  'tiktok-sandbox': new Set([
    'SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN',
    'SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN_EXPIRES_AT',
    'SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN',
    'SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN_EXPIRES_AT',
  ]),
});

function assertPlatform(platform) {
  if (!Object.hasOwn(PRIVATE_OAUTH_PARAMETERS, platform)) {
    throw new Error('Unsupported social OAuth credential store');
  }
  return PRIVATE_OAUTH_PARAMETERS[platform];
}

function assertServiceAccount(credentials) {
  if (!credentials?.client_email || !credentials?.private_key || !credentials?.project_id) {
    throw new Error('Firebase service-account credentials are unavailable for private social credential storage');
  }
}

/** Read service-account credentials before a one-use OAuth code is requested. */
export function readSocialOAuthStorageCredentials(env = process.env, platform) {
  assertPlatform(platform);
  const credentials = readFirebaseServiceAccountCredentials(env, {
    purpose: 'store ' + platform + ' OAuth credentials privately',
  });
  assertServiceAccount(credentials);
  return credentials;
}

/**
 * Validate server-template write access before starting an interactive OAuth
 * flow. The unique parameter exists only in a validate_only request and is
 * never published.
 */
export async function validateSocialOAuthCredentialStorage({
  credentials,
  platform,
  updateConfig = updateRcTemplateWithEtag,
} = {}) {
  assertPlatform(platform);
  assertServiceAccount(credentials);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const probeName = 'SOCIAL_' + platform.replaceAll('-', '_').toUpperCase() + '_PREFLIGHT_' + suffix;
  const result = await updateConfig({
    credentials,
    namespace: RC_SERVER_NAMESPACE,
    validateOnly: true,
    versionDescription: 'validate ' + platform + ' private OAuth credential storage',
    stage: (template) => stageRcParamValue(
      template,
      probeName,
      'validate-only',
      'Transient validate-only authorization probe; never published.',
    ),
  });
  if (!result?.ok || result.validated !== true) {
    throw new Error('Private Remote Config write preflight failed for ' + platform + '; OAuth was not started');
  }
  return true;
}

function parameterIsGrouped(template, name) {
  return Object.entries(template?.parameterGroups ?? {}).some(([, group]) => (
    group?.parameters && Object.hasOwn(group.parameters, name)
  ));
}

/**
 * Store social OAuth credentials directly in the server Remote Config
 * namespace. Values are never returned, logged, or included in errors.
 */
export async function persistSocialOAuthCredentials({
  credentials,
  platform,
  parameters = {},
  removeParameters = [],
  updateConfig = updateRcTemplateWithEtag,
} = {}) {
  const allowed = assertPlatform(platform);
  assertServiceAccount(credentials);
  const entries = Object.entries(parameters);
  const removals = [...new Set(removeParameters)];
  if (entries.some(([name, value]) => (
    !allowed.has(name) || typeof value !== 'string' || !value.trim()
  ))) {
    throw new Error('Invalid private OAuth credential fields for ' + platform);
  }
  if (removals.some((name) => !allowed.has(name) || entries.some(([entryName]) => entryName === name))) {
    throw new Error('Invalid private OAuth credential removals for ' + platform);
  }

  const result = await updateConfig({
    credentials,
    namespace: RC_SERVER_NAMESPACE,
    versionDescription: 'store ' + platform + ' OAuth credentials',
    stage: (template) => {
      let next = template;
      let changed = false;
      for (const [name, value] of entries) {
        const staged = stageRcParamValue(
          next,
          name,
          value,
          'Private ' + platform + ' OAuth credential; managed by the authentication helper.',
        );
        if (staged.error) return staged;
        changed ||= staged.changed;
        if (staged.changed) next = staged.template;
      }
      if (removals.some((name) => parameterIsGrouped(next, name))) {
        return { changed: false, error: 'a requested private credential is inside a parameter group' };
      }
      const nextParameters = { ...(next.parameters ?? {}) };
      for (const name of removals) {
        if (Object.hasOwn(nextParameters, name)) {
          delete nextParameters[name];
          changed = true;
        }
      }
      return {
        changed,
        template: changed ? { ...next, parameters: nextParameters } : next,
      };
    },
  });
  if (!result?.ok) {
    throw new Error('Private Remote Config could not store ' + platform + ' OAuth credentials');
  }
  return {
    changed: result.changed === true,
    parameterCount: entries.length,
    removedParameterCount: removals.length,
  };
}
