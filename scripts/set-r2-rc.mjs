#!/usr/bin/env node
/**
 * One-shot: publish R2 (Cloudflare) S3 deploy credentials to Firebase Remote
 * Config so scripts/load-rc-env.mjs can hydrate them in CI for the CDN deploy.
 *
 * The S3 credentials are DERIVED from the existing CF_API_TOKEN (already in RC):
 *   Access Key ID     = the API token's id  (from /user/tokens/verify)
 *   Secret Access Key = SHA-256(token value)   ← documented R2 S3 derivation
 * So no new secret is invented; rotating CF_API_TOKEN → just re-run this script.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS → Firebase SA (Remote Config Admin).
 * Env:  CF_API_TOKEN, CF_ACCOUNT_ID (loaded via load-rc-env.mjs).
 */
import crypto from 'node:crypto';

const T = process.env.CF_API_TOKEN;
const A = process.env.CF_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET || 'frontaliere-cdn';
if (!T || !A) { console.error('❌ CF_API_TOKEN / CF_ACCOUNT_ID missing in env'); process.exit(1); }

// derive S3 creds
const verify = await (await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify',
  { headers: { Authorization: `Bearer ${T}` } })).json();
if (!verify?.success) { console.error('❌ token verify failed'); process.exit(1); }
const accessKeyId = verify.result.id;
const secretAccessKey = crypto.createHash('sha256').update(T).digest('hex');

const PARAMS = {
  R2_ACCOUNT_ID: A,
  R2_BUCKET: BUCKET,
  R2_S3_ENDPOINT: `https://${A}.r2.cloudflarestorage.com`,
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
};

const adminMod = await import('firebase-admin');
const admin = adminMod.default || adminMod;
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
const rc = admin.remoteConfig();
const template = await rc.getTemplate();

let changed = 0;
const today = new Date().toISOString().slice(0, 10);
for (const [key, value] of Object.entries(PARAMS)) {
  const cur = template.parameters[key]?.defaultValue?.value;
  if (cur === value) continue;
  template.parameters[key] = {
    defaultValue: { value },
    valueType: 'STRING',
    description: `R2 CDN S3 deploy credential (derived from CF_API_TOKEN; set ${today})`,
  };
  changed++;
}
if (changed === 0) { console.log('ℹ️  All R2_* params already up-to-date. Nothing to publish.'); process.exit(0); }
await rc.publishTemplate(template, { force: true });
console.log(`✅ Published ${changed} R2_* param(s) to Remote Config (accessKeyId tail ...${accessKeyId.slice(-6)}).`);
