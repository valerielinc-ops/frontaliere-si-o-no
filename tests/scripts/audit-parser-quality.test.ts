// @vitest-environment node
/**
 * Unit tests for the no-structured-content ratchet exported by
 * scripts/audit-parser-quality.mjs.
 *
 * The ratchet escalates a `no-structured-content` warning to CRITICAL when:
 *   - the crawler is NEW (no baseline entry) AND has >=95% flat AND >=10 jobs
 *   - the crawler EXISTS in baseline AND its current no-structure RATIO is more
 *     than 10 percentage points higher than the baseline ratio
 *
 * Existing crawlers staying at the same count, or improving, must NOT trigger
 * CRITICAL. Crawlers with <10 jobs must NOT trigger CRITICAL even at 100% flat.
 * Crawlers whose absolute count grows only because they discovered more real
 * jobs (ratio unchanged) must NOT trigger CRITICAL either.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  applyNoStructureRatchet,
  applyDuplicateDescriptionRatchet,
  hasFormChrome,
  fingerprintsForCrawler,
  countDuplicates,
  largestDuplicateBucket,
  effectiveDescription,
  sourceLocationMatches,
  extractSourceLocationObservation,
  classifySourceLocationEvidence,
  compareSourceDetail,
  checkSourceDetailsBatch,
  applySourceDetailResults,
  finishAudit,
  filledLocaleCount,
} from '../../scripts/audit-parser-quality.mjs';

type Issue = {
  type: string;
  count: number;
  total: number;
  message: string;
  hidden?: boolean;
};

type Entry = {
  total: number;
  issues: Issue[];
  severity: 'CRITICAL' | 'WARNING' | 'OK';
  action?: string;
};

function makeEntry(noStructCount: number, total: number, severity: Entry['severity'] = 'WARNING'): Entry {
  return {
    total,
    severity,
    issues: [
      {
        type: 'no-structured-content',
        count: noStructCount,
        total,
        message: `${noStructCount}/${total} no structured content (no bullets/lists)`,
      },
    ],
  };
}

describe('applyNoStructureRatchet', () => {
  it('escalates a NEW crawler with 100% flat and >=10 jobs to CRITICAL', () => {
    const report: Record<string, Entry> = {
      'new-broken': makeEntry(15, 15),
    };
    const baseline = { generatedAt: null, perCrawler: {} };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['new-broken'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ key: 'new-broken', was: 0, now: 15, total: 15 });
    expect(report['new-broken'].issues[0].message).toMatch(/NEW OFFENDER/);
    expect(report['new-broken'].action).toMatch(/audit:parser-quality:rebaseline/);
  });

  it('does NOT escalate an existing crawler whose count is unchanged from baseline', () => {
    const report: Record<string, Entry> = {
      'flat-but-known': makeEntry(132, 132),
    };
    const baseline = {
      generatedAt: '2026-05-06T00:00:00Z',
      perCrawler: { 'flat-but-known': { noStructureCount: 132, total: 132 } },
    };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['flat-but-known'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('escalates an existing crawler whose count INCREASED above baseline to CRITICAL', () => {
    const report: Record<string, Entry> = {
      'regressed': makeEntry(50, 60),
    };
    const baseline = {
      generatedAt: '2026-05-06T00:00:00Z',
      perCrawler: { 'regressed': { noStructureCount: 30, total: 50 } },
    };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['regressed'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ key: 'regressed', was: 30, now: 50 });
    expect(report['regressed'].issues[0].message).toMatch(/REGRESSION: was 60% \(30\/50\), now 83% \(50\/60\)/);
  });

  it('does NOT escalate an existing crawler whose count grew only because it found more real jobs (ratio unchanged)', () => {
    // Regression case: galenica grew from 12 -> 270 total jobs while its
    // no-structure ratio stayed ~flat (92% -> 99.6%). The old count-based
    // check (269 > 11) falsely flagged this as a regression.
    const report: Record<string, Entry> = {
      'galenica': makeEntry(269, 270),
    };
    const baseline = {
      generatedAt: '2026-05-06T00:00:00Z',
      perCrawler: { 'galenica': { noStructureCount: 11, total: 12 } },
    };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['galenica'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT escalate an existing crawler whose ratio stayed at 100% while volume grew', () => {
    const report: Record<string, Entry> = {
      'rss-surselva': makeEntry(19, 19),
    };
    const baseline = {
      generatedAt: '2026-05-06T00:00:00Z',
      perCrawler: { 'rss-surselva': { noStructureCount: 15, total: 15 } },
    };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['rss-surselva'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT escalate a NEW crawler with only 5 jobs at 100% flat', () => {
    const report: Record<string, Entry> = {
      'tiny-crawler': makeEntry(5, 5),
    };
    const baseline = { generatedAt: null, perCrawler: {} };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['tiny-crawler'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT escalate when the count IMPROVED (went DOWN) vs baseline', () => {
    const report: Record<string, Entry> = {
      'improving': makeEntry(20, 50),
    };
    const baseline = {
      generatedAt: '2026-05-06T00:00:00Z',
      perCrawler: { 'improving': { noStructureCount: 40, total: 50 } },
    };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['improving'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('skips entries that have no no-structured-content issue', () => {
    const report: Record<string, Entry> = {
      'thin-only': {
        total: 10,
        severity: 'WARNING',
        issues: [{ type: 'thin-description', count: 5, total: 10, message: '5/10 thin' }],
      },
    };
    const baseline = { generatedAt: null, perCrawler: {} };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['thin-only'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT escalate a NEW crawler at 90% flat (below the 95% threshold)', () => {
    const report: Record<string, Entry> = {
      'borderline': makeEntry(9, 10),
    };
    const baseline = { generatedAt: null, perCrawler: {} };

    const regressions = applyNoStructureRatchet(report, baseline);

    expect(report['borderline'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });
});

describe('source-detail fidelity checks', () => {
  it('accepts equivalent locality forms without accepting a canton-only overlap', () => {
    expect(sourceLocationMatches('Pfäffikon', 'Pfäffikon, Zürich')).toBe(true);
    expect(sourceLocationMatches('Visp', 'CH - Visp')).toBe(true);
    expect(sourceLocationMatches('St. Moritz', 'Sankt Moritz')).toBe(true);
    expect(sourceLocationMatches('Ginevra', 'Geneva (GVA)')).toBe(true);
    expect(sourceLocationMatches('Zürich', 'Klinik Lengg AG | Bleulerstrasse 60 | 8008 Zürich, Zürich')).toBe(true);
    expect(sourceLocationMatches('Kriens', 'Kreuzstrasse 34 6010 Kriens')).toBe(true);
    expect(sourceLocationMatches('Pfäffikon', 'Pfäffikon Zürich')).toBe(true);
    expect(sourceLocationMatches('Lengghalde 2, Zürich', 'Zürich, Zürich')).toBe(true);
    expect(sourceLocationMatches('Sede Stabio Svizzera', 'Stabio, 2106')).toBe(true);
    expect(sourceLocationMatches('Bern', 'CHE-BE Bern')).toBe(true);
    expect(sourceLocationMatches('Zürich', 'Winterthur, Zürich')).toBe(false);
    expect(sourceLocationMatches('Bern', 'Lyss, Bern Grossraum')).toBe(false);
    expect(sourceLocationMatches('Lugano', 'Pfäffikon, Zürich')).toBe(false);
    expect(sourceLocationMatches('Basel', 'Basel-Landschaft')).toBe(false);
    expect(sourceLocationMatches('Appenzell', 'Appenzell Ausserrhoden')).toBe(false);
  });

  it('matches certain Swiss multilingual locality aliases bidirectionally', () => {
    for (const aliases of [
      ['Genève', 'Genf', 'Ginevra', 'Geneva'],
      ['Fribourg', 'Freiburg', 'Friburgo'],
      ['Biel', 'Bienne', 'Bienne-Biel'],
      ['Chur', 'Coira', 'Cuira'],
    ]) {
      for (const left of aliases) {
        for (const right of aliases) expect(sourceLocationMatches(left, right), `${left} ↔ ${right}`).toBe(true);
      }
    }
    expect(sourceLocationMatches('Fribourg', 'Freiburg im Breisgau')).toBe(false);
    expect(sourceLocationMatches('Biel', 'Biel-Benken')).toBe(false);
    expect(sourceLocationMatches('Chur', 'Churwalden')).toBe(false);
  });

  it('distinguishes authoritative location markup from generic page chrome', () => {
    const jsonLd = '<script type="application/ld+json">{"@type":"JobPosting","title":"Role","jobLocation":{"address":{"addressLocality":"Lugano","addressRegion":"Ticino"}}}</script>';
    expect(classifySourceLocationEvidence(jsonLd, 'https://example.test/job')).toBe('jsonld');
    for (const className of [
      'job-location', 'job_location', 'job-detail-location', 'job_detail_location',
      'job-region', 'job_region', 'job-detail-region', 'job_detail_region',
      'vacancy-location', 'vacancy_location', 'vacancy-detail-location', 'vacancy_detail_location',
      'vacancy-region', 'vacancy_region', 'vacancy-detail-region', 'vacancy_detail_region',
    ]) {
      expect(classifySourceLocationEvidence(`<div class="${className}">Lugano</div>`), className).toBe('strong-markup');
    }
    expect(classifySourceLocationEvidence('<article class="job-detail"><span itemprop="addressLocality">Geneva</span></article>')).toBe('strong-markup');
    expect(classifySourceLocationEvidence('<footer><span itemprop="addressLocality">Zürich</span></footer>')).toBe('generic');
    expect(classifySourceLocationEvidence('<div role="region"><span class="aria-jobDescRegionHeader-hidden">Stellenbeschreibung</span></div>')).toBe('generic');
    expect(classifySourceLocationEvidence('<nav><div class="location">Search by Location</div></nav>')).toBe('generic');
  });

  it('binds addressLocality to its job-scoped container instead of a footer', () => {
    const html = [
      '<footer><span itemprop="addressLocality">Zürich</span></footer>',
      '<article class="job-detail"><span itemprop="addressLocality">Geneva</span></article>',
    ].join('');
    expect(extractSourceLocationObservation(html)).toEqual({
      location: 'Geneva',
      evidence: 'strong-markup',
    });
    expect(extractSourceLocationObservation('<div class="job-detail-location">Lugano</div>')).toEqual({
      location: 'Lugano',
      evidence: 'strong-markup',
    });
  });

  it('does not promote related cards or search results as the current vacancy location', () => {
    for (const html of [
      '<section class="job-search-results"><article><span class="job-location">Zürich</span></article></section>',
      '<aside class="related-card"><span class="job-detail-location">Zürich</span></aside>',
      '<div class="job-recommendations"><span itemprop="addressLocality">Zürich</span></div>',
    ]) {
      expect(extractSourceLocationObservation(html)).toEqual({ location: '', evidence: 'generic' });
      const result = compareSourceDetail(
        { location: 'Lugano', description: 'Descrizione completa '.repeat(20) },
        { location: 'Zürich', description: 'Descrizione completa '.repeat(20) },
        { locationEvidence: classifySourceLocationEvidence(html) },
      );
      expect(result.locationMismatch).toBe(false);
      expect(result.locationInconclusive).toBe(true);
    }
  });

  it('does not turn generic page labels into location contradictions', () => {
    const result = compareSourceDetail(
      { location: 'Lausanne', sourceLang: 'fr', description: 'Description complète '.repeat(20) },
      { location: 'Rechercher par lieu', description: 'Description complète '.repeat(20) },
      { locationEvidence: 'generic' },
    );
    expect(result.locationMismatch).toBe(false);
    expect(result.locationInconclusive).toBe(true);
  });

  it('keeps authoritative organization-labelled locations as contradictions', () => {
    for (const [publishedLocation, sourceLocation] of [
      ['Geneva', 'Kantonsspital Aarau, Aarau'],
      ['Lugano', 'HFR Fribourg / HFR Freiburg'],
    ]) {
      const result = compareSourceDetail(
        { location: publishedLocation, sourceLang: 'de', description: 'Ausführliche Stellenbeschreibung '.repeat(20) },
        { location: sourceLocation, description: 'Ausführliche Stellenbeschreibung '.repeat(20) },
        { locationEvidence: 'jsonld' },
      );
      expect(result.locationMismatch, sourceLocation).toBe(true);
      expect(result.locationInconclusive, sourceLocation).toBe(false);
    }
  });

  it('prefers a corroborated Kanton Zürich listing workplace over administrative JSON-LD', () => {
    const result = compareSourceDetail(
      {
        addressLocality: 'Dietikon',
        sourceLang: 'de',
        description: 'Ausführliche Stellenbeschreibung '.repeat(20),
      },
      {
        title: 'Sozialarbeiter/in im kjz Dietikon',
        location: 'Horgen',
        description: 'Ausführliche Stellenbeschreibung '.repeat(20),
      },
      {
        locationEvidence: 'jsonld',
        locationPolicy: 'listing-workplace-over-admin-jsonld',
      },
    );

    expect(result.locationMismatch).toBe(false);
    expect(result.locationAuthority).toBe('listing-workplace');
  });

  it('keeps a Kanton Zürich mismatch when the detail title does not corroborate the listing', () => {
    const result = compareSourceDetail(
      {
        addressLocality: 'Dietikon',
        sourceLang: 'de',
        description: 'Ausführliche Stellenbeschreibung '.repeat(20),
      },
      {
        title: 'Sozialarbeiter/in im kjz Horgen',
        location: 'Horgen',
        description: 'Ausführliche Stellenbeschreibung '.repeat(20),
      },
      {
        locationEvidence: 'jsonld',
        locationPolicy: 'listing-workplace-over-admin-jsonld',
      },
    );

    expect(result.locationMismatch).toBe(true);
    expect(result.locationAuthority).toBe('source-detail');
  });

  it('applies the listing-workplace contract only to kanton-zuerich source checks', async () => {
    const html = fs.readFileSync(
      path.join(process.cwd(), 'tests/fixtures/kanton-zuerich-source-detail-admin-location.html'),
      'utf8',
    );
    const description = 'Ausführliche Stellenbeschreibung '.repeat(20);
    const items = ['kanton-zuerich', 'another-solique-crawler'].map((crawlerKey) => ({
      crawlerKey,
      url: `https://example.test/${crawlerKey}`,
      job: { addressLocality: 'Dietikon', sourceLang: 'de', description },
    }));
    const results = await checkSourceDetailsBatch(items, 2, {
      fetchPage: async (url: string) => ({
        ok: true,
        status: 200,
        url,
        body: html,
        host: 'example.test',
      }),
    });

    expect(results[0]).toMatchObject({
      crawlerKey: 'kanton-zuerich',
      sourceLocation: 'Horgen, ZH',
      locationMismatch: false,
      locationAuthority: 'listing-workplace',
    });
    expect(results[1]).toMatchObject({
      crawlerKey: 'another-solique-crawler',
      sourceLocation: 'Horgen, ZH',
      locationMismatch: true,
      locationAuthority: 'source-detail',
    });
  });

  it('flags a wrong published location and a thin published description', () => {
    const result = compareSourceDetail(
      { location: 'Lugano', sourceLang: 'de', description: 'Polymechaniker in Lugano' },
      { location: 'Pfäffikon, Zürich', description: 'Aufgaben Installation, Inbetriebnahme und Wartung von Maschinen. '.repeat(5) },
      { locationEvidence: 'jsonld' },
    );
    expect(result.locationMismatch).toBe(true);
    expect(result.locationInconclusive).toBe(false);
    expect(result.descriptionMismatch).toBe(true);
  });

  it('does not flag a sufficiently faithful source description', () => {
    const description = 'Installation, Inbetriebnahme und Wartung von Maschinen. '.repeat(8);
    const result = compareSourceDetail(
      { location: 'Pfäffikon', sourceLang: 'de', description },
      { location: 'Pfäffikon, Zürich', description },
    );
    expect(result.locationMismatch).toBe(false);
    expect(result.descriptionMismatch).toBe(false);
  });

  it('accounts for worker exceptions separately from network failures and makes strict fail', async () => {
    const items = [
      { crawlerKey: 'fixture', url: 'https://example.test/network', job: { location: 'Lugano' } },
      { crawlerKey: 'fixture', url: 'https://example.test/processing', job: { location: 'Lugano' } },
    ];
    const results = await checkSourceDetailsBatch(items, 2, {
      fetchPage: async (url: string) => {
        if (url.endsWith('/network')) throw new TypeError('network unavailable');
        return { ok: true, status: 200, url, body: '<main>fixture</main>', host: 'example.test' };
      },
      extractDetail: () => {
        throw new Error('parser exploded at /sensitive/source/file and https://internal.invalid/token');
      },
    });

    expect(results).toHaveLength(items.length);
    expect(results[0]).toMatchObject({ crawlerKey: 'fixture', fetchFailed: true, status: 0 });
    expect(results[0].processingFailed).not.toBe(true);
    expect(results[1]).toMatchObject({ crawlerKey: 'fixture', processingFailed: true });
    expect(results[1].fetchFailed).not.toBe(true);
    expect(results[1].processingError).not.toMatch(/sensitive|internal\.invalid/);

    const report = { fixture: { total: 2, issues: [], severity: 'OK' } };
    const summary = applySourceDetailResults(report, results, items.length);
    expect(summary.requested).toBe(summary.fetched + summary.fetchFailed + summary.processingFailed);
    expect(summary).toMatchObject({ requested: 2, fetched: 0, fetchFailed: 1, processingFailed: 1 });
    expect(report.fixture.severity).toBe('CRITICAL');
    expect(report.fixture.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'parse-error', count: 1, processingFailed: 1 }),
    ]));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-quality-processing-'));
    const outPath = path.join(dir, 'report.json');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(finishAudit(report, { strict: true, outPath, sourceDetailSummary: summary })).toBe(1);
      expect(JSON.parse(fs.readFileSync(outPath, 'utf8'))).toMatchObject({
        summary: { critical: 1 },
        sourceDetailSummary: { requested: 2, fetchFailed: 1, processingFailed: 1 },
        crawlers: { fixture: { severity: 'CRITICAL' } },
      });
    } finally {
      consoleSpy.mockRestore();
      errorSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the complete JSON report before returning a strict failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-quality-report-'));
    const outPath = path.join(dir, 'report.json');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = {
        broken: {
          total: 1,
          severity: 'CRITICAL',
          issues: [{ type: 'parse-error', message: 'broken fixture' }],
        },
      };
      const exitCode = finishAudit(report, {
        strict: true,
        outPath,
        provenance: { repoHeadSha: 'fixture', datasetLastCommit: { sha: 'fixture', committedAt: null } },
        urlChecksEnabled: false,
        sourceDetailChecksEnabled: true,
        sourceDetailSummary: {
          requested: 1,
          fetched: 1,
          fetchFailed: 0,
          authoritativeLocationChecks: 1,
          locationMatches: 0,
          locationMismatches: 1,
          inconclusiveLocationObservations: 0,
          descriptionMismatches: 0,
        },
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(fs.readFileSync(outPath, 'utf8'))).toMatchObject({
        crawlersChecked: 1,
        sourceDetailSummary: { locationMismatches: 1 },
        summary: { critical: 1, warning: 0, ok: 0 },
        crawlers: { broken: { severity: 'CRITICAL' } },
      });
    } finally {
      consoleSpy.mockRestore();
      errorSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('filledLocaleCount', () => {
  it('counts valid localized titles of ten characters or fewer', () => {
    expect(filledLocaleCount({
      it: 'Avvocato',
      en: 'Lawyer',
      de: 'Jurist/in',
      fr: 'Avocat',
    }, { minLength: 1 })).toBe(4);
  });

  it('does not count explicit placeholders as localized titles', () => {
    expect(filledLocaleCount({
      it: '-',
      en: 'N/A',
      de: 'TBD',
      fr: 'Avocat',
    }, { minLength: 1 })).toBe(1);
  });

  it('keeps the substantial-content threshold for localized descriptions', () => {
    expect(filledLocaleCount({ it: 'Avvocato', de: 'Descrizione completa' })).toBe(1);
  });
});

/**
 * The duplicate-description ratchet now distinguishes two signals:
 *   1. `duplicate-descriptions` (title-aware fingerprint, ≥80%) — real source
 *      duplicates: same title AND same body across multiple records.
 *   2. `duplicate-descriptions-desc-only` (chrome fingerprint, ≥95%) — chrome
 *      scraping: identical bodies across records with distinct titles.
 *
 * Motivating regression: Moncucco shipped 9/9 jobs with an identical 4 125-char
 * blob (the page nav/megamenu). The titles WERE distinct, so this is the chrome
 * case — both signals would have fired, but in a real run the chrome signal is
 * the one we want surfaced (the action item is "fix the parser selectors", not
 * "dedupe duplicate listings"). Tests below set both signals when simulating
 * the moncucco case to verify chrome-scraping detection still works.
 */
