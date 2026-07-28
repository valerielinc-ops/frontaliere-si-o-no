import { describe, expect, it } from 'vitest';
import { looksLikeShortLabelValue, extractCompanyFromText, extractLocationFromText, __testables } from '../scripts/lib/shared-jobs-crawler.mjs';

const { buildKnownJobUrlsSet } = __testables;

describe('looksLikeShortLabelValue — prose-fragment sanity guard (#4587)', () => {
  it('rejects real production garbage captured by the loose label regexes', () => {
    const garbage = [
      "und Dokumentation des Designprozesses Enge Zusammenarbeit mit internen Fachbereichen zur Abstimmung von visuellen Materialien Das bringst du",
      "that's experiencing real growth transformation, you share commitment making tangible difference taking continuous st",
      'by promoting practical use cases success stories. Deliver tailored, cost-effective solutions using appropriate methodologies, including',
      '; Gold AWEI Employer',
      '2050 highest-possible ESG rating from MSCI',
      'attentionné',
      'where your ideas valued',
    ];
    for (const g of garbage) {
      expect(looksLikeShortLabelValue(g), `expected to reject: ${g}`).toBe(false);
    }
  });

  it('accepts real company/location names', () => {
    const legit = [
      'Zurich Insurance (sede Ticino)',
      'PostFinance AG',
      'Ernst & Young Ltd',
      'PricewaterhouseCoopers AG',
      'Lugano',
      'Zürich',
      'Bellinzona',
      'Kriens',
      '8001 Zürich',
      '6900 Lugano',
    ];
    for (const v of legit) {
      expect(looksLikeShortLabelValue(v), `expected to accept: ${v}`).toBe(true);
    }
  });
});

describe('extractCompanyFromText — does not let stray label keywords in body prose corrupt the company field (#4587)', () => {
  it('falls back to the trusted crawler-known company name when the only match is a "Company Description" paragraph', () => {
    // Mirrors the real zurich-insurance-sede-ticino corruption: a
    // "Company Description" heading followed by marketing prose (not a
    // short company name) is the only thing the loose label regex can find
    // on the page — no JSON-LD hiringOrganization, no og:site_name.
    const html = `
      <html><body>
        <h1>AI Tech Lead</h1>
        <p>Company Description: that's experiencing real growth transformation, you share commitment making tangible difference taking continuous steps.</p>
      </body></html>
    `;
    expect(extractCompanyFromText(html, 'Zurich Insurance (sede Ticino)')).toBe('Zurich Insurance (sede Ticino)');
  });

  it('still trusts a genuinely short, well-formed hiringOrganization label match', () => {
    const html = `
      <html><body>
        <h1>Underwriter</h1>
        <p>Hiring Organization: Zurich Insurance Company Ltd</p>
      </body></html>
    `;
    expect(extractCompanyFromText(html, 'fallback')).toBe('Zurich Insurance Company Ltd');
  });
});

describe('extractLocationFromText — does not let stray label keywords in body prose corrupt the location field (#4587)', () => {
  it('falls back to the empty/caller default when the only "Workplace" match is a prose fragment', () => {
    const html = `
      <html><body>
        <h1>Junior Credit Analyst</h1>
        <p>Workplace: where your ideas valued and everyone feels welcome as part of our global team.</p>
      </body></html>
    `;
    expect(extractLocationFromText(html, '')).toBe('');
  });

  it('still trusts a genuinely short, well-formed location label match', () => {
    const html = `
      <html><body>
        <h1>Underwriter</h1>
        <p>Sede di lavoro: Lugano</p>
      </body></html>
    `;
    expect(extractLocationFromText(html, '')).toBe('Lugano');
  });
});

describe('buildKnownJobUrlsSet — skip-optimization must not trust jobs with a pending crawler miss (issue 4826)', () => {
  it('excludes a job with an active crawlerMissStreak so it gets re-fetched instead of blindly skipped', () => {
    const preloadedJobs = [
      { url: 'https://www.rado.com/careers/watchmaker', crawlerMissStreak: 1 },
      { url: 'https://www.rado.com/careers/sales-associate', crawlerMissStreak: 2 },
    ];
    const knownJobUrls = buildKnownJobUrlsSet(preloadedJobs);
    expect(knownJobUrls.has('https://www.rado.com/careers/watchmaker')).toBe(false);
    expect(knownJobUrls.has('https://www.rado.com/careers/sales-associate')).toBe(false);
    expect(knownJobUrls.size).toBe(0);
  });

  it('keeps the skip-optimization for jobs with no miss streak (normal, healthy case)', () => {
    const preloadedJobs = [
      { url: 'https://www.rado.com/careers/watchmaker' },
      { url: 'https://www.rado.com/careers/designer', crawlerMissStreak: 0 },
    ];
    const knownJobUrls = buildKnownJobUrlsSet(preloadedJobs);
    expect(knownJobUrls.has('https://www.rado.com/careers/watchmaker')).toBe(true);
    expect(knownJobUrls.has('https://www.rado.com/careers/designer')).toBe(true);
    expect(knownJobUrls.size).toBe(2);
  });

  it('handles a mixed batch: only the streak-free job survives into the skip set', () => {
    const preloadedJobs = [
      { url: 'https://www.rado.com/careers/watchmaker', crawlerMissStreak: 1 },
      { url: 'https://www.rado.com/careers/designer' },
    ];
    const knownJobUrls = buildKnownJobUrlsSet(preloadedJobs);
    expect(knownJobUrls.has('https://www.rado.com/careers/watchmaker')).toBe(false);
    expect(knownJobUrls.has('https://www.rado.com/careers/designer')).toBe(true);
  });

  it('is defensive against a non-array input (mirrors production null-preload fallback)', () => {
    expect(buildKnownJobUrlsSet(null).size).toBe(0);
    expect(buildKnownJobUrlsSet(undefined).size).toBe(0);
  });
});
