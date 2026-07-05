#!/usr/bin/env node
/**
 * cf-purge-cache.mjs — purge the Cloudflare edge cache after a deploy.
 *
 * WHY this exists: the apex HTML cache rule (it-apex-html-cache, managed by
 * cf-locale-failover-setup.mjs) makes extensionless 200 pages ELIGIBLE for
 * the edge cache with a long Edge TTL (override_origin 24h). GitHub Pages
 * does NOT notify Cloudflare when a deploy republishes content, so without
 * an explicit purge the edge would keep serving the PREVIOUS build's HTML
 * for up to the Edge TTL. This script clears the zone cache so the next
 * request re-fetches the freshly-deployed origin content.
 *
 * WHEN to run: ONLY after the new build is confirmed LIVE at origin
 * (post-deploy-validate-live → "Wait for Pages propagation"). Purging BEFORE
 * propagation would re-cache the OLD content (Pages still serving the prior
 * build) and defeat the purpose. The validate-live wiring gates this on the
 * propagation step succeeding.
 *
 * SCOPE: purge_everything. The site deploys as a whole (every HTML page can
 * change per build), and the free plan's granular purge is capped at 30 URLs
 * — far below the page count — so a full purge is the correct primitive.
 * It also clears the locale-shard failover entries (they simply re-warm).
 * cdn.frontaliereticino.ch IS Cloudflare-proxied (verified 2026-07-05 via the
 * zone's DNS record, proxied: true — an earlier "DNS-only/Fastly" assumption
 * here was stale; see scripts/ensure-cdn-fonts-redirect.mjs), so this same
 * purge_everything call ALSO clears any edge-cached response for cdn.* (e.g.
 * the /fonts/* redirect from issue #3248). Desired, not a scope gap: one
 * zone, one purge covers both hostnames.
 *
 * Auth: CF_API_TOKEN — needs Zone→Cache Purge. Resolves zone by name unless
 * CF_ZONE_ID is set. Hydrate locally via:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs)" && node scripts/cf-purge-cache.mjs
 *
 * Exit: 0 = purged (or no-op when CF_API_TOKEN absent — non-fatal so a
 * missing secret never fails the deploy), 1 = API/auth error.
 */

const REST_BASE = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = process.env.CF_ZONE_NAME || 'frontaliereticino.ch';
const token = process.env.CF_API_TOKEN;

// Non-fatal when the secret is absent: callers wire this with
// continue-on-error, but a clean exit 0 keeps logs quiet on env-less runs.
if (!token) {
  console.warn('⚠️  CF_API_TOKEN not set — skipping Cloudflare cache purge (non-fatal).');
  process.exit(0);
}

// Surface a purge failure in the GitHub Actions run UI. The validate-live step
// (post-deploy-validate-live.yml) wires this with `continue-on-error: true` —
// a purge hiccup must not fail the deploy — but that ALSO swallows the non-zero
// exit, so without an explicit annotation the failure is invisible in the run
// summary: a revoked/mis-scoped token or a persistent CF API error would leave
// the edge serving stale HTML for up to the 24h Edge TTL with NO active signal
// (it would only surface by reading the validate-live logs). Crawlers that
// ignore the short browser max-age=600 could index that stale HTML → SEO drift
// for the whole window. A `::warning::` line on stdout is rendered as a run
// annotation even under continue-on-error, making the failure visible without
// making the deploy fatal (the intentional design). See issue #2067.
function warnStaleEdge(reason) {
  console.log(
    `::warning title=Cloudflare cache purge failed::${reason} — edge may serve STALE HTML for up to 24h (Edge TTL) until the next deploy purges it. Re-run the purge or check CF_API_TOKEN scope (Zone→Cache Purge).`,
  );
}

async function cf(method, path, body) {
  const res = await fetch(`${REST_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function resolveZoneId() {
  if (process.env.CF_ZONE_ID) return process.env.CF_ZONE_ID;
  const { json } = await cf('GET', `/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!json?.success || !json.result?.length) {
    console.error(`❌ Cannot resolve zone id for ${ZONE_NAME} (token scope?).`);
    warnStaleEdge(`could not resolve zone id for ${ZONE_NAME} (token scope?)`);
    process.exit(1);
  }
  return json.result[0].id;
}

try {
  const zoneId = await resolveZoneId();
  const { json } = await cf('POST', `/zones/${zoneId}/purge_cache`, { purge_everything: true });
  if (!json?.success) {
    console.error(`❌ purge_everything failed: ${JSON.stringify(json?.errors)}`);
    warnStaleEdge(`purge_everything API call failed: ${JSON.stringify(json?.errors)}`);
    process.exit(1);
  }
  console.log(`✅ Cloudflare edge cache purged (zone ${zoneId}).`);
} catch (err) {
  console.error(`❌ Cloudflare API request failed: ${err.message}`);
  warnStaleEdge(`network error contacting Cloudflare API: ${err.message}`);
  process.exit(1);
}
