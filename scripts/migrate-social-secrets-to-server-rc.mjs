#!/usr/bin/env node
/**
 * Migrate confidential Remote Config values from the downloadable client
 * template to Firebase's separate `firebase-server` template. Values are
 * handled in memory only and never printed.
 *
 * `--copy-only` pre-stages private values before deployment while preserving
 * live client readers. The default mode is for after server-template readers
 * are deployed: publish the private copy first, then remove legacy client
 * aliases with ETag protection. Conflicts and conditional values fail closed.
 */
import { pathToFileURL } from 'node:url';
import { realpathSync, readFileSync } from 'node:fs';

import { fetchRcTemplate, getRemoteConfig, removeRcParamsWithEtag, updateRcTemplateWithEtag, stageRcParamValue, RC_SERVER_NAMESPACE } from './lib/remote-config-admin.mjs';

const PRIVATE_SECRET_ALIASES = [
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
  { sources: ['SERVER_LINKEDIN_MEMBER_URN', 'LINKEDIN_MEMBER_URN'], target: 'SERVER_LINKEDIN_MEMBER_URN' },
  { sources: ['SERVER_LINKEDIN_SIGNIN_CLIENT_SECRET', 'LINKEDIN_SIGNIN_CLIENT_SECRET'], target: 'SERVER_LINKEDIN_SIGNIN_CLIENT_SECRET' },
  { sources: ['SERVER_LINKEDIN_SIGNIN_ACCESS_TOKEN', 'LINKEDIN_SIGNIN_ACCESS_TOKEN'], target: 'SERVER_LINKEDIN_SIGNIN_ACCESS_TOKEN' },
  { sources: ['SERVER_LINKEDIN_SIGNIN_REFRESH_TOKEN', 'LINKEDIN_SIGNIN_REFRESH_TOKEN'], target: 'SERVER_LINKEDIN_SIGNIN_REFRESH_TOKEN' },
  { sources: ['SERVER_R2_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID'], target: 'SERVER_R2_ACCESS_KEY_ID' },
  { sources: ['SERVER_R2_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY'], target: 'SERVER_R2_SECRET_ACCESS_KEY' },
  { sources: ['SERVER_REDDIT_CLIENT_SECRET', 'REDDIT_CLIENT_SECRET'], target: 'SERVER_REDDIT_CLIENT_SECRET' },
  { sources: ['SERVER_REDDIT_PASSWORD', 'REDDIT_PASSWORD'], target: 'SERVER_REDDIT_PASSWORD' },
  { sources: ['SERVER_REDDIT_REFRESH_TOKEN', 'REDDIT_REFRESH_TOKEN'], target: 'SERVER_REDDIT_REFRESH_TOKEN' },
  { sources: ['SERVER_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'], target: 'SERVER_TELEGRAM_BOT_TOKEN' },
  { sources: ['SERVER_TIKTOK_CLIENT_SECRET', 'TIKTOK_CLIENT_SECRET'], target: 'SERVER_TIKTOK_CLIENT_SECRET' },
  { sources: ['SERVER_TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_KEY'], target: 'SERVER_TIKTOK_CLIENT_KEY' },
  { sources: ['SERVER_TIKTOK_ACCESS_TOKEN', 'TIKTOK_ACCESS_TOKEN'], target: 'SERVER_TIKTOK_ACCESS_TOKEN' },
  { sources: ['SERVER_TIKTOK_ACCESS_TOKEN_EXPIRES_AT', 'TIKTOK_ACCESS_TOKEN_EXPIRES_AT'], target: 'SERVER_TIKTOK_ACCESS_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_TIKTOK_OPEN_ID', 'TIKTOK_OPEN_ID'], target: 'SERVER_TIKTOK_OPEN_ID' },
  { sources: ['SERVER_TIKTOK_REFRESH_TOKEN', 'TIKTOK_REFRESH_TOKEN'], target: 'SERVER_TIKTOK_REFRESH_TOKEN' },
  { sources: ['SERVER_TIKTOK_REFRESH_TOKEN_EXPIRES_AT', 'TIKTOK_REFRESH_TOKEN_EXPIRES_AT'], target: 'SERVER_TIKTOK_REFRESH_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_TIKTOK_SANDBOX_CLIENT_KEY', 'TIKTOK_SANDBOX_CLIENT_KEY'], target: 'SERVER_TIKTOK_SANDBOX_CLIENT_KEY' },
  { sources: ['SERVER_TIKTOK_SANDBOX_CLIENT_SECRET', 'TIKTOK_SANDBOX_CLIENT_SECRET'], target: 'SERVER_TIKTOK_SANDBOX_CLIENT_SECRET' },
  { sources: ['SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN', 'TIKTOK_SANDBOX_ACCESS_TOKEN'], target: 'SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN' },
  { sources: ['SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN_EXPIRES_AT', 'TIKTOK_SANDBOX_ACCESS_TOKEN_EXPIRES_AT'], target: 'SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_TIKTOK_SANDBOX_OPEN_ID', 'TIKTOK_SANDBOX_OPEN_ID'], target: 'SERVER_TIKTOK_SANDBOX_OPEN_ID' },
  { sources: ['SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN', 'TIKTOK_SANDBOX_REFRESH_TOKEN'], target: 'SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN' },
  { sources: ['SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN_EXPIRES_AT', 'TIKTOK_SANDBOX_REFRESH_TOKEN_EXPIRES_AT'], target: 'SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN_EXPIRES_AT' },
  { sources: ['SERVER_ASSISTED_APPLICATION_RUN_KEY', 'ASSISTED_APPLICATION_RUN_KEY'], target: 'SERVER_ASSISTED_APPLICATION_RUN_KEY' },
  { sources: ['SERVER_CODEX_AUTH_JSON', 'CODEX_AUTH_JSON'], target: 'SERVER_CODEX_AUTH_JSON' },
  { sources: ['SERVER_EVENT_DESCRIPTION_ARTIFACT_KEY', 'EVENT_DESCRIPTION_ARTIFACT_KEY'], target: 'SERVER_EVENT_DESCRIPTION_ARTIFACT_KEY' },
  { sources: ['SERVER_PAGESPEED_API_KEY', 'PAGESPEED_API_KEY'], target: 'SERVER_PAGESPEED_API_KEY' },
  { sources: ['SERVER_ADSENSE_CLIENT_ID', 'ADSENSE_CLIENT_ID'], target: 'SERVER_ADSENSE_CLIENT_ID' },
  { sources: ['SERVER_ADSENSE_CLIENT_SECRET', 'ADSENSE_CLIENT_SECRET'], target: 'SERVER_ADSENSE_CLIENT_SECRET' },
  { sources: ['SERVER_ADSENSE_REFRESH_TOKEN', 'ADSENSE_REFRESH_TOKEN'], target: 'SERVER_ADSENSE_REFRESH_TOKEN' },
  { sources: ['SERVER_GSC_CLIENT_SECRET', 'GSC_CLIENT_SECRET'], target: 'SERVER_GSC_CLIENT_SECRET' },
  { sources: ['SERVER_GSC_REFRESH_TOKEN', 'GSC_REFRESH_TOKEN'], target: 'SERVER_GSC_REFRESH_TOKEN' },
  { sources: ['SERVER_CHUTES_API_KEY', 'CHUTES_API_KEY'], target: 'SERVER_CHUTES_API_KEY' },
  { sources: ['SERVER_ZAI_API_KEY', 'ZAI_API_KEY', 'ZHIPU_API_KEY'], target: 'SERVER_ZAI_API_KEY' },
  { sources: ['SERVER_MAILEROO_API_KEY', 'MAILEROO_API_KEY'], target: 'SERVER_MAILEROO_API_KEY' },
  { sources: ['SERVER_MAILEROO_TRANSACTIONAL_API_KEY', 'MAILEROO_TRANSACTIONAL_API_KEY'], target: 'SERVER_MAILEROO_TRANSACTIONAL_API_KEY' },
  { sources: ['SERVER_MAILEROO_NEWSLETTER_API_KEY', 'MAILEROO_NEWSLETTER_API_KEY'], target: 'SERVER_MAILEROO_NEWSLETTER_API_KEY' },
  { sources: ['SERVER_MAILEROO_WEBHOOK_SECRET', 'MAILEROO_WEBHOOK_SECRET'], target: 'SERVER_MAILEROO_WEBHOOK_SECRET' },
  { sources: ['SERVER_MAILEROO_EMAIL_TESTING_API_KEY', 'MAILEROO_EMAIL_TESTING_API_KEY'], target: 'SERVER_MAILEROO_EMAIL_TESTING_API_KEY' },
  { sources: ['SERVER_MAILEROO_ACCOUNT_API_KEY', 'MAILEROO_ACCOUNT_API_KEY'], target: 'SERVER_MAILEROO_ACCOUNT_API_KEY' },
  { sources: ['SERVER_OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN', 'OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN'], target: 'SERVER_OPENTRANSPORTDATA_ASTRA_SITUATION_TOKEN' },
  { sources: ['SERVER_OPENTRANSPORTDATA_ASTRA_LSA_TOKEN', 'OPENTRANSPORTDATA_ASTRA_LSA_TOKEN', 'OPENTRANSPORTDATA_API_KEY'], target: 'SERVER_OPENTRANSPORTDATA_ASTRA_LSA_TOKEN' },
  { sources: ['SERVER_OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN', 'OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN'], target: 'SERVER_OPENTRANSPORTDATA_ASTRA_COUNTERS_TOKEN' },
  { sources: ['SERVER_STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY'], target: 'SERVER_STRIPE_SECRET_KEY' },
  { sources: ['SERVER_STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET'], target: 'SERVER_STRIPE_WEBHOOK_SECRET' },
  { sources: ['SERVER_OMNIROUTE_PROVIDERS_JSON', 'OMNIROUTE_PROVIDERS_JSON'], target: 'SERVER_OMNIROUTE_PROVIDERS_JSON' },
  { sources: ['SERVER_POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PERSONAL_API_KEY'], target: 'SERVER_POSTHOG_PERSONAL_API_KEY' },
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

