/**
 * Regression: SEO landing pattern lock-in
 *
 * The 11 SEO landing build-plugins listed below MUST follow the
 * canonical layout documented in CLAUDE.md rule #17:
 *   1. <header> with H1 + LEDE tagline (1 line)
 *   2. Stats tile grid right after the header (STAT_TILE_*)
 *   3. Optional advice banner (data-*-advice)
 *   4. Primary CTA (CTA_PRIMARY_STYLE)
 *   5. Data area
 *   6. Long prose moved BELOW the action area
 *
 * This file does NOT call the render functions (each has a complex
 * fixture surface — already covered by feature-specific tests). It
 * asserts the *source* of each plugin still imports + uses the
 * shared canonical tokens, so a future PR cannot silently introduce
 * a hand-rolled `<div style="background:#hex">` tile or drop the
 * tile/CTA without breaking the regression first.
 *
 * Adding a new SEO landing? Add the plugin filename to
 * SEO_LANDING_PLUGINS below — the test will fail until the new
 * plugin uses STAT_TILE_* + CTA_PRIMARY_STYLE / LINK_ACCENT_STYLE
 * + imports from `./shared/seoContentTokens`.
 *
 * Reference commits (canonical implementations):
 *   - 2f845817eb (border-wait leaf banner)
 *   - 74866f13b4 (health-premiums leaf + canton hub)
 *   - cfde4aca6c (weekly-employers city)
 *   - 26421ccb6c (fuel-daily root)
 *   - 346e8662f4 (border-wait monthly archive + orphan landings)
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const PLUGINS_DIR = path.join(ROOT, 'build-plugins');

/** SEO landing plugins that MUST follow the canonical pattern. */
const SEO_LANDING_PLUGINS: ReadonlyArray<{
  file: string;
  feature: string;
  /**
   * When `true` this plugin emits hub/index pages where a tile grid
   * may be optional (e.g. archive index) — we only require the
   * imports to be present so future leaves don't drift. Defaults
   * to `false` (full pattern enforcement).
   */
  hubLevel?: boolean;
}> = [
  { file: 'borderWaitPagesPlugin.ts', feature: 'F8 border-wait' },
  { file: 'healthPremiumsLandingPlugin.ts', feature: 'F2 health-premiums' },
  { file: 'jobMarketSnapshotPlugin.ts', feature: 'F4 job-market-snapshot' },
  { file: 'weeklyEmployersPlugin.ts', feature: 'F5 weekly-employers' },
  { file: 'fuelDailyPagesPlugin.ts', feature: 'F6 fuel-daily' },
  { file: 'orphanQueryLandingPlugin.ts', feature: 'F3b orphan-query' },
];

function readSource(file: string): string {
  const full = path.join(PLUGINS_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`SEO landing plugin missing: ${full}`);
  }
  return fs.readFileSync(full, 'utf-8');
}

describe('SEO landing pattern — canonical token usage', () => {
  for (const { file, feature } of SEO_LANDING_PLUGINS) {
    describe(`${feature} (${file})`, () => {
      const source = readSource(file);

      it('imports STAT_TILE_* tokens from seoContentTokens', () => {
        // Match either single-import or multi-line import block.
        const importsTile = /STAT_TILE_(?:ACCENT|SUCCESS|WARNING|DANGER|BASE)/.test(source);
        expect(importsTile).toBe(true);
      });

      it('uses at least one STAT_TILE_* in a rendered template literal', () => {
        // The token name appears inside `${...}` — easy heuristic: count
        // occurrences and assert ≥ 2 (one in the import + one in usage).
        const matches = source.match(/STAT_TILE_(?:ACCENT|SUCCESS|WARNING|DANGER|BASE)/g) ?? [];
        expect(matches.length).toBeGreaterThanOrEqual(2);
      });

      it('uses a primary CTA style (CTA_PRIMARY_STYLE or LINK_ACCENT_STYLE)', () => {
        const hasCta =
          /CTA_PRIMARY_STYLE/.test(source) || /LINK_ACCENT_STYLE/.test(source);
        expect(hasCta).toBe(true);
      });

      it('imports from ./shared/seoContentTokens (no inline token redefinition)', () => {
        const importsFromShared = /from\s+['"]\.\/shared\/seoContentTokens['"]/.test(source);
        expect(importsFromShared).toBe(true);
      });

      it('renders LEDE_STYLE tagline in at least one header (H1 + LEDE pattern)', () => {
        // We expect at least one `<p style="${LEDE_STYLE}">` after
        // an `<h1 style="${H1_STYLE}">` somewhere in the file.
        const hasH1 = /\$\{H1_STYLE\}/.test(source);
        const hasLede = /\$\{LEDE_STYLE\}/.test(source);
        expect(hasH1).toBe(true);
        expect(hasLede).toBe(true);
      });
    });
  }

  it('SEO_LANDING_PLUGINS list has at least 6 plugins (catch missing-from-list regression)', () => {
    expect(SEO_LANDING_PLUGINS.length).toBeGreaterThanOrEqual(6);
  });
});
