#!/usr/bin/env node
/**
 * One-time migration of social provider credentials from the downloadable
 * client Remote Config template to Firebase's separate `firebase-server`
 * template. Values are handled in memory only and never printed.
 *
 * Run after the server-template readers are deployed. The migration publishes
 * the private copy first, then removes every legacy client alias with ETag
 * protection. A conflict or unsupported conditional value fails closed.
 */
import { pathToFileURL } from 'node:url';
import { realpathSync, readFileSync } from 'node:fs';

import { fetchRcTemplate, getRemoteConfig, removeRcParamsWithEtag, updateRcTemplateWithEtag, stageRcParamValue, RC_SERVER_NAMESPACE } from './lib/remote-config-admin.mjs';

const SOCIAL_SECRET_ALIASES = [
  { sources: ['SERVER_META_CAPI_ACCESS_TOKEN'], target: 'SERVER_META_CAPI_ACCESS_TOKEN' },
  { sources: ['SERVER_FB_PAGE_ACCESS_TOKEN', 'FB_PAGE_ACCESS_TOKEN'], target: 'SERVER_FB_PAGE_ACCESS_TOKEN' },
  { sources: ['SERVER_FB_PAGE_ACCESS_TOKEN_EXPIRES_AT', 'FB_PAGE_ACCESS_TOKEN_EXPIRES_AT'], target: 'SERVER_FB_PAGE_ACCESS_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_FB_USER_ACCESS_TOKEN', 'FB_USER_ACCESS_TOKEN'], target: 'SERVER_FB_USER_ACCESS_TOKEN' },
  { sources: ['SERVER_FB_USER_ACCESS_TOKEN_EXPIRES_AT', 'FB_USER_ACCESS_TOKEN_EXPIRES_AT'], target: 'SERVER_FB_USER_ACCESS_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_ACCESS_TOKEN'], target: 'SERVER_INSTAGRAM_ACCESS_TOKEN' },
  { sources: ['SERVER_INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT', 'INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT'], target: 'SERVER_INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_LINKEDIN_POST_CLIENT_SECRET', 'LINKEDIN_POST_CLIENT_SECRET'], target: 'SERVER_LINKEDIN_POST_CLIENT_SECRET' },
  { sources: ['SERVER_LINKEDIN_POST_REFRESH_TOKEN', 'LINKEDIN_POST_REFRESH_TOKEN'], target: 'SERVER_LINKEDIN_POST_REFRESH_TOKEN' },
  { sources: ['SERVER_LINKEDIN_POST_ACCESS_TOKEN', 'LINKEDIN_POST_ACCESS_TOKEN'], target: 'SERVER_LINKEDIN_POST_ACCESS_TOKEN' },
  { sources: ['SERVER_LINKEDIN_MEMBER_CLIENT_SECRET', 'LINKEDIN_MEMBER_CLIENT_SECRET'], target: 'SERVER_LINKEDIN_MEMBER_CLIENT_SECRET' },
  { sources: ['SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN', 'LINKEDIN_MEMBER_ACCESS_TOKEN'], target: 'SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN' },
  { sources: ['SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT', 'LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT'], target: 'SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN', 'LINKEDIN_MEMBER_REFRESH_TOKEN'], target: 'SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN' },
  { sources: ['SERVER_REDDIT_CLIENT_SECRET', 'REDDIT_CLIENT_SECRET'], target: 'SERVER_REDDIT_CLIENT_SECRET' },
  { sources: ['SERVER_REDDIT_PASSWORD', 'REDDIT_PASSWORD'], target: 'SERVER_REDDIT_PASSWORD' },
  { sources: ['SERVER_REDDIT_REFRESH_TOKEN', 'REDDIT_REFRESH_TOKEN'], target: 'SERVER_REDDIT_REFRESH_TOKEN' },
  { sources: ['SERVER_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'], target: 'SERVER_TELEGRAM_BOT_TOKEN' },
  { sources: ['SERVER_TIKTOK_CLIENT_SECRET', 'TIKTOK_CLIENT_SECRET'], target: 'SERVER_TIKTOK_CLIENT_SECRET' },
  { sources: ['SERVER_TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_KEY'], target: 'SERVER_TIKTOK_CLIENT_KEY' },
  { sources: ['SERVER_TIKTOK_ACCESS_TOKEN', 'TIKTOK_ACCESS_TOKEN'], target: 'SERVER_TIKTOK_ACCESS_TOKEN' },
  { sources: ['SERVER_TIKTOK_ACCESS_TOKEN_EXPIRES_AT', 'TIKTOK_ACCESS_TOKEN_EXPIRES_AT'], target: 'SERVER_TIKTOK_ACCESS_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_TIKTOK_REFRESH_TOKEN', 'TIKTOK_REFRESH_TOKEN'], target: 'SERVER_TIKTOK_REFRESH_TOKEN' },
  { sources: ['SERVER_TIKTOK_REFRESH_TOKEN_EXPIRES_AT', 'TIKTOK_REFRESH_TOKEN_EXPIRES_AT'], target: 'SERVER_TIKTOK_REFRESH_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_TIKTOK_SANDBOX_CLIENT_KEY', 'TIKTOK_SANDBOX_CLIENT_KEY'], target: 'SERVER_TIKTOK_SANDBOX_CLIENT_KEY' },
  { sources: ['SERVER_TIKTOK_SANDBOX_CLIENT_SECRET', 'TIKTOK_SANDBOX_CLIENT_SECRET'], target: 'SERVER_TIKTOK_SANDBOX_CLIENT_SECRET' },
  { sources: ['SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN', 'TIKTOK_SANDBOX_ACCESS_TOKEN'], target: 'SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN' },
  { sources: ['SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN_EXPIRES_AT', 'TIKTOK_SANDBOX_ACCESS_TOKEN_EXPIRES_AT'], target: 'SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN', 'TIKTOK_SANDBOX_REFRESH_TOKEN'], target: 'SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN' },
  { sources: ['SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN_EXPIRES_AT', 'TIKTOK_SANDBOX_REFRESH_TOKEN_EXPIRES_AT'], target: 'SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN_EXPIRES_AT' },
];

