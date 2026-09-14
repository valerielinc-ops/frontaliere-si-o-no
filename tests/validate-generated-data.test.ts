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
});

