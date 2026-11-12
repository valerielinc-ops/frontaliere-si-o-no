#!/usr/bin/env node
/**
 * One-shot: publish Instagram/TikTok browser-publishing settings and profile
 * identifiers to Firebase Remote Config. Account identifiers are public.
 * Owner-approved content publishing stays separate from Community/Insights;
 * this does not approve either platform's publishing API.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS → Firebase SA (Remote Config Admin).
 */
import { getRemoteConfig, fetchRcTemplate, stageRcParam, publishRcTemplate } from './lib/remote-config-admin.mjs';

const PARAMS = {
  SOCIAL_ROBOT_PUBLISHING_MODE: 'live',
  SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED: 'true',
  SOCIAL_ROBOT_TIKTOK_BROWSER_PUBLISHING_OWNER_APPROVED: 'true',
  INSTAGRAM_USERNAME: 'frontaliereticino',
  INSTAGRAM_BUSINESS_ACCOUNT_ID: '17841439417386982',
  // Four-arm test: control plus three high-contrast surfaces. Assignment is
  // deterministic per scheduled kind/period and the renderer keeps the same
  // safe-area layout across all arms.
  INSTAGRAM_CAROUSEL_BACKGROUND_AB_ENABLED: 'true',
  INSTAGRAM_CAROUSEL_BACKGROUND_AB_ROLLOUT_PERCENT: '100',
  INSTAGRAM_CAROUSEL_BACKGROUND_AB_VARIANTS: '["navy-gradient","paper-amber","mint-ink","coral-night"]',
  INSTAGRAM_CAROUSEL_BACKGROUND_AB_EXPLORATION_PERCENT: '20',
  // Select the Chrome Professional Dashboard as the Insights source. Actual
  // browser collection stays disabled until META_INSTAGRAM_BROWSER_INSIGHTS_APPROVED
  // is explicitly provisioned after verifying Meta permission; this selector
  // does not grant that permission. Graph remains a separate API route.
  SOCIAL_ROBOT_INSIGHTS_SOURCE: 'browser',
  INSTAGRAM_INSIGHTS_WINDOWS: '[24,72]',
  INSTAGRAM_INSIGHTS_DECISION_WINDOW_HOURS: '72',
  // Legacy winner maps stay quarantined in code until the preregistered
  // statistical promotion protocol is implemented and marks a map qualified.
  INSTAGRAM_INSIGHTS_AUTONOMOUS_DECISIONS_ENABLED: 'true',
  INSTAGRAM_INSIGHTS_MIN_OBSERVATIONS: '3',
  INSTAGRAM_INSIGHTS_MIN_RELATIVE_LIFT: '0.15',
  INSTAGRAM_INSIGHTS_MIN_ABSOLUTE_LIFT: '0.005',
  INSTAGRAM_AUTONOMOUS_EXPLORATION_PERCENT: '20',
  TIKTOK_USERNAME: 'frontaliereticino',
  // Firebase controls the native TikTok sound experiment. `trend` selects
  // TikTok Studio's own "Per te" library; 50% keeps a no-sound control arm.
  TIKTOK_MUSIC_MODE: 'trend',
  TIKTOK_MUSIC_ROLLOUT_PERCENT: '50',
  // The video experiment keeps the existing slide render as control. The
  // recommended 40% treatment pool yields roughly 60% control, 20% motion
  // graphic and 10% each for the quick-hook and single-stat formats.
  TIKTOK_VIDEO_CREATIVE_MODE: 'experiment',
  TIKTOK_VIDEO_CREATIVE_ROLLOUT_PERCENT: '40',
  TIKTOK_VIDEO_CREATIVE_NEW_FORMAT_ROLLOUT_PERCENT: '50',
  TIKTOK_ANSWER_FORMAT_ROLLOUT_PERCENT: '80',
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
