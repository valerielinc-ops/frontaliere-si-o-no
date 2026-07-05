#!/usr/bin/env node
/**
 * ensure-cdn-fonts-redirect.mjs — idempotently ensure a Cloudflare Redirect
 * Rule that 301s cdn.frontaliereticino.ch/fonts/* to the apex, fixing GitHub
 * issue #3248 (real edge 404s on cdn.../fonts/space-grotesk-latin.woff2 and
 * .../inter-latin.woff2).
 *
 * Root cause investigated across 3 rounds (issue #3248 thread): a bug in
 * vite.config.ts renderBuiltUrl rebased font URLs onto the CDN domain for
 * ~37h between commit 2bbb82821ef (#1293) and the fix a065797074c (#1448,
 * merged 2026-06-05). Today's code always emits `/fonts/...` as same-origin
 * root-relative — fonts were never intentionally hosted on the CDN. The
 * residual 404s are clients still holding an absolute cdn…/fonts/... URL
 * baked into long-lived cached HTML from that ~37h window; no live repro was
 * ever captured, so the app-code bug can't be fixed twice — this recovers the
 * stale-cache tail at the edge instead, permanently, regardless of cause.
 *
 * cdn.frontaliereticino.ch IS Cloudflare-proxied (verified 2026-07-05 via the
 * zone's DNS record: CNAME → public.r2.dev, proxied: true — despite the
 * "DNS-only" comment that was in ensure-image-cdn-redirect.mjs), so this
 * Dynamic Redirect phase rule does run for CDN requests and will intercept
 * the /fonts/* path before the R2 bucket lookup 404s.
 *
 * Auth: CF_API_TOKEN needs Zone→Dynamic Redirect→Edit on the zone (hydrated
 * from Firebase Remote Config by scripts/load-rc-env.mjs). Idempotent: see
 * scripts/lib/cf-redirect-rules.mjs.
 *
 * Usage:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=… node scripts/load-rc-env.mjs)" \
 *     && node scripts/ensure-cdn-fonts-redirect.mjs
 *   node scripts/ensure-cdn-fonts-redirect.mjs --dry-run
 */
import { resolveZoneId, DEFAULT_ZONE_NAME } from './lib/cf-analytics.mjs';
import { REDIRECT_RULE_PHASE, ensureRedirectRule } from './lib/cf-redirect-rules.mjs';

const APEX_HOST = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME;
const APEX_BASE = `https://${APEX_HOST}`;
const CDN_HOST = `cdn.${APEX_HOST}`;
const RULE_DESCRIPTION = 'CDN fonts -> apex (issue #3248 404 recovery)';

// Host-scoped to the CDN subdomain only — this must never match the apex or
// www (that's the opposite direction of ensure-image-cdn-redirect.mjs; the two
// rules living side by side in the same phase would loop if either were
// missing its host guard).
const buildExpression = () =>
  `starts_with(http.request.uri.path, "/fonts/") and http.host eq "${CDN_HOST}"`;

const buildRule = () => ({
  action: 'redirect',
  action_parameters: {
    from_value: {
      target_url: { expression: `concat("${APEX_BASE}", http.request.uri.path)` },
      status_code: 301,
      preserve_query_string: false,
    },
  },
  expression: buildExpression(),
  description: RULE_DESCRIPTION,
  enabled: true,
});

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.error('❌ CF_API_TOKEN not set. Run `node scripts/load-rc-env.mjs` first (needs Dynamic Redirect→Edit).');
    process.exit(1);
  }
  const zoneId = await resolveZoneId(token, process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME, process.env.CF_ZONE_ID);

  await ensureRedirectRule(token, zoneId, buildRule(), { dryRun, phase: REDIRECT_RULE_PHASE });
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exit(1);
});
