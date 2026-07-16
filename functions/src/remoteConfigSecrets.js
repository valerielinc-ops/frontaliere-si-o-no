/**
 * remoteConfigSecrets.js — Fetch secrets from Firebase Remote Config (server-side)
 *
 * Uses the Firebase Admin SDK to read Remote Config parameters.
 * This avoids needing Cloud Secret Manager — keys are stored in Remote Config
 * and protected by App Check on callable functions.
 *
 * Values are cached for 5 minutes to avoid excessive Remote Config reads.
 */

import { getRemoteConfig } from 'firebase-admin/remote-config';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedTemplate = null;
let cacheTimestamp = 0;

/**
 * Fetch a Remote Config parameter value by key.
 * Returns empty string if the key doesn't exist.
 */
export async function getRemoteConfigValue(key) {
 const now = Date.now();
 if (!cachedTemplate || now - cacheTimestamp > CACHE_TTL_MS) {
 const rc = getRemoteConfig();
 cachedTemplate = await rc.getTemplate();
 cacheTimestamp = now;
 }

 const param = cachedTemplate.parameters?.[key];
 if (!param) return '';

 // defaultValue can be { value: 'string' } or { useInAppDefault: true }
 const defaultVal = param.defaultValue;
 if (defaultVal && typeof defaultVal === 'object' && 'value' in defaultVal) {
 return String(defaultVal.value);
 }
 return '';
}

/**
 * Fetch all three newsletter secrets at once.
 * Returns { resendApiKey, resendWebhookSecret, newsletterSecret }.
 */
export async function getNewsletterSecrets() {
 const [resendApiKey, resendWebhookSecret, newsletterSecret] = await Promise.all([
 getRemoteConfigValue('RESEND_API_KEY'),
 getRemoteConfigValue('RESEND_WEBHOOK_SECRET'),
 getRemoteConfigValue('NEWSLETTER_SECRET'),
 ]);
 return { resendApiKey, resendWebhookSecret, newsletterSecret };
}

// Same Remote Config param names scripts/load-rc-env.mjs's RC_TO_ENV bridges
// into process.env for the scripts/ side (verified 2026-07-16 — confirms
// these RC params actually exist and are populated, since load-rc-env.mjs
// already successfully feeds the scripts/ cascade from them in CI).
const EMAIL_CASCADE_RC_KEYS = [
 'RESEND_API_KEY',
 'MAILJET_API_KEY', 'MAILJET_SECRET_KEY',
 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN',
 'MAILTRAP_API_TOKEN',
 'MAILEROO_API_KEY',
 'CLOUDFLARE_EMAIL_API_TOKEN', 'CF_ACCOUNT_ID',
];

/**
 * Mirror the email-cascade provider credentials from Remote Config into
 * process.env, so functions/src/emailCascade.js's synchronous process.env.*
 * reads (isProviderConfigured, sendVia*, fetch*DailyUsage) see the same
 * values the scripts/ side already gets via load-rc-env.mjs — Cloud
 * Functions fetch secrets async (Remote Config), the cascade module reads
 * them sync, so this bridge is the prerequisite for calling sendEmailCascade
 * from any functions/src/*.js file. Skips keys already set (env/secret
 * takes precedence) and is idempotent — safe to call before every send.
 */
export async function bridgeEmailCascadeCredentialsToEnv() {
 await Promise.all(EMAIL_CASCADE_RC_KEYS.map(async (key) => {
 if (process.env[key]) return;
 const value = await getRemoteConfigValue(key);
 if (value) process.env[key] = value;
 }));
}