function privateServerValue(target, value) {
  if (target !== 'SERVER_CODEX_AUTH_JSON') return value;
  let login;
  try {
    login = JSON.parse(value);
  } catch {
    throw new Error('Codex auth JSON is malformed; refresh its dedicated source before migration');
  }
  if (!login || typeof login !== 'object' || Array.isArray(login)) {
    throw new Error('Codex auth JSON has an unsupported shape; refresh its dedicated source before migration');
  }
  delete login.refresh_token;
  if (login.tokens && typeof login.tokens === 'object' && !Array.isArray(login.tokens)) {
    delete login.tokens.refresh_token;
  }
  return JSON.stringify(login);
}

/** The returned credential values are for internal use by the migration only. */
export function planPrivateSecretMigration(clientTemplate) {
  const parameters = clientTemplate?.parameters ?? {};
  const targetValues = {};
  const removeClientKeys = new Set();
  for (const { sources, target } of PRIVATE_SECRET_ALIASES) {
    const candidates = [];
    for (const source of sources) {
      if (!Object.hasOwn(parameters, source)) continue;
      removeClientKeys.add(source);
      const value = explicitDefaultValue(parameters[source], source);
      if (value !== null) candidates.push({
        source,
        value: privateServerValue(target, value),
        description: parameters[source]?.description || '',
      });
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

// Compatibility exports for the existing scoped migration tests/callers.
export const planSocialSecretMigration = planPrivateSecretMigration;

export async function migratePrivateSecrets({
  credentials,
  clientTemplate,
  updateConfig = updateRcTemplateWithEtag,
  removeClientConfig = removeRcParamsWithEtag,
  copyOnly = false,
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
      versionDescription: 'Move private credentials to private server Remote Config',
      stage: (template) => {
        let next = template;
        let changed = false;
        for (const [name, value] of values) {
          const existing = next?.parameters?.[name]?.defaultValue?.value;
          if (typeof existing === 'string' && existing !== value) {
          return { changed: false, error: `private server parameter ${name} already differs; resolve the active credential before migration` };
          }
          const staged = stageRcParamValue(next, name, value, 'Private server credential');
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

  let clientCleanup = { ok: true, changed: false };
  if (!copyOnly && plan.removeClientKeys.length) {
    clientCleanup = await removeClientConfig({
      credentials,
      namespace: 'firebase',
      names: plan.removeClientKeys,
      versionDescription: 'Remove confidential parameters from client Remote Config',
    });
    if (!clientCleanup?.ok) {
      throw new Error(`Private copy completed, but client-template cleanup failed${clientCleanup?.detail ? ` (${clientCleanup.detail})` : ''}`);
    }
  }
  return {
    movedParameterCount: values.length,
    removedClientParameterCount: copyOnly ? 0 : plan.removeClientKeys.length,
    copyOnly,
    changed: Boolean(values.length || clientCleanup.changed),
  };
}

export const migrateSocialSecrets = migratePrivateSecrets;

function migrationMode(argv) {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  if (flags.some((flag) => flag !== '--copy-only') || flags.length > 1) {
    throw new Error('usage: migrate-social-secrets-to-server-rc.mjs [--copy-only]');
  }
  return { copyOnly: flags.includes('--copy-only') };
}

async function main() {
  const { copyOnly } = migrationMode(process.argv.slice(2));
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required');
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
  } catch {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS could not be read as service-account JSON');
  }
  const clientTemplate = await fetchRcTemplate(await getRemoteConfig());
  const result = await migratePrivateSecrets({ credentials, clientTemplate, copyOnly });
  const action = copyOnly ? 'pre-staged' : 'migrated';
  console.log(`Private credential migration ${action}: ${result.movedParameterCount} parameter(s) copied to the private server template; ${result.removedClientParameterCount} client parameter(s) removed. No values were printed.`);
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
    console.error(`Private credential migration failed: ${error?.message || 'unknown error'}. No values were printed.`);
    process.exitCode = 1;
  });
}
