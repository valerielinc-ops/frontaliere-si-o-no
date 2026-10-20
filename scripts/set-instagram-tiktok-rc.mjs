#!/usr/bin/env node
/**
 * One-shot: publish Instagram/TikTok profile identifiers to Firebase Remote
 * Config. Public account identifiers only. The browser robot publishes
 * through the owner's authenticated Chrome profile; API access tokens remain
 * optional and are not needed for that route.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS → Firebase SA (Remote Config Admin).
 */
import { getRemoteConfig, fetchRcTemplate, stageRcParam, publishRcTemplate } from './lib/remote-config-admin.mjs';

const PARAMS = {
  INSTAGRAM_USERNAME: 'frontaliereticino',
  INSTAGRAM_BUSINESS_ACCOUNT_ID: '17841439417386982',
  TIKTOK_USERNAME: 'frontaliereticino',
  // Firebase controls the native TikTok sound experiment. `trend` selects
  // TikTok Studio's own "Per te" library; 50% keeps a no-sound control arm.
  TIKTOK_MUSIC_MODE: 'trend',
  TIKTOK_MUSIC_ROLLOUT_PERCENT: '50',
  // The video experiment keeps the existing slide render as control and
  // assigns half of new queue ids to the animated motion-graphic treatment.
  TIKTOK_VIDEO_CREATIVE_MODE: 'motion',
  TIKTOK_VIDEO_CREATIVE_ROLLOUT_PERCENT: '50',
};

const rc = await getRemoteConfig();
const template = await fetchRcTemplate(rc);

let changed = 0;
const today = new Date().toISOString().slice(0, 10);
const description = `Instagram/TikTok browser publishing and native-sound experiment settings (set ${today})`;
for (const [key, value] of Object.entries(PARAMS)) {
  if (stageRcParam(template, key, value, description)) changed++;
}
if (changed === 0) { console.log('ℹ️  All Instagram/TikTok params already up-to-date. Nothing to publish.'); process.exit(0); }
await publishRcTemplate(rc, template, changed);
console.log(`✅ Published ${changed} Instagram/TikTok param(s) to Remote Config.`);
