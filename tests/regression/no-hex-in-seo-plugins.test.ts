/**
 * Regression: no inline hex colors in migrated SEO plugins
 *
 * 12 (+ bonus F4/F2/F8/F6) build-plugins were migrated from hard-coded
 * `#rrggbb` inline styles to `var(--color-*)` CSS custom properties so
 * that pages respect the site's dark-mode design token system.
 *
 * This test reads each migrated plugin file and asserts that no
 *   style="...#rrggbb..."
 * attribute remains in template literals.
 *
 * Allowlist / known survivors NOT scanned here:
 *  - jobsSeoPagesPlugin.ts: pre-hydration FOUC dark-mode block, navSvg flag
 *    colors, and <meta name="theme-color"> tags intentionally keep hex (they
 *    are NOT inside style="..." attributes so the regex already misses them,
 *    but we exclude the file from scanning to be explicit).
 *  - shared/seoContentTokens.ts: the canonical token definitions — hex here
 *    would be inside JS strings defining var(--color-*) constants, not
 *    style attrs.
 *  - Non-migrated plugins (staticPagesPlugin, editorialContent, faqHubPlugin,
 *    ogPagesPlugin, affiliateRedirectPlugin, professionLandingsLinksPlugin):
 *    these were NOT part of the Apr-23 migration sprint and are out of scope.
 *
 * Pattern note:
 *  - style="[^"]*#[0-9a-fA-F]{3,8}[^"]*" matches hex inside a style attr.
 *  - Hex inside block-comments, line-comments, rgba(), or data: URIs is NOT
 *    matched by the pattern (rgba/data don't start with '#'; comment lines
 *    are skipped by the line-by-line scanner below).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const PLUGINS_DIR = path.join(ROOT, 'build-plugins');

// The set of plugins that were migrated and MUST NOT contain inline hex styles.
const MIGRATED_PLUGINS = [
  'annualReportPlugin.ts',
  'borderWaitMapPlugin.ts',
  'borderWaitPagesPlugin.ts',
  'careerLandingsPlugin.ts',
  'comparisonsHubLinksPlugin.ts',
  'comparisonsHubPlugin.ts',
  'costOfLivingLandingsPlugin.ts',
  'fuelDailyPagesPlugin.ts',
  'healthPremiumsLandingPlugin.ts',
  'jobMarketSnapshotPlugin.ts',
  'jobRecencyPagesPlugin.ts',
  'jobSectorPagesPlugin.ts',
  'marketReportPlugin.ts',
  'nursingLandingsPlugin.ts',
  'orphanQueryLandingPlugin.ts',
  'professionLandingsPlugin.ts',
  // weeklyEmployersPlugin migrated in same sprint
  'weeklyEmployersPlugin.ts',
];

/** Regex: a style attribute whose value contains at least one hex color. */
const HEX_IN_STYLE_ATTR = /style="[^"]*#[0-9a-fA-F]{3,8}[^"]*"/g;

describe('no-hex-in-seo-plugins — migrated plugin set', () => {
  for (const pluginFile of MIGRATED_PLUGINS) {
    const fullPath = path.join(PLUGINS_DIR, pluginFile);

    it(`${pluginFile} has no inline hex in style="..." attributes`, () => {
      if (!fs.existsSync(fullPath)) {
        // If the file doesn't exist at all the migration hasn't happened yet — fail loudly.
        throw new Error(`Expected migrated plugin ${pluginFile} to exist at ${fullPath}`);
      }

      const source = fs.readFileSync(fullPath, 'utf-8');
      const lines = source.split('\n');
      const violations: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip pure comment lines (JS/TS line comments and block-comment lines)
        const stripped = line.trim();
        if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) {
          continue;
        }
        const matches = [...line.matchAll(HEX_IN_STYLE_ATTR)];
        for (const m of matches) {
          violations.push(`  line ${i + 1}: ${m[0].slice(0, 80)}`);
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `${pluginFile}: ${violations.length} inline hex style(s) found (expected none after migration):\n` +
          violations.join('\n'),
        );
      }
    });
  }
});

describe('no-hex-in-seo-plugins — shared/seoContentTokens.ts sanity', () => {
  it('seoContentTokens.ts exported style strings use var(--color-*) not hex colors', () => {
    const tokensPath = path.join(PLUGINS_DIR, 'shared', 'seoContentTokens.ts');
    expect(fs.existsSync(tokensPath)).toBe(true);
    const source = fs.readFileSync(tokensPath, 'utf-8');
    // The file exports TS string constants like `'color:var(--color-accent);...'`.
    // These are style values, NOT full HTML attributes. Check that none of the
    // exported constant strings contain a bare hex color like #rrggbb.
    // We check for hex that appears outside a comment context.
    const violations: string[] = [];
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();
      if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) continue;
      const hexInStyleValue = [...lines[i].matchAll(/#[0-9a-fA-F]{3,8}\b/g)];
      for (const m of hexInStyleValue) {
        violations.push(`  line ${i + 1}: ...${lines[i].slice(Math.max(0, m.index! - 20), m.index! + 20)}...`);
      }
    }
    expect(violations, 'hex colors found in seoContentTokens.ts').toEqual([]);
  });
});
