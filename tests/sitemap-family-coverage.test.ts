import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  countSitemapFamilyUrls,
  evaluateSitemapFamilyCoverage,
} from '../scripts/lib/sitemap-family-coverage.mjs';

const NO_DECLARATIONS = { version: 1, decreases: [] };

const snapshot = (perSitemap: Record<string, string[]>) => ({ version: 3, perSitemap });

describe('sitemap family URL coverage ratchet', () => {
  it('counts unique URLs across topic shards and the separate event archives', () => {
    const counts = countSitemapFamilyUrls(snapshot({
      'sitemap-topics-frontaliere.xml': ['https://frontaliereticino.ch/topic/a/', 'https://frontaliereticino.ch/topic/shared/'],
      'sitemap-topics-svizzera.xml': ['https://frontaliereticino.ch/topic/b/', 'https://frontaliereticino.ch/topic/shared/'],
      'sitemap-eventi.xml': ['https://frontaliereticino.ch/eventi/futuro/', 'https://frontaliereticino.ch/eventi/archivio/'],
      'sitemap-eventi-storici.xml': ['https://frontaliereticino.ch/eventi/passato/', 'https://frontaliereticino.ch/eventi/archivio/'],
      'sitemap-pages.xml': ['https://frontaliereticino.ch/una-pagina/'],
    }));

    expect(counts.topics).toBe(3);
    expect(counts.events).toBe(3);
    expect(counts['job-market']).toBe(0);
  });

  it('passes when archived details move to a separate sitemap without lowering event coverage', () => {
    const previous = snapshot({
      'sitemap-eventi.xml': ['https://frontaliereticino.ch/eventi/futuro/', 'https://frontaliereticino.ch/eventi/passato/'],
      'sitemap-topics-frontaliere.xml': ['https://frontaliereticino.ch/topic/a/'],
    });
    const current = snapshot({
      'sitemap-eventi.xml': ['https://frontaliereticino.ch/eventi/futuro/'],
      'sitemap-eventi-storici.xml': ['https://frontaliereticino.ch/eventi/passato/'],
      'sitemap-topics-frontaliere.xml': ['https://frontaliereticino.ch/topic/a/'],
      'sitemap-topics-svizzera.xml': ['https://frontaliereticino.ch/topic/b/'],
    });

    const result = evaluateSitemapFamilyCoverage(previous, current, NO_DECLARATIONS);
    expect(result.regressions).toEqual([]);
    expect(result.families.find(({ family }) => family === 'events')?.delta).toBe(0);
    expect(result.families.find(({ family }) => family === 'topics')?.delta).toBe(1);
  });

  it('fails a family count decrease unless the declaration matches both exact counts', () => {
    const previous = snapshot({ 'sitemap-profession-cities.xml': ['a', 'b', 'c'] });
    const current = snapshot({ 'sitemap-profession-cities.xml': ['a', 'b'] });

    const undeclared = evaluateSitemapFamilyCoverage(previous, current, NO_DECLARATIONS);
    expect(undeclared.regressions).toEqual([
      { family: 'profession-cities', previousCount: 3, currentCount: 2, delta: -1 },
    ]);

    const declared = evaluateSitemapFamilyCoverage(previous, current, {
      version: 1,
      decreases: [{
        family: 'profession-cities',
        previousCount: 3,
        currentCount: 2,
        reason: 'Removed one URL after confirming its canonical route redirects permanently.',
      }],
    });
    expect(declared.regressions).toEqual([]);
    expect(declared.allowedDecreases).toHaveLength(1);
    expect(declared.staleDeclarations).toEqual([]);
  });

  it('rejects broad, stale, malformed, and legacy flat declarations/snapshots', () => {
    const previous = snapshot({ 'sitemap-job-market.xml': ['a', 'b'] });
    const current = snapshot({ 'sitemap-job-market.xml': ['a'] });
    const stale = evaluateSitemapFamilyCoverage(previous, current, {
      version: 1,
      decreases: [{
        family: 'job-market', previousCount: 2, currentCount: 1,
        reason: 'A concrete reason with enough detail for a one-time change.',
      }],
    });
    expect(stale.invalidDeclarations).toHaveLength(0);

    const wrongCounts = evaluateSitemapFamilyCoverage(previous, current, {
      version: 1,
      decreases: [{
        family: 'job-market', previousCount: 200, currentCount: 100,
        reason: 'A concrete reason with enough detail for a one-time change.',
      }],
    });
    expect(wrongCounts.regressions).toHaveLength(1);
    expect(wrongCounts.staleDeclarations).toHaveLength(1);
    expect(() => evaluateSitemapFamilyCoverage([], current, NO_DECLARATIONS)).toThrow(/per-sitemap snapshot/);
    expect(() => evaluateSitemapFamilyCoverage(previous, current, { version: 1, decreases: [{}] }))
      .not.toThrow();
    const invalid = evaluateSitemapFamilyCoverage(previous, current, {
      version: 1,
      decreases: [{ family: 'job-market', previousCount: 2, currentCount: 1, reason: 'short' }],
    });
    expect(invalid.invalidDeclarations).toHaveLength(1);
  });

  it('runs as a blocking post-deploy validator', () => {
    const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/post-deploy-validate-dist.yml'), 'utf8');
    expect(workflow).toContain('spawn_capped validate:sitemap-family-coverage');
    expect(workflow).toContain('node scripts/diff-sitemaps.mjs --gate-family-coverage');
  });
});
