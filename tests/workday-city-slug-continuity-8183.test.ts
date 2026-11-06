import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { firstLocationSegment } from '../scripts/lib/ats-clients/workday-client.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const WORKDAY_URL = (city: string) =>
  `https://siegfried.wd103.myworkdayjobs.com/en/external/job/${city}/Quality-specialist_R11696`;

describe('Workday city corrections keep public slug continuity (#8183)', () => {
  it('normalizes non-spaced administrative suffixes without truncating uppercase cities', () => {
    expect(firstLocationSegment('Sion-VS')).toBe('Sion');
    expect(firstLocationSegment('Visp-Switzerland')).toBe('Visp');
    expect(firstLocationSegment('ST-MAURICE')).toBe('ST-MAURICE');
  });

  it.each([
    ['Sion-VS', 'Sion', 'quality-specialist-sion-vs', 'quality-specialist-sion'],
    ['MAURICE', 'ST-MAURICE', 'quality-specialist-maurice', 'quality-specialist-st-maurice'],
  ])(
    'bridges the old city-bearing slug when the same requisition gets the corrected city (%s → %s)',
    (oldCity, newCity, oldSlug, newSlug) => {
      const base = {
        id: 'siegfried-r11696',
        company: 'Siegfried',
        title: 'Quality specialist',
        sourceLang: 'en',
        description: 'x'.repeat(200),
        source: 'Siegfried Dedicated Parser (Workday)',
      };
      const merged = mergePreserveLocaleData(
        [{
          ...base,
          url: WORKDAY_URL(oldCity),
          location: oldCity,
          addressLocality: oldCity,
          slug: oldSlug,
          slugByLocale: { en: oldSlug },
        }],
        [{
          ...base,
          url: WORKDAY_URL(newCity),
          location: newCity,
          addressLocality: newCity,
          slug: newSlug,
          slugByLocale: { en: newSlug },
        }],
      );

      expect(merged).toHaveLength(1);
      expect(merged[0].location).toBe(newCity);
      expect(merged[0].slug).toBe(newSlug);
      expect(merged[0].previousSlugs).toContain(oldSlug);
      expect(merged[0].previousSlugsByLocale?.en).toContain(oldSlug);
      expect(merged[0].previousSlugsByLocale?.it).toContain(oldSlug);
    },
  );

  it('keeps all four deferred Workday consumers on the shared boundary and merge paths', () => {
    const consumers = [
      ['scripts/update-fnz-jobs.mjs', './lib/ats-clients/workday-client.mjs'],
      ['scripts/lib/swiss-life-job-parser.mjs', './ats-clients/workday-client.mjs'],
      ['scripts/lib/lonza-job-parser.mjs', './ats-clients/workday-client.mjs'],
      ['scripts/lib/siegfried-job-parser.mjs', './ats-clients/workday-client.mjs'],
    ] as const;

    for (const [relativePath, importPath] of consumers) {
      const source = read(relativePath);
      expect(source, relativePath).toContain(`from '${importPath}'`);
      expect(source, relativePath).toContain('firstLocationSegment');
    }

    expect(read('scripts/update-fnz-jobs.mjs')).toContain('mergePreserveLocaleData(');
    for (const relativePath of [
      'scripts/update-swiss-life-jobs.mjs',
      'scripts/update-lonza-jobs.mjs',
      'scripts/update-siegfried-jobs.mjs',
    ]) {
      expect(read(relativePath), relativePath).toContain('runStandardCrawlerPipeline(');
    }
  });
});
