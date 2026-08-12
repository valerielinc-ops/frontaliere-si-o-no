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
 * The `ac` autologin credential policy (#5685), read from Remote Config.
 *
 * THREE reasons this is Remote Config and not a constant:
 *
 *  1. It is the rollout switch. `NEWSLETTER_AC_SCHEME` stays `legacy` — an
 *     absent parameter yields '' here, which resolveAutologinPolicy reads as
 *     today's behaviour — until the Cloud Function carrying the v1 verifier is
 *     confirmed deployed. Senders and verifier deploy on different schedules,
 *     and minting a format the verifier does not know yet would sign everybody
 *     out.
 *  2. It is the rollback. Emptying the three parameters restores the
 *     never-expiring credential for every link in every inbox within one cache
 *     TTL (5 minutes) and WITHOUT a deploy — the only kind of rollback worth
 *     having when the failure mode is "subscribers cannot get in".
 *  3. The TTL is applied at verification time, so changing
 *     `NEWSLETTER_AC_TTL_DAYS` re-judges codes ALREADY SENT, in both
 *     directions. Nothing has to be re-minted to widen or narrow the window.
 *
 * Same parameter names scripts/load-rc-env.mjs bridges into process.env for the
 * senders, so the minting and verifying sides read one source of truth.
 *
 * @returns {Promise<{NEWSLETTER_AC_SCHEME: string, NEWSLETTER_AC_TTL_DAYS: string, NEWSLETTER_AC_LEGACY_SUNSET: string}>}
 *   env-shaped, to be handed straight to resolveAutologinPolicy()
 */
export async function getAutologinPolicyConfig() {
 const [scheme, ttlDays, legacySunset] = await Promise.all([
 getRemoteConfigValue('NEWSLETTER_AC_SCHEME'),
 getRemoteConfigValue('NEWSLETTER_AC_TTL_DAYS'),
 getRemoteConfigValue('NEWSLETTER_AC_LEGACY_SUNSET'),
 ]);
 return {
 NEWSLETTER_AC_SCHEME: scheme,
 NEWSLETTER_AC_TTL_DAYS: ttlDays,
 NEWSLETTER_AC_LEGACY_SUNSET: legacySunset,
 };
}

/**
 * The `token` action-credential policy (#5704), read from Remote Config.
 *
 * Same three reasons as getAutologinPolicyConfig above — rollout switch,
 * rollback without a deploy, and a TTL applied at verification time so it
 * re-judges tokens ALREADY SENT in both directions — with one difference worth
 * stating: here an ABSENT `NEWSLETTER_TOKEN_SCHEME` does not mean "legacy
 * everywhere". It means each scope takes its own default, and `confirm` defaults
 * to the dated v1 format because the confirmation email tells the recipient, in
 * four languages, that its link expires in 7 days. Shipping that switched off
 * would leave the sentence false, which is the half of #5704 that is a statement
 * to people who never asked to be subscribed.
 *
 * Rolling back is still one Remote Config edit: `NEWSLETTER_TOKEN_SCHEME=legacy`
 * mints exactly what was minted before #5704, and
 * `NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS=0` un-ages every confirm token already out.
 *
 * Same parameter names scripts/load-rc-env.mjs bridges into process.env for the
 * senders, so the minting and verifying sides read one source of truth.
 *
 * @returns {Promise<{NEWSLETTER_TOKEN_SCHEME: string, NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS: string, NEWSLETTER_TOKEN_LEGACY_SUNSET: string}>}
 *   env-shaped, to be handed straight to resolveNewsletterTokenPolicy()
 */
export async function getNewsletterTokenPolicyConfig() {
 const [scheme, confirmTtlDays, legacySunset] = await Promise.all([
   getRemoteConfigValue('NEWSLETTER_TOKEN_SCHEME'),
   getRemoteConfigValue('NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS'),
   getRemoteConfigValue('NEWSLETTER_TOKEN_LEGACY_SUNSET'),
 ]);
 return {
   NEWSLETTER_TOKEN_SCHEME: scheme,
   NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS: confirmTtlDays,
   NEWSLETTER_TOKEN_LEGACY_SUNSET: legacySunset,
 };
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
 'MAILEROO_API_KEY', 'MAILEROO_ACCOUNT_API_KEY',
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
