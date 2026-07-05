#!/usr/bin/env node
/**
 * ensure-image-cdn-redirect.mjs — idempotently ensure the Cloudflare Redirect
 * Rule that 301s the offloaded self-hosted image prefixes from the apex to the
 * dedicated CDN (cdn.frontaliereticino.ch).
 *
 * Why this exists (in-repo IaC, not a mystery dashboard click): the brand/logo
 * images are offloaded out of the GitHub Pages artifact to the CDN repo and
 * DELETED from dist (scripts/offload-generated-images-cdn.mjs). Our own outputs
 * already point at the CDN (services/cdnImageBase.ts cdnImageUrl, the offload
 * HTML rewrite, newsletter-content.mjs IMAGE_CDN_BASE), but EXTERNAL referrers
 * and Google-Images cache still hit the old apex `/images/{prefix}/…` paths and
 * 404 there (~1.1k hits/day measured via Cloudflare edge analytics, 2026-06-17).
 * A single edge Redirect Rule recovers them at zero dist cost (vs re-bloating
 * the artifact by keeping the files in dist).
 *
 * Free-plan note: the `matches` (regex) operator needs Business/WAF-Advanced, so
 * the expression uses `starts_with(...) or …` over each prefix — allowed on Free.
 * `/images/places/` is intentionally NOT redirected (stays same-origin, blog
 * hero places), matching CDN_OFFLOADED_IMAGE_PREFIXES in services/cdnImageBase.ts.
 *
 * Auth: CF_API_TOKEN needs Zone→Dynamic Redirect→Edit on the zone (hydrated from
 * Firebase Remote Config by scripts/load-rc-env.mjs). Idempotent: matches the
 * rule by its description and updates in place, else appends; never duplicates.
 *
 * Usage:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=… node scripts/load-rc-env.mjs)" \
 *     && node scripts/ensure-image-cdn-redirect.mjs
 *   node scripts/ensure-image-cdn-redirect.mjs --dry-run
 */

import { resolveZoneId, DEFAULT_ZONE_NAME } from './lib/cf-analytics.mjs';
import { REDIRECT_RULE_PHASE, ensureRedirectRule } from './lib/cf-redirect-rules.mjs';

const CDN_BASE = 'https://cdn.frontaliereticino.ch';

// The authoritative set is the offload script's deleted-from-dist TARGETS
// (scripts/offload-generated-images-cdn.mjs `TARGETS[].url`): EVERY prefix it
// pushes to the CDN and then removes from the artifact 404s on the apex for
// external referrers / Google-Images cache — exactly the class this rule
// recovers. That is a SUPERSET of CDN_OFFLOADED_IMAGE_PREFIXES in
// services/cdnImageBase.ts (the 7 image prefixes rewritten at SPA/HTML render
// time): it also includes `/og/` (per-job OG cards) and `/images/blog/thumbnails/`
// (blog 480w thumbnails, offloaded via getResponsiveImageSet, not cdnImageUrl).
// MUST stay in sync with that TARGETS list. `/images/places/` is deliberately
// excluded — it stays same-origin (blog hero places). Reviewer 🔴 on #2396.
const OFFLOADED_PREFIXES = [
  '/og/',
  '/images/blog/thumbnails/',
  '/images/brands/',
  '/images/insurers/',
  '/images/providers/',
  '/images/logos/',
  '/images/authors/',
  '/images/publisher/',
  '/images/events/',
];

const RULE_DESCRIPTION = 'Offloaded images -> CDN (apex 404 recovery)';

// Host-scoped to apex + www. The rule lives at zone level; without a host guard
// it would fire on every proxied hostname in the zone — including
// cdn.frontaliereticino.ch, which IS proxied (verified 2026-07-05, contrary to
// an earlier "DNS-only" assumption here; see ensure-cdn-fonts-redirect.mjs).
// Without the host guard the prefix match would fire there too, 301-ing
// cdn…/images/brands/x.png to itself → infinite loop.
// The host guard restricts the rule to apex and its www variant. www is included
// because external referrers and Google-Images cache can hold www.frontaliereticino.ch
// image URLs: if www→apex is a Page Rule it fires before this Dynamic Redirect
// phase and browsers follow it, but CDN/scraper fetches may not traverse the
// redirect chain and 404 instead. Covering www here recovers those at the edge
// with no extra hop for browsers. Follow-up #2420 (adversarial check on #2396).
const APEX_HOST = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME;
const buildExpression = () =>
  '(' + OFFLOADED_PREFIXES.map((p) => `starts_with(http.request.uri.path, "${p}")`).join(' or ') +
  `) and (http.host eq "${APEX_HOST}" or http.host eq "www.${APEX_HOST}")`;

const buildRule = () => ({
  action: 'redirect',
  action_parameters: {
    from_value: {
      target_url: { expression: `concat("${CDN_BASE}", http.request.uri.path)` },
      status_code: 301,
      preserve_query_string: true,
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
