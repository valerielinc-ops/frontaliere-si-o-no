import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildSectorHubSeo, SECTOR_HUB_KEYS } from '../../build-plugins/jobSectorLanding';

const root = path.resolve(__dirname, '../..');

describe('SEO title length hotspots', () => {
  it('keeps sector hub titles within the 60-character target', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const sector of SECTOR_HUB_KEYS) {
        for (const count of [0, 40, 1200]) {
          const title = buildSectorHubSeo(locale, sector, count, 2026).title;
          expect(title.length, `${locale}/${sector}/${count}: ${title}`).toBeLessThanOrEqual(60);
        }
      }
    }
  });

  it('passes the same 60-character budget to the other title-base emitters', () => {
    const sourceFiles = [
      'build-plugins/healthPremiumsLandingPlugin.ts',
      'build-plugins/jobMarketSnapshotPlugin.ts',
      'build-plugins/fuelStationIndexPages.ts',
      'build-plugins/fuelDailyPagesPlugin.ts',
    ];
    for (const relativePath of sourceFiles) {
      const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
      expect(source, relativePath).not.toContain("clampSiteSuffix(titleBase, 'Frontaliere Ticino');");
    }
  });
});
