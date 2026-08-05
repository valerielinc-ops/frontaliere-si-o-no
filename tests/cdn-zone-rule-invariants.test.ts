import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards two zone-rule invariants on `cdn.frontaliereticino.ch` (#5176), both
 * found by measuring the zone while fixing the 502 family in #5165.
 *
 * ─── Why this reads the script as TEXT and never imports it ───────────────────
 * `scripts/cf-locale-failover-setup.mjs` does its work at TOP LEVEL — the file
 * ends with `const zoneId = await resolveZoneId()` followed by the assert
 * functions that PUT rulesets to the live zone. Importing it from a test would
 * reconfigure production Cloudflare as a side effect of collecting the suite.
 * So these assertions are on the source text. That is the right level anyway:
 * the thing being guarded IS a declarative string (a Cloudflare filter
 * expression), not behaviour.
 *
 * ─── Invariant 1: the early-boot bypass must not be overridable ───────────────
 * In the `http_request_cache_settings` phase every matching rule applies in
 * order and a LATER rule overrides an earlier one. `early-boot-js-bypass-cache`
 * (`cache: false`) exists so the version-skew self-heal script is never served
 * stale. But assertCacheRules() appends a managed rule it does not already find
 * (`rules.push(desired)`), so `cdn-r2-passthrough-cache` — which matches every
 * CDN path — lands after it and its `cache: true` won.
 *
 * Measured live 2026-08-05, before the fix:
 *   GET https://cdn.frontaliereticino.ch/assets/early-boot.js -> cf-cache-status: HIT
 * where the rule's whole purpose is BYPASS. (Use GET: `curl -I` sends HEAD,
 * which Cloudflare never serves from cache, so every path misreports DYNAMIC.)
 *
 * A stale early-boot.js runs an old self-heal listener set against new HTML —
 * the cross-chunk skew behind #3216/#5062/#4644. #5165 closed #4644 from the
 * 502 side; leaving this open lets the same issue return by a different route
 * and read as a regression of that fix.
 *
 * The fix is an EXCLUSION, not a reordering: order here is a side effect of
 * append-on-create and a foreign rule can be recreated at any index by whoever
 * owns it, so a reordering fix would be one dashboard edit away from silently
 * reverting. Excluding the path makes the bypass the only rule that matches it.
 *
 * ─── Invariant 2: the CDN root must not answer with a 28 KB body ──────────────
 * `cdn.frontaliereticino.ch/` served 42_919 404s in 23h — the zone's largest
 * non-2xx, bigger than every 5xx combined — and R2 answers a missing root with
 * Cloudflare's stock ~28 KB error page: 315.3 MB of egress in a day.
 *
 * It is external scanning, not a broken reference of ours: 99.4% arrived over
 * HTTP/1.1 (42_641/42_919) with an unrecognised UA where real browser traffic
 * to this zone is HTTP/2; it is bursty (~0/h for hours, then 10.3k in one) and
 * 42_543 came from a single country whose entire CDN traffic is 44_219. Nothing
 * the site emits requests the bare CDN root, and the accompanying tail is plain
 * WordPress probing (/wp-json/batch/v1, /index.php, /config/.env).
 *
 * So the remedy is a bodyless 301, not a link fix and not a WAF block (which
 * would cost the same to serve, risk false positives, and need allowlist
 * upkeep).
 */
const ROOT = resolve(import.meta.dirname, '..');
const SETUP = readFileSync(resolve(ROOT, 'scripts/cf-locale-failover-setup.mjs'), 'utf-8');

/** The literal the rule expressions interpolate. Single source of truth check. */
const EARLY_BOOT_PATH = '/assets/early-boot.js';

/** Body of a `{ ... }` rule object identified by its `description:` line. */
function ruleBlock(descriptionPrefix: string): string {
  const idx = SETUP.indexOf(`description: '${descriptionPrefix}`);
  expect(idx, `rule "${descriptionPrefix}" not found in cf-locale-failover-setup.mjs`).toBeGreaterThan(-1);
  // From the description to the end of that object literal — enough to cover
  // the expression and action_parameters that follow it.
  return SETUP.slice(idx, idx + 1200);
}

