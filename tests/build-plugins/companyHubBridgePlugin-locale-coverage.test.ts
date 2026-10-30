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
import { autoDiscoverCompanyHubs, companyHubBridgePlugin } from '../../build-plugins/companyHubBridgePlugin';

describe('companyHubBridgePlugin — autoDiscoverCompanyHubs locale coverage (#3310)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeCrawlerFixture(company: string, companyKey?: string): string {
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
            ...(companyKey ? { companyKey } : {}),
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

  it('preserves archived company identities in every locale without advertising expired jobs as active', async () => {
    const rootDir = makeCrawlerFixture('Current Clinic SA', 'current-clinic');
    const archivedDir = path.join(rootDir, 'data/jobs/expired/by-crawler');
    fs.mkdirSync(archivedDir, { recursive: true });
    const records = [
      { company: 'Bieri Elektrotechnik AG', companyKey: 'burkhalter-group', canton: 'SO' },
      { company: 'Arsanté (Clinique de Carouge) — Centre Médical de Lancy', companyKey: 'arsante-clinique-de-carouge', canton: 'GE' },
      { company: 'CURRENT CLINIC SA', companyKey: 'current-clinic', canton: 'GE' },
      { company: 'Capri Holdings (Michael Kors / Versace)', companyKey: 'capri-holdings', canton: 'TI' },
      { company: '' }, null,
    ];
    fs.writeFileSync(path.join(archivedDir, 'fixture.json'), JSON.stringify(records));
    fs.writeFileSync(path.join(archivedDir, 'ignored-locale-cache.json'), JSON.stringify([{ company: 'Scratch Employer' }]));
    fs.writeFileSync(path.join(archivedDir, 'ignored.json.cleanup-tmp.json'), JSON.stringify([{ company: 'Scratch Employer' }]));
    fs.writeFileSync(path.join(archivedDir, 'wrong-envelope.json'), JSON.stringify({ jobs: [{ company: 'Wrong Shape' }] }));
    fs.writeFileSync(path.join(archivedDir, 'broken.json'), '{');

    const hubs = autoDiscoverCompanyHubs(rootDir);
    for (const slug of ['bieri-elektrotechnik-ag', 'burkhalter-group', 'arsante-clinique-de-carouge-centre-medical-de-lancy']) {
      expect(hubs.filter((entry) => entry.companySlug === slug).map((entry) => entry.locale).sort()).toEqual(['de', 'en', 'fr', 'it']);
    }
    expect(hubs.filter((entry) => entry.companySlug === 'current-clinic-sa')).toHaveLength(4);
    expect(hubs.filter((entry) => entry.companySlug === 'current-clinic-sa').every((entry) => entry.displayName === 'Current Clinic SA')).toBe(true);
    expect(hubs.some((entry) => ['scratch-employer', 'wrong-shape'].includes(entry.companySlug))).toBe(false);
    expect(hubs.filter((entry) => entry.companySlug === 'michael-kors')).toHaveLength(4);

    fs.mkdirSync(path.join(rootDir, 'dist'));
    const plugin = companyHubBridgePlugin(rootDir) as unknown as { closeBundle: { handler: () => Promise<void> } };
    await plugin.closeBundle.handler();
    for (const entry of hubs.filter((entry) => entry.companySlug === 'bieri-elektrotechnik-ag')) {
      const html = fs.readFileSync(path.join(rootDir, 'dist', new URL(entry.url).pathname, 'index.html'), 'utf8');
      expect(/<link rel=(?:"canonical"|canonical) href="([^"]+)"/.exec(html)?.[1]).toBe(entry.url);
      expect(html).not.toContain('data-company-canton-fallback');
      expect(html).not.toMatch(/<meta[^>]+http-equiv="refresh"/i);
    }
    const italian = fs.readFileSync(path.join(rootDir, 'dist/cerca-lavoro-ticino/azienda-bieri-elektrotechnik-ag/index.html'), 'utf8');
    expect(italian).toContain('Nessun annuncio di Bieri Elektrotechnik AG in Ticino');
    const brandTarget = fs.readFileSync(path.join(rootDir, 'dist/cerca-lavoro-ticino/azienda-michael-kors/index.html'), 'utf8');
    expect(brandTarget).toContain('Nessun annuncio di Michael Kors in Ticino');
  });

  it('consolidates the verified malformed Banca Cler archive label without dropping legitimate long company names', async () => {
    const rootDir = makeCrawlerFixture('Banca Cler', 'banca-cler');
    const archivedDir = path.join(rootDir, 'data/jobs/expired/by-crawler');
    fs.mkdirSync(archivedDir, { recursive: true });
    // The archived Data Scientist vacancy retains companyKey banca-cler and
    // German slug data-scientist-w-m-banca-cler despite this corrupted label.
    const malformed = '. Dein neuer Job Erfassen, Modellieren und Verarbeiten von strukturierten sowie unstrukturierten Daten Durchführen von Ad-hoc-Analysen und A';
    const alias = 'dein-neuer-job-erfassen-modellieren-und-verarbeiten-von-strukturierten-sowie-unstrukturierten-daten-durchfuhren-von-ad-hoc-analysen-und-a';
    const legitimate = 'Arsanté (Clinique de Carouge) — Centre de Pédiatrie Eaux-Vives Gare';
    fs.writeFileSync(path.join(archivedDir, 'banca-cler.json'), JSON.stringify([
      { company: malformed, companyKey: 'banca-cler', canton: 'BS' },
      { company: legitimate, companyKey: 'arsante-clinique-de-carouge', canton: 'GE' },
    ]));
    const hubs = autoDiscoverCompanyHubs(rootDir);
    const aliases = hubs.filter((entry) => entry.companySlug === alias);
    expect(aliases).toHaveLength(4);
    // Display-name and stable-key URLs both survive in all four locales.
    expect(hubs.filter((entry) => entry.displayName === legitimate)).toHaveLength(8);
    fs.mkdirSync(path.join(rootDir, 'dist'));
    const plugin = companyHubBridgePlugin(rootDir) as unknown as { closeBundle: { handler: () => Promise<void> } };
    await plugin.closeBundle.handler();
    for (const entry of aliases) {
      const aliasPath = new URL(entry.url).pathname;
      const target = aliasPath.replace(alias, 'banca-cler');
      const html = fs.readFileSync(path.join(rootDir, 'dist', aliasPath, 'index.html'), 'utf8');
      expect(html).toContain(`href="https://frontaliereticino.ch${target}"`);
      expect(html).toMatch(/name="robots" content="noindex,\s*follow"/);
      expect(html).not.toContain('"@type":"JobPosting"');
      const primary = fs.readFileSync(path.join(rootDir, 'dist', target, 'index.html'), 'utf8');
      expect(primary).toContain('Banca Cler');
      expect(primary).not.toContain(malformed);
      expect(primary).not.toMatch(/name="robots" content="noindex/);
    }
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

  it('seeds every company identity in a crawler slice, not only its first record (#8108)', () => {
    const rootDir = makeCrawlerFixture('La Posta Svizzera', 'posta-svizzera-centro-regionale');
    const crawlerPath = path.join(rootDir, 'data', 'jobs', 'by-crawler', 'fixture-crawler.json');
    fs.writeFileSync(
      crawlerPath,
      JSON.stringify({
        crawlerKey: 'fixture-crawler',
        assembledAt: new Date().toISOString(),
        jobs: [
          {
            id: 'post-1',
            company: 'La Posta Svizzera',
            companyKey: 'posta-svizzera-centro-regionale',
            canton: 'TI',
          },
          {
            id: 'post-2',
            company: 'Die Schweizerische Post',
            companyKey: 'posta-svizzera-centro-regionale',
            canton: 'TI',
          },
          {
            id: 'tpl-1',
            company: 'TPL - Trasporti Pubblici Luganesi',
            companyKey: 'tpl-lugano',
            canton: 'TI',
          },
        ],
      }),
      'utf-8',
    );

    const hubs = autoDiscoverCompanyHubs(rootDir);
    for (const [slug, displayName] of [
      ['die-schweizerische-post', 'Die Schweizerische Post'],
      ['tpl-trasporti-pubblici-luganesi', 'TPL - Trasporti Pubblici Luganesi'],
    ] as const) {
      const matches = hubs.filter((hub) => hub.companySlug === slug);
      expect(matches).toHaveLength(4);
      expect(new Set(matches.map((hub) => hub.displayName))).toEqual(new Set([displayName]));
    }
  });
});

/**
 * CF edge-404 audit follow-up — company-hub bridge slug-seed gap.
 *
 * Root cause (confirmed): `autoDiscoverCompanyHubs` seeded a bridge entry
 * ONLY for `slugifyCompanyName(company)` (the display-name slug). Almost
 * half the crawler universe (204/414 companies, spot-checked live) has a
 * `companyKey` that diverges from that display-name slug — e.g. company
 * "Ostschweizer Kinderspital" / companyKey "kispi-sg" — because companyKey
 * is often a shorter/older stable id, sometimes the literal legacy URL slug
 * that got indexed/linked before the display name changed or before brand
 * folding was introduced. Any historically-indexed
 * `/cerca-lavoro-ticino/azienda-kispi-sg/`-shaped URL for such a company
 * never got a bridge candidate from this source and dead-ended at the
 * origin (verified live: origin 404, only a generic canton-root 301 from
 * the Cloudflare Worker's fallback layer, never the company's actual hub).
 *
 * Fix: also seed the companyKey-derived slug (when present and different
 * from the display-name slug) for every locale.
 */
describe('companyHubBridgePlugin — autoDiscoverCompanyHubs seeds legacy companyKey slug', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeCrawlerFixtureWithKey(company: string, companyKey: string): string {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-hub-bridge-key-test-'));
    tmpDirs.push(rootDir);
    const crawlerDir = path.join(rootDir, 'data', 'jobs', 'by-crawler');
    fs.mkdirSync(crawlerDir, { recursive: true });
    fs.writeFileSync(
      path.join(crawlerDir, `${companyKey}.json`),
      JSON.stringify({
        crawlerKey: companyKey,
        assembledAt: new Date().toISOString(),
        jobs: [{ id: 'fixture-1', company, companyKey, canton: 'SG' }],
      }),
      'utf-8',
    );
    return rootDir;
  }

  it('seeds both the display-name slug AND the companyKey slug when they diverge (real kispi-sg case)', () => {
    const rootDir = makeCrawlerFixtureWithKey('Ostschweizer Kinderspital', 'kispi-sg');
    const hubs = autoDiscoverCompanyHubs(rootDir);

    const nameSlugHubs = hubs.filter((h) => h.companySlug === 'ostschweizer-kinderspital');
    const keySlugHubs = hubs.filter((h) => h.companySlug === 'kispi-sg');

    expect(nameSlugHubs.length).toBe(4);
    expect(keySlugHubs.length).toBe(4);
    const itEntry = keySlugHubs.find((h) => h.locale === 'it');
    expect(itEntry?.url).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-kispi-sg/');
    expect(itEntry?.displayName).toBe('Ostschweizer Kinderspital');
  });

  it('does not double-seed when companyKey and the display-name slug are the same', () => {
    const rootDir = makeCrawlerFixtureWithKey('Air Zermatt', 'air-zermatt');
    const hubs = autoDiscoverCompanyHubs(rootDir).filter((h) => h.companySlug === 'air-zermatt');
    expect(hubs.length).toBe(4); // one per locale, not doubled
  });

  it('is a no-op when companyKey is absent (legacy fixtures without the field keep working)', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-hub-bridge-no-key-test-'));
    tmpDirs.push(rootDir);
    const crawlerDir = path.join(rootDir, 'data', 'jobs', 'by-crawler');
    fs.mkdirSync(crawlerDir, { recursive: true });
    fs.writeFileSync(
      path.join(crawlerDir, 'fixture-crawler.json'),
      JSON.stringify({
        crawlerKey: 'fixture-crawler',
        assembledAt: new Date().toISOString(),
        jobs: [{ id: 'fixture-1', company: 'No Key Co', canton: 'SO' }],
      }),
      'utf-8',
    );
    const hubs = autoDiscoverCompanyHubs(rootDir).filter((h) => h.companySlug === 'no-key-co');
    expect(hubs.length).toBe(4);
  });
});

