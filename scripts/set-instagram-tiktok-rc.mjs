#!/usr/bin/env node
/**
 * One-shot: publish Instagram/TikTok profile identifiers to Firebase Remote
 * Config. Public account identifiers only — no access token yet for either
 * platform (Meta App Review / TikTok app audit still pending), so the poster
 * scripts stay unbuilt-until-authorized; this just records what the accounts
 * already are, the same way FB_PAGE_ID does for Facebook.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS → Firebase SA (Remote Config Admin).
 */
import { getRemoteConfig, fetchRcTemplate, stageRcParam, publishRcTemplate } from './lib/remote-config-admin.mjs';

const PARAMS = {
  INSTAGRAM_USERNAME: 'frontaliereticino',
  INSTAGRAM_BUSINESS_ACCOUNT_ID: '17841439417386982',
  TIKTOK_USERNAME: 'frontaliereticino',
};

const rc = await getRemoteConfig();
const template = await fetchRcTemplate(rc);

let changed = 0;
const today = new Date().toISOString().slice(0, 10);
const description = `Instagram/TikTok account identifiers, no access token yet (set ${today})`;
for (const [key, value] of Object.entries(PARAMS)) {
  if (stageRcParam(template, key, value, description)) changed++;
}
if (changed === 0) { console.log('ℹ️  All Instagram/TikTok params already up-to-date. Nothing to publish.'); process.exit(0); }
await publishRcTemplate(rc, template, changed);
console.log(`✅ Published ${changed} Instagram/TikTok param(s) to Remote Config.`);