function explicitDefaultValue(parameter, key) {
  if (!parameter) return null;
  if (parameter.conditionalValues && Object.keys(parameter.conditionalValues).length) {
    throw new Error(`conditional client value is ambiguous for ${key}`);
  }
  const value = parameter.defaultValue?.value;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`unsupported client value type for ${key}`);
  return value;
}

/** The returned credential values are for internal use by the migration only. */
export function planSocialSecretMigration(clientTemplate) {
  const parameters = clientTemplate?.parameters ?? {};
  const targetValues = {};
  const removeClientKeys = new Set();
  for (const { sources, target } of SOCIAL_SECRET_ALIASES) {
    const candidates = [];
    for (const source of sources) {
      if (!Object.hasOwn(parameters, source)) continue;
      removeClientKeys.add(source);
      const value = explicitDefaultValue(parameters[source], source);
      if (value !== null) candidates.push({ source, value, description: parameters[source]?.description || '' });
    }
    const distinct = new Set(candidates.map(({ value }) => value));
    if (distinct.size > 1) {
      throw new Error(`conflicting client aliases for ${target}; resolve the source before migration`);
    }
    if (candidates.length) {
      targetValues[target] = candidates[0].value;
    }
  }
  return { targetValues, removeClientKeys: [...removeClientKeys] };
}

export async function migrateSocialSecrets({
  credentials,
  clientTemplate,
  updateConfig = updateRcTemplateWithEtag,
  removeClientConfig = removeRcParamsWithEtag,
} = {}) {
  if (!credentials?.client_email || !credentials?.private_key || !credentials?.project_id) {
    throw new Error('Firebase service-account JSON is incomplete');
  }
  const plan = planSocialSecretMigration(clientTemplate);
  const values = Object.entries(plan.targetValues);

  if (values.length) {
    const serverUpdate = await updateConfig({
      credentials,
      namespace: RC_SERVER_NAMESPACE,
      versionDescription: 'Move social provider credentials to private server Remote Config',
      stage: (template) => {
        let next = template;
        let changed = false;
        for (const [name, value] of values) {
          const existing = next?.parameters?.[name]?.defaultValue?.value;
          if (typeof existing === 'string' && existing !== value) {
            return { changed: false, error: `private server parameter ${name} already differs; resolve the active credential before migration` };
          }
          const staged = stageRcParamValue(next, name, value, 'Private social provider credential');
          if (staged.error) return staged;
          changed ||= staged.changed;
          if (staged.changed) next = staged.template;
        }
        return { changed, template: next };
      },
    });
    if (!serverUpdate?.ok) {
      throw new Error(`Private server-template write failed${serverUpdate?.detail ? ` (${serverUpdate.detail})` : ''}; client values were not removed`);
    }
  }

  const clientCleanup = await removeClientConfig({
    credentials,
    namespace: 'firebase',
    names: plan.removeClientKeys,
    versionDescription: 'Remove social provider credentials from client Remote Config',
  });
  if (!clientCleanup?.ok) {
    throw new Error(`Private copy completed, but client-template cleanup failed${clientCleanup?.detail ? ` (${clientCleanup.detail})` : ''}`);
  }
  return {
    movedParameterCount: values.length,
    removedClientParameterCount: plan.removeClientKeys.length,
    changed: Boolean(values.length || clientCleanup.changed),
  };
}

async function main() {
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required');
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
  } catch {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS could not be read as service-account JSON');
  }
  const clientTemplate = await fetchRcTemplate(await getRemoteConfig());
  const result = await migrateSocialSecrets({ credentials, clientTemplate });
  console.log(`Social credential migration complete: ${result.movedParameterCount} parameter(s) copied to the private server template; ${result.removedClientParameterCount} client parameter(s) removed. No values were printed.`);
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
    console.error(`Social credential migration failed: ${error?.message || 'unknown error'}. No values were printed.`);
    process.exitCode = 1;
  });
}
