#!/usr/bin/env node
/**
 * One-shot: flip ENABLE_HAIKU_ARTICLE_FALLBACK on in Firebase Remote Config
 * so `scripts/load-rc-env.mjs` hydrates it for every workflow, enabling the
 * `claude-cli/haiku` (always-current Haiku, via the CLI's own alias)
 * absolute-last-resort fallback in `scripts/lib/ai-models.mjs` (see
 * isClaudeCliFallbackEnabled()).
 *
 * Safe: the fallback is double-gated (RC flag AND CLAUDE_CODE_OAUTH_TOKEN
 * present in the job env — scripts/lib/ai-models.mjs:822), so workflows
 * without the token secret still skip it silently. This only activates the
 * fallback for jobs that already carry CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Auth:
 *   GOOGLE_APPLICATION_CREDENTIALS must point at a Firebase SA with the
 *   `Firebase Remote Config Admin` role.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-haiku-fallback-rc.mjs
 */

import { getRemoteConfig, fetchRcTemplate, stageRcParam, publishRcTemplate } from './lib/remote-config-admin.mjs';

const RC_PARAM = 'ENABLE_HAIKU_ARTICLE_FALLBACK';
const RC_VALUE = 'true';

function bail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    bail('GOOGLE_APPLICATION_CREDENTIALS not set.');
  }

  const rc = await getRemoteConfig();
  const template = await fetchRcTemplate(rc);

  const existing = template.parameters[RC_PARAM]?.defaultValue?.value;
  console.log(`ℹ️  Current ${RC_PARAM}: ${existing ?? '(unset)'}`);

  if (existing === RC_VALUE) {
    console.log('ℹ️  Already enabled. Nothing to publish.');
    return;
  }

  const staged = stageRcParam(template, RC_PARAM, RC_VALUE,
    `Enable claude-cli haiku last-resort AI fallback (set ${new Date().toISOString().slice(0, 10)})`);

  await publishRcTemplate(rc, template, staged ? 1 : 0);
  console.log(`✅ Published ${RC_PARAM}=${RC_VALUE} to Remote Config.`);
  console.log('   Next run of any workflow with CLAUDE_CODE_OAUTH_TOKEN wired will pick it up via load-rc-env.mjs.');
}

main().catch((err) => {
  console.error('❌ set-haiku-fallback-rc failed:', err?.message || err);
  process.exit(1);
});
