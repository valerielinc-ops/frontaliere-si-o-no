#!/usr/bin/env node
/**
 * Safely provision verified Facebook Page credentials into server-side
 * Firebase Remote Config. Secret values are read from the environment and
 * never accepted as command-line arguments or printed to output.
 *
 * Required environment: FB_SHORT_LIVED_USER_TOKEN, META_APP_ID, META_APP_SECRET,
 * GOOGLE_APPLICATION_CREDENTIALS. Set META_TARGET_PAGE_ID when the Meta user
 * manages more than one Page. Use a local secret manager to populate the
 * environment; do not put credential literals in shell commands/history.
 */
import { readFileSync } from 'node:fs';
import { fetchRcTemplate, getRemoteConfig } from './lib/remote-config-admin.mjs';
import { provisionFacebookPageCredentials } from './lib/facebook-token-setup.mjs';

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Provision verified Facebook Page credentials to Firebase Remote Config.');
    console.log('Supply required credential values through a local secret manager environment.');
    return;
  }
  if (process.argv.length > 2) throw new Error('Credential arguments are disabled; supply them through the environment');

  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required');
  let firebaseCredentials;
  try {
    firebaseCredentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
  } catch {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS could not be read as service-account JSON');
  }

  const clientTemplate = await fetchRcTemplate(await getRemoteConfig());
  const configuredPageId = String(
    clientTemplate.parameters?.FB_PAGE_ID?.defaultValue?.value || '',
  ).trim();
  const configuredInstagramId = String(
    clientTemplate.parameters?.INSTAGRAM_BUSINESS_ACCOUNT_ID?.defaultValue?.value || '',
  ).trim();

  const result = await provisionFacebookPageCredentials({
    shortLivedUserToken: requiredEnv('FB_SHORT_LIVED_USER_TOKEN'),
    appId: requiredEnv('META_APP_ID'),
    appSecret: requiredEnv('META_APP_SECRET'),
    targetPageId: process.env.META_TARGET_PAGE_ID || process.env.FB_PAGE_ID || configuredPageId,
    expectedInstagramAccountId: process.env.META_TARGET_INSTAGRAM_ACCOUNT_ID || configuredInstagramId,
    credentials: firebaseCredentials,
  });
  console.log(`Facebook Page ${result.pageId} credentials ${result.changed ? 'updated' : 'already current'} in the private Firebase server template.`);
  console.log(`Long-lived user token expires at ${result.userTokenExpiresAt}.`);
  console.log(`Page token expiry: ${result.pageTokenExpiresAt === '0' ? 'Meta reports no scheduled expiry' : result.pageTokenExpiresAt}.`);
  console.log(`Verified Instagram publisher credential configured: ${result.instagramPublisherConfigured ? 'yes' : 'no'}.`);
  console.log('No token values were written to output.');
}

main().catch((error) => {
  console.error(`Facebook token provisioning failed: ${error?.message || 'unknown error'}. No token values were written to output.`);
  process.exitCode = 1;
});