describe('early-boot.js cache bypass cannot be overridden', () => {
  it('declares the early-boot path as a named constant, not a scattered literal', () => {
    expect(SETUP).toMatch(/const EARLY_BOOT_PATH = '\/assets\/early-boot\.js'/);
  });

  it('does NOT export that constant (importing this module would PUT to production)', () => {
    // The module self-executes; an `export` here invites a test to import it and
    // reconfigure the live zone while merely collecting the suite.
    expect(SETUP).not.toMatch(/export const EARLY_BOOT_PATH/);
  });

  it('excludes the early-boot path from cdn-r2-passthrough-cache', () => {
    const block = ruleBlock('cdn-r2-passthrough-cache');
    // Either the interpolated constant or the literal is acceptable; what must
    // hold is that the broad CDN rule does not match this path.
    const excludes =
      /http\.request\.uri\.path ne "\$\{EARLY_BOOT_PATH\}"/.test(block) ||
      block.includes(`http.request.uri.path ne "${EARLY_BOOT_PATH}"`);
    expect(
      excludes,
      'cdn-r2-passthrough-cache must exclude /assets/early-boot.js — it is appended last, ' +
        'and a later rule wins in the cache phase, so without this its cache:true overrides ' +
        'early-boot-js-bypass-cache and the file serves HIT instead of BYPASS (#5176)',
    ).toBe(true);
  });

  it('keeps excluding /cdn-build-id.txt (the #2569 publish-ordering gate polls it)', () => {
    expect(ruleBlock('cdn-r2-passthrough-cache')).toContain('http.request.uri.path ne "/cdn-build-id.txt"');
  });
});

describe('cdn root 301 keeps the zone from paying for scanner 404s', () => {
  it('declares a managed cdn-root-301 redirect rule', () => {
    expect(SETUP).toMatch(/description: 'cdn-root-301 \(managed by scripts\/cf-locale-failover-setup\.mjs\)'/);
  });

  it('matches the CDN root EXACTLY, so it cannot swallow real asset paths', () => {
    const block = ruleBlock('cdn-root-301');
    expect(block).toContain('http.host eq "cdn.frontaliereticino.ch"');
    // `eq "/"` and not a starts_with — a prefix match here would 301 every asset.
    expect(block).toContain('http.request.uri.path eq "/"');
    expect(block).not.toMatch(/starts_with\(http\.request\.uri\.path/);
  });

  it('redirects to the apex with a permanent, bodyless 301', () => {
    const block = ruleBlock('cdn-root-301');
    expect(block).toMatch(/status_code: 301/);
    expect(block).toContain('https://frontaliereticino.ch');
  });

  it('uses the concat() target form proven on this zone, not an unverified schema', () => {
    // This script rewrites action_parameters wholesale on every run, so a target
    // schema Cloudflare rejects does not fail alone — the PUT bails and takes
    // routes, cache, firewall and redirect config with it. Every redirect rule
    // live on this zone uses concat(); `target_url.value` is unproven here.
    const block = ruleBlock('cdn-root-301');
    expect(block).toMatch(/expression: 'concat\("https:\/\/frontaliereticino\.ch", http\.request\.uri\.path\)'/);
    expect(block).not.toMatch(/target_url: \{ value:/);
  });

  it('targets a different host, so a redirect loop is impossible', () => {
    const block = ruleBlock('cdn-root-301');
    // Guard against someone "fixing" the target to the CDN host itself, which
    // would make every root request bounce forever.
    expect(block).not.toMatch(/concat\("https:\/\/cdn\.frontaliereticino\.ch/);
  });
});

describe('redirect drift detection covers static targets', () => {
  it('the OTHER ruleset writer compares both target forms too', () => {
    // This repo has exactly two files that PUT a Cloudflare rule list:
    // cf-locale-failover-setup.mjs and scripts/lib/cf-redirect-rules.mjs (used
    // by ensure-cdn-fonts-redirect.mjs / ensure-image-cdn-redirect.mjs). Both
    // carried the same expression-only comparison, so both are fixed — two
    // writers disagreeing about what "in shape" means is how a rule silently
    // stops being managed.
    const lib = readFileSync(resolve(ROOT, 'scripts/lib/cf-redirect-rules.mjs'), 'utf-8');
    expect(lib).toMatch(/curFv\?\.target_url\?\.expression === wantFv\.target_url\.expression/);
    expect(lib).toMatch(/curFv\?\.target_url\?\.value === wantFv\.target_url\.value/);
  });

  it('compares BOTH target_url.expression and target_url.value', () => {
    // A redirect target is either dynamic (`expression`) or static (`value`).
    // Comparing only `expression` made a static rule drift-blind: both sides
    // read `undefined`, so any change to the destination — including a manual
    // dashboard edit — reported "already in shape" forever. cdn-root-301 is the
    // first static-target rule this script owns, which is how this surfaced.
    expect(SETUP).toMatch(/fromTarget\.expression !== want\.target_url\.expression/);
    expect(SETUP).toMatch(/fromTarget\.value !== want\.target_url\.value/);
  });
});
