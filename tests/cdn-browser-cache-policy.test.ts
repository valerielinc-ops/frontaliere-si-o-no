import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { cachePolicyProblem, parseReleaseId } from '@/scripts/ci/assert-cdn-cache-policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SETUP = readFileSync(resolve(ROOT, 'scripts/cf-locale-failover-setup.mjs'), 'utf8');
const PREP = readFileSync(resolve(ROOT, 'scripts/lib/deploy-it-pages-prep.sh'), 'utf8');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/deploy-worker.yml'), 'utf8');

/**
 * The browser-facing Cache-Control on the CDN comes from a zone Transform Rule,
 * not from R2, so an immutable object can still reach the browser as 600 s. Read
 * as text: importing the setup script would PUT rulesets to the live zone.
 */
describe('cdn-assets-revalidate leaves immutable URLs alone', () => {
  const prefixes = /const CDN_BROWSER_LONG_CACHE_PREFIXES = \[([\s\S]*?)\];/.exec(SETUP)?.[1] ?? '';

  it('excludes the build-scoped release namespace', () => {
    expect(prefixes).toContain("'/assets/releases/'");
  });

  it('keeps every stable alias under the rule: a hashed prefix ends in a dash', () => {
    for (const name of ['gtag-init', 'adsense-loader', 'partnerize-tag']) {
      expect(prefixes).toContain(`'/assets/${name}-'`);
      expect(prefixes).not.toContain(`'/assets/${name}'`);
    }
  });

  it('is a managed rule that migrates the live one in place', () => {
    expect(SETUP).toContain('legacyDescriptions: [LEGACY_CDN_ASSETS_REVALIDATE_DESCRIPTION]');
    expect(SETUP).toContain(
      "'cdn-assets-revalidate: override GitHub Pages immutable on stable-named SPA chunks (max-age=600 must-revalidate, matches public/_headers)'",
    );
  });

  it('uses starts_with only: this zone is on the Free plan, no regex operator', () => {
    expect(SETUP).not.toMatch(/http\.request\.uri\.path matches/);
  });

  it('never makes the root policy itself long-lived', () => {
    expect(SETUP).toContain("value: 'public, max-age=600, must-revalidate'");
  });
});

describe('content-addressed loaders on R2', () => {
  it('publishes them immutable and restores them to the stage for the purge ledger', () => {
    expect(PREP).toContain(`_r2_sync 120 "$_hashed_assets_stage" assets "public,max-age=31536000,immutable"`);
    expect(PREP).toContain(`mv "$_hashed_assets_stage"/* "$stage/assets/"`);
    for (const name of ['gtag-init', 'adsense-loader', 'partnerize-tag']) {
      expect(PREP).toContain(`-name '${name}-*.js'`);
    }
  });

  it('leaves the stable aliases in the short-TTL batch', () => {
    expect(PREP).not.toMatch(/-name 'gtag-init\*\.js'/);
  });
});

describe('assert-cdn-cache-policy', () => {
  it('runs right after the zone rules are applied, as a GET-based live check', () => {
    const apply = WORKFLOW.indexOf('run: node scripts/cf-locale-failover-setup.mjs');
    const check = WORKFLOW.indexOf('run: node scripts/ci/assert-cdn-cache-policy.mjs');
    expect(apply).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(apply);
    expect(readFileSync(resolve(ROOT, 'scripts/ci/assert-cdn-cache-policy.mjs'), 'utf8')).not.toMatch(/method: 'HEAD'/);
  });

  it('reads the release id out of the bootstrap', () => {
    expect(parseReleaseId('const FRONTALIERE_RELEASE_ID="1793418491958";')).toBe('1793418491958');
    expect(parseReleaseId('import "./App.js";')).toBeNull();
  });

  it.each([
    ['release', 'public,max-age=31536000,immutable', false],
    ['release', 'public, max-age=600, must-revalidate', true],
    ['release', 'public,max-age=600,immutable', true],
    ['stable-alias', 'public, max-age=600, must-revalidate', false],
    ['stable-alias', 'public,max-age=31536000,immutable', true],
    ['stable-alias', 'public, max-age=86400', true],
    ['early-boot', 'no-cache, must-revalidate', false],
    ['early-boot', 'public, max-age=600, must-revalidate', true],
  ])('%s with "%s"', (kind, value, wrong) => {
    expect(cachePolicyProblem(kind, value) !== null).toBe(wrong);
  });
});
