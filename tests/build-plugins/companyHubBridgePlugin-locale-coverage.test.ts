/**
 * Issue #3310 — company-hub bridge locale coverage.
 *
 * Root cause (confirmed, NOT the "missing translation" hypothesis in the
 * issue): `autoDiscoverCompanyHubs()` in `companyHubBridgePlugin.ts` seeded
 * a bridge entry ONLY for locale `it` from the crawler universe
 * (`data/jobs/by-crawler/*.json`). A company whose en/de/fr bridge URLs
 * weren't already present in `data/gsc-job-urls.json` /
 * `data/orphan-pages-audit.json` (e.g. `solothurner-spitaeler`, canonical
 * hub slug `solothurner-spitaler-soh`) therefore got a live IT
 * `/cerca-lavoro-ticino/azienda-solothurner-spitaler-soh/` bridge page but a
 * real 404 on the en/de/fr equivalents — even though the underlying job
 * records have complete `descriptionByLocale` for every locale (translation
 * was never missing; this is a locale-scope bug in the bridge's
 * auto-discovery, not a content-gating bug).
 *
 * This test seeds a temp `data/jobs/by-crawler/` directory with a single
 * company and asserts `autoDiscoverCompanyHubs` now returns an entry for
 * all 4 locales (it/en/de/fr), not just `it`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { autoDiscoverCompanyHubs } from '../../build-plugins/companyHubBridgePlugin';

describe('companyHubBridgePlugin — autoDiscoverCompanyHubs locale coverage (#3310)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeCrawlerFixture(company: string): string {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-hub-bridge-test-'));
    tmpDirs.push(rootDir);
    const crawlerDir = path.join(rootDir, 'data', 'jobs', 'by-crawler');
    fs.mkdirSync(crawlerDir, { recursive: true });
    fs.writeFileSync(
      path.join(crawlerDir, 'fixture-crawler.json'),
      JSON.stringify({
        crawlerKey: 'fixture-crawler',
        assembledAt: new Date().toISOString(),
        jobs: [
          {
            id: 'fixture-1',
            company,
            canton: 'SO',
            description: 'IT description only, no translations backfilled yet.',
          },
        ],
      }),
      'utf-8',
    );
    return rootDir;
  }

  it('seeds a bridge entry for every locale (it/en/de/fr), not just it', () => {
    const rootDir = makeCrawlerFixture('Solothurner Spitäler (soH)');
    const hubs = autoDiscoverCompanyHubs(rootDir);

    const bySlug = hubs.filter((h) => h.companySlug === 'solothurner-spitaler-soh');
    const locales = new Set(bySlug.map((h) => h.locale));

    expect(locales.has('it')).toBe(true);
    expect(locales.has('en')).toBe(true);
    expect(locales.has('de')).toBe(true);
    expect(locales.has('fr')).toBe(true);
    expect(bySlug.length).toBe(4);
  });

  it('every seeded locale gets a distinct, correctly-prefixed URL and a non-empty display name (safe fallback content, never thin)', () => {
    const rootDir = makeCrawlerFixture('Solothurner Spitäler (soH)');
    const hubs = autoDiscoverCompanyHubs(rootDir).filter(
      (h) => h.companySlug === 'solothurner-spitaler-soh',
    );

    const expectedUrlFragment: Record<string, string> = {
      it: '/cerca-lavoro-ticino/azienda-solothurner-spitaler-soh/',
      en: '/en/find-jobs-ticino/company-solothurner-spitaler-soh/',
      de: '/de/jobs-im-tessin/unternehmen-solothurner-spitaler-soh/',
      fr: '/fr/trouver-emploi-tessin/entreprise-solothurner-spitaler-soh/',
    };

    for (const [locale, fragment] of Object.entries(expectedUrlFragment)) {
      const entry = hubs.find((h) => h.locale === locale);
      expect(entry, `missing bridge entry for locale ${locale}`).toBeDefined();
      expect(entry!.url).toBe(`https://frontaliereticino.ch${fragment}`);
      expect(entry!.displayName).toBe('Solothurner Spitäler (soH)');
      expect(entry!.kind).toBe('unmatched');
    }
  });

  it('does not regress: a company already covered by GSC/orphan-audit discovery for a given locale still resolves to one entry per locale key', () => {
    // Even with two crawler files sharing the same canonical company slug,
    // discovery must not duplicate the (locale, slug) key.
    const rootDir = makeCrawlerFixture('Solothurner Spitäler (soH)');
    const crawlerDir = path.join(rootDir, 'data', 'jobs', 'by-crawler');
    fs.writeFileSync(
      path.join(crawlerDir, 'fixture-crawler-2.json'),
      JSON.stringify({
        crawlerKey: 'fixture-crawler-2',
        assembledAt: new Date().toISOString(),
        jobs: [{ id: 'fixture-2', company: 'Solothurner Spitäler (soH)', canton: 'SO' }],
      }),
      'utf-8',
    );
    const hubs = autoDiscoverCompanyHubs(rootDir).filter(
      (h) => h.companySlug === 'solothurner-spitaler-soh',
    );
    expect(hubs.length).toBe(4); // still exactly one per locale, no duplicates
  });
});
