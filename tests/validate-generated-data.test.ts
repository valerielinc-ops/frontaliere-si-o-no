import { describe, expect, it } from 'vitest';
import { validateGeneratedData } from '../scripts/ci/validate-generated-data.mjs';

const NOW = '2026-09-14T03:00:00.000Z';

describe('validate-generated-data', () => {
  it('accepts an evergreen history produced by its writer', () => {
    expect(validateGeneratedData('evergreen', {
      updatedAt: NOW,
      entries: [{
        date: '2026-09-14',
        sections: [{ section: 'frontaliere', poolTotal: 10, poolRemaining: 8, poolConsumedPct: 20 }],
      }],
    })).toEqual([]);
  });

  it('rejects an evergreen snapshot whose remaining pool exceeds total', () => {
    expect(validateGeneratedData('evergreen', {
      updatedAt: NOW,
      entries: [{
        date: '2026-09-14',
        sections: [{ section: 'frontaliere', poolTotal: 10, poolRemaining: 11, poolConsumedPct: 0 }],
      }],
    }).join('\n')).toContain('poolRemaining');
  });

  it('accepts a partial funnel snapshot without turning missing sources into numbers', () => {
    expect(validateGeneratedData('funnel', {
      updatedAt: NOW,
      entries: [{
        date: '2026-09-14',
        generatedAt: NOW,
        cls: null,
        gsc: null,
        adsense: null,
        sourcesOk: { cls: false, gsc: false, adsense: false },
        errors: ['source unavailable'],
        warnings: [],
      }],
    })).toEqual([]);
  });

  it('rejects parser proposals with an invalid seed URL', () => {
    expect(validateGeneratedData('parser-proposals', {
      generatedAt: NOW,
      proposals: [{
        companyKey: 'acme',
        companyName: 'Acme',
        companyWebsite: 'https://acme.example',
        companyHost: 'acme.example',
        sourceSeedsByDomain: ['javascript:alert(1)'],
        sourceSeedsByName: [],
        crawlerMode: ['html'],
        confidence: null,
        notes: '',
        applied: false,
        appliedAt: null,
      }],
    }).join('\n')).toContain('sourceSeedsByDomain[0]');
  });

  it('requires unemployment history to agree with the current point', () => {
    expect(validateGeneratedData('unemployment', {
      rate: 2.4,
      unit: 'percent',
      period: '2026-08',
      history: [{ period: '2026-07', rate: 2.3 }],
      sourceName: 'SECO',
      sourceUrl: 'https://www.arbeit.swiss/secoalv/it/home.html',
      releaseUrl: '',
      seoText: { it: 'ok', en: 'ok', de: 'ok', fr: 'ok' },
      fetchedAt: NOW,
    }).join('\n')).toContain('ultima voce');
  });

  it('accepts the rate-baseline shapes used by the SEO seed workflows', () => {
    const common = {
      mode: 'rate',
      generated: NOW,
      tolerance: { relPct: 20, absPp: 1, minAbsDelta: 5, maxDeltaPp: 3 },
      scanned: 100,
      totalOffenders: 2,
      totalRatePct: 2,
      byFeature: { blog: { scanned: 100, offenders: 2, ratePct: 2 } },
      byLocale: { it: 2 },
    };
    expect(validateGeneratedData('text-html-ratio', { ...common, threshold: 10 })).toEqual([]);
    expect(validateGeneratedData('title-length', { ...common, threshold: 66 })).toEqual([]);
    expect(validateGeneratedData('title-no-disambig-hash', common)).toEqual([]);
    expect(validateGeneratedData('h1-title-duplicates', common)).toEqual([]);
    expect(validateGeneratedData('bfs-depth', {
      version: 2,
      mode: 'rate',
      generatedAt: NOW,
      maxDepth: 4,
      tolerance: common.tolerance,
      perSitemap: { 'sitemap-blog.xml': { total: 10, reached: 9, atDepthGtMax: 1, ratePct: 10, deepest: 5 } },
    })).toEqual([]);
    expect(validateGeneratedData('orphan-pages', {
      version: 2,
      mode: 'rate',
      generatedAt: NOW,
      scanMode: 'html',
      totalSitemapUrls: 10,
      totalOrphans: 1,
      tolerance: common.tolerance,
      perSitemap: { 'sitemap-blog.xml': { total: 10, orphans: 1, ratePct: 10, examples: ['https://example.com/a'] } },
    })).toEqual([]);
  });

  it('rejects a rate baseline with impossible bucket counts or a non-rate mode', () => {
    expect(validateGeneratedData('title-length', {
      mode: 'absolute',
      generated: NOW,
      tolerance: { relPct: 20, absPp: 1, minAbsDelta: 5, maxDeltaPp: 3 },
      threshold: 66,
      scanned: 10,
      totalOffenders: 11,
      totalRatePct: 110,
      byFeature: { blog: { scanned: 2, offenders: 3, ratePct: 150 } },
    }).join('\n')).toMatch(/mode|totalOffenders|ratePct/);
  });

  it('rejects rates that do not derive from their stored counts', () => {
    const inconsistent = {
      mode: 'rate',
      generated: NOW,
      tolerance: { relPct: 20, absPp: 1, minAbsDelta: 5, maxDeltaPp: 3 },
      threshold: 66,
      scanned: 100,
      totalOffenders: 2,
      totalRatePct: 100,
      byFeature: { blog: { scanned: 100, offenders: 2, ratePct: 100 } },
    };
    const errors = validateGeneratedData('title-length', inconsistent).join('\n');
    expect(errors).toContain('totalRatePct');
    expect(errors).toContain('byFeature.blog.ratePct');

    expect(validateGeneratedData('bfs-depth', {
      version: 2,
      mode: 'rate',
      generatedAt: NOW,
      maxDepth: 4,
      tolerance: inconsistent.tolerance,
      perSitemap: { 'sitemap-blog.xml': { total: 10, reached: 9, atDepthGtMax: 1, ratePct: 100, deepest: 5 } },
    }).join('\n')).toContain('perSitemap.sitemap-blog.xml.ratePct');

    expect(validateGeneratedData('orphan-pages', {
      version: 2,
      mode: 'rate',
      generatedAt: NOW,
      scanMode: 'html',
      totalSitemapUrls: 10,
      totalOrphans: 1,
      tolerance: inconsistent.tolerance,
      perSitemap: { 'sitemap-blog.xml': { total: 10, orphans: 1, ratePct: 100, examples: [] } },
    }).join('\n')).toContain('perSitemap.sitemap-blog.xml.ratePct');
  });
});