function makeDuplicateEntry(dupeCount: number, total: number, severity: Entry['severity'] = 'WARNING', kind: 'chrome' | 'listings' = 'chrome'): Entry {
  // Default to chrome-style: distinct titles, identical bodies. Only the
  // hidden desc-only signal fires; the visible duplicate-descriptions issue
  // is synthesized by the ratchet itself when chrome is detected.
  const issues: Entry['issues'] = [];
  if (kind === 'listings') {
    issues.push({
      type: 'duplicate-descriptions',
      count: dupeCount,
      total,
      message: `${dupeCount}/${total} duplicate descriptions`,
    });
  } else {
    issues.push({
      type: 'duplicate-descriptions-desc-only',
      count: dupeCount,
      total,
      message: '',
      hidden: true,
    });
  }
  return {
    total,
    severity,
    issues,
  };
}

describe('applyDuplicateDescriptionRatchet', () => {
  it('escalates a crawler with 100% duplicate descriptions and >=5 jobs to CRITICAL', () => {
    const report: Record<string, Entry> = {
      'moncucco-style': makeDuplicateEntry(9, 9),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['moncucco-style'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ key: 'moncucco-style', count: 9, total: 9, kind: 'chrome-scraping' });
    expect(regressions[0].ratio).toBeCloseTo(1, 5);
    // The chrome path synthesizes a visible duplicate-descriptions issue and
    // appends the chrome warning to its message. The original hidden chrome
    // signal stays in issues[0]; the visible message is the non-hidden one.
    const visible = report['moncucco-style'].issues.find((i) => !i.hidden);
    expect(visible?.message).toMatch(/PARSER LIKELY GRABBING CHROME/);
    expect(report['moncucco-style'].action).toMatch(/page chrome/i);
  });

  it('escalates at exactly 80% duplicate ratio with >=5 jobs (title-aware listings signal)', () => {
    // 80% is the threshold for the title-aware "duplicate listings" signal,
    // which catches feeds publishing the same role multiple times (bitfinex
    // posts each opening 9× via Recruitee). Chrome scraping uses a stricter
    // 95% threshold to avoid false-positives on legitimately templated
    // sources (reboot-monkey: 142 city-specific listings sharing a template).
    const report: Record<string, Entry> = {
      'eighty-pct': makeDuplicateEntry(8, 10, 'WARNING', 'listings'),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['eighty-pct'].severity).toBe('CRITICAL');
    expect(regressions).toHaveLength(1);
    expect(regressions[0].kind).toBe('duplicate-listings');
  });

  it('does NOT escalate below 80% duplicate ratio', () => {
    const report: Record<string, Entry> = {
      'mild-dupes': makeDuplicateEntry(7, 10),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['mild-dupes'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT escalate small crawlers (<5 jobs) even at 100% duplicate', () => {
    const report: Record<string, Entry> = {
      'tiny': makeDuplicateEntry(4, 4),
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['tiny'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('skips crawlers with no duplicate-descriptions issue', () => {
    const report: Record<string, Entry> = {
      'no-dupes': { total: 20, severity: 'OK', issues: [] },
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['no-dupes'].severity).toBe('OK');
    expect(regressions).toHaveLength(0);
  });

  it('preserves an existing action prefix when escalating', () => {
    const entry = makeDuplicateEntry(10, 10, 'WARNING');
    entry.action = 'Existing hint.';
    const report: Record<string, Entry> = { 'with-action': entry };

    applyDuplicateDescriptionRatchet(report);

    expect(report['with-action'].action).toMatch(/^Existing hint\. /);
    expect(report['with-action'].action).toMatch(/page chrome/i);
  });

  it('does NOT false-positive on templated sources (chrome signal between 80% and 95%)', () => {
    // reboot-monkey case: 142 city-specific data-center-technician listings
    // sharing a templated body. Title-aware fingerprint dropped the duplicate
    // ratio from 90% to 41% (each city → distinct title). The chrome signal
    // (desc-only) is still ~90%, but a templated parser should not be flagged
    // as chrome scraping unless duplicates are essentially universal (≥95%).
    const report: Record<string, Entry> = {
      'templated-source': {
        total: 142,
        severity: 'WARNING',
        issues: [
          { type: 'duplicate-descriptions', count: 58, total: 142, message: '58/142 duplicate descriptions' },
          { type: 'duplicate-descriptions-desc-only', count: 128, total: 142, message: '', hidden: true },
        ],
      },
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['templated-source'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });

  it('does NOT false-positive when TWO distinct templates sum past 95% but neither dominates alone (#3721 new-yorker)', () => {
    // new-yorker case: 50/55 jobs share one "Verkaufsmitarbeiter" template
    // (six title variants — 80%/70%/60%/50%/100% workload + "Aushilfe" — all
    // templated identically) and 3/55 share a separate "Filialleitung"
    // template. Two genuinely distinct real per-role templates. The old
    // sum-based count (50 + 3 = 53/55 = 96%) tripped the ≥95% chrome ratchet;
    // the corrected count uses the LARGEST single bucket (50/55 = 91%),
    // which stays below the threshold.
    const report: Record<string, Entry> = {
      'new-yorker': {
        total: 55,
        severity: 'WARNING',
        issues: [
          { type: 'duplicate-descriptions-desc-only', count: 50, total: 55, message: '', hidden: true },
        ],
      },
    };

    const regressions = applyDuplicateDescriptionRatchet(report);

    expect(report['new-yorker'].severity).toBe('WARNING');
    expect(regressions).toHaveLength(0);
  });
});

describe('fingerprintsForCrawler (location-aware title-aware mode)', () => {
  // Regression: fielmann (Workday store-chain) ships the same role title verbatim
  // across many stores — 37 "Augenoptiker (w/m/d)" across 35 cities with a
  // templated body. The original title-only fingerprint collided on all of them
  // (82% "duplicate listings") and tripped the ≥80% ratchet to CRITICAL even
  // though each is a legitimate distinct per-store opening. Including the
  // location in the fingerprint keeps them distinct.
  const templatedBody =
    'Wir suchen für unseren Standort eine Augenoptikerin oder einen Augenoptiker. ' +
    'Sie beraten unsere Kundschaft und führen Sehtests durch. Wir bieten ein modernes Umfeld.';

  function storeListing(city: string) {
    return { title: 'Augenoptiker (w/m/d)', description: templatedBody, location: city };
  }

  it('does NOT collide for the same templated role across distinct cities', () => {
    const jobs = ['Lugano', 'Zürich', 'Bern', 'Genève', 'Chur', 'Sion'].map(storeListing);
    const dupes = countDuplicates(fingerprintsForCrawler(jobs, 'title-aware'));
    expect(dupes).toBe(0);
  });

  it('STILL flags the same role re-posted at the SAME city (real duplicate)', () => {
    // Same title + same body + same location twice = a genuine duplicate listing.
    const jobs = [
      storeListing('Lugano'),
      storeListing('Lugano'),
      storeListing('Zürich'),
      storeListing('Bern'),
    ];
    const dupes = countDuplicates(fingerprintsForCrawler(jobs, 'title-aware'));
    expect(dupes).toBe(2); // the two Lugano postings
  });

  it('desc-only mode stays location-blind (chrome-scraping signal intact)', () => {
    // Chrome scraping makes every body identical regardless of title OR location;
    // the desc-only fingerprint must still collapse them so the ≥95% chrome
    // ratchet keeps firing.
    const jobs = [
      { title: 'Role A', description: templatedBody, location: 'Lugano' },
      { title: 'Role B', description: templatedBody, location: 'Zürich' },
      { title: 'Role C', description: templatedBody, location: 'Bern' },
    ];
    const dupes = countDuplicates(fingerprintsForCrawler(jobs, 'desc-only'));
    expect(dupes).toBe(3);
  });
});

describe('largestDuplicateBucket', () => {
  it('returns the full count for a single universal blob (true chrome-scraping)', () => {
    const jobs = Array.from({ length: 9 }, (_, i) => ({
      title: `Role ${i}`,
      description: 'Same nav/footer chrome text on every job page.',
      location: `City ${i}`,
    }));
    const fps = fingerprintsForCrawler(jobs, 'desc-only');
    expect(largestDuplicateBucket(fps)).toBe(9);
  });

  it('returns the size of the LARGEST bucket, not the sum, when two distinct templates exist (#3721 new-yorker)', () => {
    const verkaufTemplate = 'DAS SIND WIR Als erfolgreiches Young Fashion Unternehmen ist NEW YORKER... (Verkauf role duties)';
    const filialleitungTemplate = 'DAS SIND WIR Als erfolgreiches Young Fashion Unternehmen ist NEW YORKER... (Filialleitung role duties, distinct from Verkauf)';
    const verkaufJobs = Array.from({ length: 50 }, (_, i) => ({
      title: `MITARBEITER (M/W/D) IM VERKAUF ${i % 5 === 0 ? '80%' : '50%'}`,
      description: verkaufTemplate,
      location: `Store ${i}`,
    }));
    const filialleitungJobs = Array.from({ length: 3 }, (_, i) => ({
      title: 'Stellvertretende Filialleitung (m/w/d)',
      description: filialleitungTemplate,
      location: `Store ${i}`,
    }));
    const jobs = [...verkaufJobs, ...filialleitungJobs];
    const fps = fingerprintsForCrawler(jobs, 'desc-only');
    // Sum across both buckets (53) would trip a ≥95% sum-based threshold on
    // 55 total; the largest single bucket (50) stays below it.
    expect(countDuplicates(fps)).toBe(53);
    expect(largestDuplicateBucket(fps)).toBe(50);
  });
});

describe('hasFormChrome', () => {
  // Each pattern came from the 2026-05-18 Centiel After-Sales Technician
  // regression: the regex-split parser ran past the last accordion and
  // swept in WordPress Contact Form 7 widget HTML + footer chrome.
  it('flags the wpcf7 form-control class', () => {
    expect(hasFormChrome('Some text wpcf7-form-control here')).toBe(true);
  });

  it('flags the privacy-checkbox label verbatim', () => {
    expect(hasFormChrome('I agree to the treatment of my personal information.')).toBe(true);
  });

  it('flags the exact CV-upload field label', () => {
    expect(hasFormChrome('Attachment: CV in PDF format, maximum weight 3 Mb')).toBe(true);
  });

  it('flags the "A brief presentation *" placeholder', () => {
    expect(hasFormChrome('A brief presentation *')).toBe(true);
  });

  it('flags the CORPORATE ENQUIRIES footer block', () => {
    expect(hasFormChrome('CORPORATE ENQUIRIES Media & Investor Enquiries')).toBe(true);
  });

  it('does NOT flag legitimate apply-instruction copy from a role PDF', () => {
    // The Centiel role PDFs all end with this sentence. It is legitimate
    // role content (the apply-to address) and must not trigger the chrome
    // signal — that would force a parser fix where none is needed.
    const pdfTail = 'If you identify with this role, please send your application, indicating "After-Sales Technician" in the subject line, to: hr@hq.centiel.com';
    expect(hasFormChrome(pdfTail)).toBe(false);
  });

  it('does NOT flag a generic role description', () => {
    const desc = 'We are looking for a Senior Engineer to join our team in Lugano. Responsibilities include designing systems, reviewing code, and mentoring junior engineers.';
    expect(hasFormChrome(desc)).toBe(false);
  });
});

describe('effectiveDescription (issue #3432 — burkhalter-group false positive)', () => {
  it('prefers descriptionByLocale over a stale/thin top-level description', () => {
    const richIt =
      'Per il nostro cliente cerchiamo un elettricista qualificato con esperienza in impianti industriali. ' +
      'Le responsabilità includono la manutenzione, la diagnosi guasti e la posa di nuovi impianti elettrici in tutta la regione.';
    const job = {
      // Stale placeholder left behind by a crawler re-run that failed to
      // refresh the top-level field (the burkhalter-group merge-function gap).
      description: 'Elettricista presso Burkhalter, Lugano',
      descriptionByLocale: { it: richIt, en: '', de: '', fr: '' },
    };
    expect(effectiveDescription(job)).toBe(richIt);
  });

  it('checks locales in it, en, de, fr order and returns the first rich candidate', () => {
    const richEn =
      'We are looking for a qualified electrician with experience in industrial installations. ' +
      'Responsibilities include maintenance, fault diagnosis, and installation of new electrical systems.';
    const job = {
      description: 'thin',
      descriptionByLocale: { it: 'troppo corto', en: richEn, de: '', fr: '' },
    };
    expect(effectiveDescription(job)).toBe(richEn);
  });

  it('falls back to the top-level description when no locale slot is rich enough', () => {
    const job = {
      description: 'the only content available',
      descriptionByLocale: { it: 'corto', en: '', de: '', fr: '' },
    };
    expect(effectiveDescription(job)).toBe('the only content available');
  });

  it('falls back to the top-level description when descriptionByLocale is absent', () => {
    const job = { description: 'legacy-only job with no locale map' };
    expect(effectiveDescription(job)).toBe('legacy-only job with no locale map');
  });

  it('falls back to an empty string when neither field carries content', () => {
    expect(effectiveDescription({})).toBe('');
    expect(effectiveDescription(null)).toBe('');
  });
});
