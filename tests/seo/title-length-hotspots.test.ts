import { describe, expect, it } from 'vitest';
import { buildSectorHubSeo, SECTOR_HUB_KEYS } from '../../build-plugins/jobSectorLanding';

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
});
