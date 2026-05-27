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