describe('companyHubBridgePlugin — legacy aliases stay canton-scoped', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not replace an empty canton filter with the Switzerland-wide employer profile', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-hub-profile-alias-test-'));
    tmpDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, 'data', 'jobs', 'by-crawler'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'data', 'jobs', 'by-crawler', 'nestle.json'),
      JSON.stringify({
        crawlerKey: 'nestle',
        assembledAt: new Date().toISOString(),
        jobs: [{ id: 'nestle-1', company: 'Nestlé', companyKey: 'nestle', canton: 'VD' }],
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'data', 'employer-profiles.json'),
      JSON.stringify({
        profiles: [{ slug: 'nestle', name: 'Nestlé', cantons: [{ name: 'VD', count: 58 }] }],
      }),
      'utf-8',
    );

    const canonicalProfilePath = path.join(rootDir, 'dist', 'aziende', 'nestle', 'index.html');
    fs.mkdirSync(path.dirname(canonicalProfilePath), { recursive: true });
    fs.writeFileSync(
      canonicalProfilePath,
      '<!doctype html><html><head><link rel="canonical" href="https://frontaliereticino.ch/aziende/nestle/"></head>' +
        '<body><main data-profile-list><article class="jc-card">Nestlé job</article>' +
        '<li class="ft-infeed-ad">ad</li></main></body></html>',
      'utf-8',
    );

    const plugin = companyHubBridgePlugin(rootDir) as unknown as {
      closeBundle: { handler: () => Promise<void> };
    };
    await plugin.closeBundle.handler();

    const legacyPath = path.join(
      rootDir,
      'dist',
      'cerca-lavoro-ticino',
      'azienda-nestle',
      'index.html',
    );
    const legacyHtml = fs.readFileSync(legacyPath, 'utf-8');
    expect(legacyHtml).toContain('Nessun annuncio di Nestlé in Ticino');
    expect(legacyHtml).toMatch(/robots[^>]+index,\s*follow/);
    expect(legacyHtml).toContain('href="https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-nestle/"');
    expect(legacyHtml).toContain('data-company-canton-fallback');
    expect(legacyHtml).toContain('58 annunci');
    expect(legacyHtml).toContain('href="https://frontaliereticino.ch/cerca-lavoro-vaud/azienda-nestle/"');
    expect(legacyHtml).not.toContain('data-profile-list');
    expect(legacyHtml).not.toContain('ft-infeed-ad');
    expect(legacyHtml).not.toContain('href="https://frontaliereticino.ch/aziende/nestle/"');
    expect(legacyHtml).not.toContain('history.replaceState');
  });

  it('localizes the empty state and nearest-canton banner for non-Ticino sections', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-hub-non-ti-test-'));
    tmpDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'data', 'jobs', 'by-crawler'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'data', 'jobs', 'by-crawler', 'nestle.json'),
      JSON.stringify({
        crawlerKey: 'nestle',
        assembledAt: new Date().toISOString(),
        jobs: [
          { id: 'nestle-be-1', company: 'Nestlé', companyKey: 'nestle', canton: 'BE' },
          { id: 'nestle-vd-1', company: 'Nestlé', companyKey: 'nestle', canton: 'VD' },
        ],
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'data', 'employer-profiles.json'),
      JSON.stringify({
        profiles: [{ slug: 'nestle', name: 'Nestlé', cantons: [{ name: 'VD', count: 58 }, { name: 'BE', count: 10 }] }],
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'data', 'gsc-company-hubs.json'),
      JSON.stringify({
        hubs: [{
          locale: 'it',
          companySlug: 'nestle',
          url: 'https://frontaliereticino.ch/cerca-lavoro-vaud/azienda-nestle/',
          kind: 'unmatched',
          displayName: 'Nestlé',
          jobCount: 0,
        }],
      }),
      'utf-8',
    );

    const plugin = companyHubBridgePlugin(rootDir) as unknown as {
      closeBundle: { handler: () => Promise<void> };
    };
    await plugin.closeBundle.handler();

    const legacyPath = path.join(rootDir, 'dist', 'cerca-lavoro-vaud', 'azienda-nestle', 'index.html');
    const legacyHtml = fs.readFileSync(legacyPath, 'utf-8');
    expect(legacyHtml).toContain('Nessun annuncio di Nestlé in Vaud');
    expect(legacyHtml).toContain('Non risultano annunci attivi di Nestlé in Vaud');
    expect(legacyHtml).toContain('data-company-canton-fallback');
    expect(legacyHtml).toContain('10 annunci');
    expect(legacyHtml).toContain('href="https://frontaliereticino.ch/cerca-lavoro-berna/azienda-nestle/"');
    expect(legacyHtml).not.toContain('Nessun annuncio di Nestlé in Ticino');
  });
});
