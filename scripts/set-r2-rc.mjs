#!/usr/bin/env node
/**
 * One-shot: publish public R2 bucket metadata to client Remote Config and the
 * S3 write credential pair to Firebase's private server template.
 *
 * The S3 credentials are derived from CF_API_TOKEN:
 *   Access Key ID     = the API token's id (from /user/tokens/verify)
 *   Secret Access Key = SHA-256(token value)
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS → Firebase service account.
 * Env:  CF_API_TOKEN, CF_ACCOUNT_ID (loaded via load-rc-env.mjs).
 */
import crypto from 'node:crypto';
import { readFirebaseServiceAccountCredentials } from './lib/firebase-service-account-credentials.mjs';
import {
  RC_SERVER_NAMESPACE,
  getRemoteConfig,
  fetchRcTemplate,
  stageRcParam,
  publishRcTemplate,
  stageRcParamValue,
  updateRcTemplateWithEtag,
} from './lib/remote-config-admin.mjs';

const token = process.env.CF_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET || 'frontaliere-cdn';
if (!token || !accountId) {
  console.error('❌ CF_API_TOKEN / CF_ACCOUNT_ID missing in env');
  process.exit(1);
}

const credentials = readFirebaseServiceAccountCredentials(process.env, {
  purpose: 'write R2 deploy credentials to private Remote Config',
});
if (!credentials?.project_id) {
  console.error('❌ Firebase service-account credentials missing; private R2 credentials were not written');
  process.exit(1);
}

const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
  headers: { Authorization: `Bearer ${token}` },
});
const verification = await response.json().catch(() => ({}));
if (!response.ok || !verification?.success || typeof verification?.result?.id !== 'string' || !verification.result.id) {
  console.error('❌ token verify failed');
  process.exit(1);
}

const accessKeyId = verification.result.id;
const secretAccessKey = crypto.createHash('sha256').update(token).digest('hex');
const today = new Date().toISOString().slice(0, 10);

const rc = await getRemoteConfig();
const clientTemplate = await fetchRcTemplate(rc);
const clientParams = {
  R2_ACCOUNT_ID: accountId,
  R2_BUCKET: bucket,
  R2_S3_ENDPOINT: `https://${accountId}.r2.cloudflarestorage.com`,
};
let clientChanged = 0;
for (const [name, value] of Object.entries(clientParams)) {
  if (stageRcParam(clientTemplate, name, value, `R2 CDN public bucket metadata (set ${today})`)) clientChanged += 1;
}
if (clientChanged) await publishRcTemplate(rc, clientTemplate, clientChanged);

const serverResult = await updateRcTemplateWithEtag({
  credentials,
  namespace: RC_SERVER_NAMESPACE,
  versionDescription: `Set private R2 CDN deploy credentials (${today})`,
  stage: (template) => {
    let next = template;
    let changed = false;
    for (const [name, value] of [
      ['SERVER_R2_ACCESS_KEY_ID', accessKeyId],
      ['SERVER_R2_SECRET_ACCESS_KEY', secretAccessKey],
    ]) {
      const staged = stageRcParamValue(next, name, value, 'Private R2 CDN write credential');
      if (staged.error) return staged;
      changed ||= staged.changed;
      if (staged.changed) next = staged.template;
    }
    return { changed, template: next };
  },
});
if (!serverResult?.ok) {
  console.error('❌ Private R2 credential write failed; sensitive values were not written to client Remote Config.');
  process.exit(1);
}

console.log(`✅ R2 public metadata updated (${clientChanged} changed); private deploy credentials ${serverResult.changed ? 'updated' : 'already current'}.`);
