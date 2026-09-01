import { afterEach, describe, expect, it, vi } from 'vitest';
import { looksLikeShortLabelValue, extractCompanyFromText, extractLocationFromText, __testables } from '../scripts/lib/shared-jobs-crawler.mjs';

const { buildKnownJobUrlsSet } = __testables;

describe('generic link discovery — quote-balanced hrefs (#6574)', () => {
  const { absoluteLinks, absoluteSameHostLinks } = __testables;
  const baseUrl = 'https://careers.example.ch/jobs/';
  const href = "/jobs/dell'impiego?role=R&D&level=2#apply";

  it('keeps apostrophes, query parameters and non-leading anchors in absoluteLinks', () => {
    const links = absoluteLinks(
      `<a onclick="window.location.href='/jobs/decoy'" class='job' data-kind="detail" href="${href}">Lavoro</a>`
        + '<a href="#navigation">Indice</a>',
      baseUrl,
    );
    expect(links).toEqual([`https://careers.example.ch${href}`]);
  });

  it('does the same for same-host hinted links and ignores fragment-only anchors', () => {
    const links = absoluteSameHostLinks(
      `<a href="${href}" class='job' data-template='href="/jobs/decoy"'>Offerta d'impiego</a>`
        + '<a href="#jobs">Jobs</a>'
        + '<a href="https://other.example/jobs/42">Jobs</a>',
      baseUrl,
      /(job|offerta)/i,
    );
    expect(links).toEqual([`https://careers.example.ch${href}`]);
  });
});

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

describe('toJobFromJsonLd — declared addressCountry outranks the adapter seed canton', () => {
  const { toJobFromJsonLd, isJsonLdCountryExplicitlyForeign } = __testables;

  const DESCRIPTION = [
    'We are looking for an experienced advisor to join the team.',
    'You will manage a portfolio of clients and report to the branch lead.',
    'Requirements: 5 years of experience, excellent communication skills,',
    'fluent English and a relevant degree.',
  ].join(' ');

  const DETAIL_URL = 'https://careers.example.com/job/48219-wealth-management-advisor';

  // A Ticino-scoped adapter seed: exactly the shape that used to stamp `TI`
  // onto every posting the seed returned, whatever the posting itself said.
  const TICINO_SEED = { canton: 'TI', location: 'Lugano', company: 'Example Insurance (sede Ticino)' };

  function node(address: Record<string, unknown> | Record<string, unknown>[]) {
    return {
      '@type': 'JobPosting',
      title: 'Wealth Management Advisor',
      description: DESCRIPTION,
      hiringOrganization: { name: 'Example Insurance' },
      jobLocation: Array.isArray(address)
        ? address.map((a) => ({ '@type': 'Place', address: a }))
        : { '@type': 'Place', address },
    };
  }

  it('rejects a posting that declares a non-CH country, instead of tagging it with the seed canton', () => {
    // Springfield is not on any foreign-city blacklist, so the pre-existing
    // string checks cannot catch this posting — asserting the exact reason
    // proves the addressCountry rule is what fired, not an earlier guard.
    const result = toJobFromJsonLd(
      node({ addressLocality: 'Springfield', addressRegion: 'Illinois', addressCountry: 'United States of America' }),
      'Example Insurance',
      DETAIL_URL,
      { seedMeta: TICINO_SEED },
    );
    expect(result.job).toBe(null);
    expect(result.reason).toBe('jsonld_address_country_foreign');
  });

  it('rejects it for the same reason when the country arrives as a Country object rather than a string', () => {
    const result = toJobFromJsonLd(
      // Springfield again, so the country OBJECT is the only foreign signal.
      node({ addressLocality: 'Springfield', addressCountry: { '@type': 'Country', name: 'Canada' } }),
      'Example Insurance',
      DETAIL_URL,
      { seedMeta: TICINO_SEED },
    );
    expect(result.job).toBe(null);
    expect(result.reason).toBe('jsonld_address_country_foreign');
  });

  it('leaves the seed canton winning when the posting declares no country at all', () => {
    // Zürich locality against a TI seed: with no declared country the seed
    // still wins, exactly as before the fix. Absence is not evidence.
    const result = toJobFromJsonLd(
      node({ addressLocality: 'Zürich' }),
      'Example Insurance',
      DETAIL_URL,
      { seedMeta: TICINO_SEED },
    );
    expect(result.job).not.toBe(null);
    expect(result.job.canton).toBe('TI');
  });

  it('changes nothing when an explicit CH country agrees with the seed', () => {
    const result = toJobFromJsonLd(
      node({ addressLocality: 'Lugano', addressRegion: 'Ticino', addressCountry: 'CH' }),
      'Example Insurance',
      DETAIL_URL,
      { seedMeta: TICINO_SEED },
    );
    expect(result.job).not.toBe(null);
    expect(result.job.canton).toBe('TI');
  });

  it('accepts the spelled-out and alpha-3 Swiss spellings as CH', () => {
    for (const country of ['Switzerland', 'Schweiz', 'Svizzera', 'Suisse', 'CHE', '756']) {
      const result = toJobFromJsonLd(
        node({ addressLocality: 'Lugano', addressCountry: country }),
        'Example Insurance',
        DETAIL_URL,
        { seedMeta: TICINO_SEED },
      );
      expect(result.job, `expected ${country} to be accepted as CH`).not.toBe(null);
      expect(result.job.canton).toBe('TI');
    }
  });

  it('keeps a multi-site posting when any one of its locations is Swiss', () => {
    const result = toJobFromJsonLd(
      node([
        { addressLocality: 'Milano', addressCountry: 'Italy' },
        { addressLocality: 'Lugano', addressCountry: 'CH' },
      ]),
      'Example Insurance',
      DETAIL_URL,
      { seedMeta: TICINO_SEED },
    );
    expect(result.job).not.toBe(null);
    expect(result.job.canton).toBe('TI');
  });

  describe('canton codes that collide with ISO country codes stay ambiguous, never foreign', () => {
    // FR/GR/LU/BE/NE/SO/SG/TG/AR/GL/SZ/BS are simultaneously ISO country codes
    // and Swiss canton codes. Reading a bare colliding token as a country would
    // delete legitimate Fribourg, Graubünden and Luzern jobs — the exact
    // "potential damage" this rule must not cause.
    for (const [code, locality] of [
      ['FR', 'Fribourg'],
      ['GR', 'Chur'],
      ['LU', 'Luzern'],
      ['BE', 'Bern'],
    ] as const) {
      it(`keeps a posting whose addressCountry is the bare code "${code}"`, () => {
        const result = toJobFromJsonLd(
          node({ addressLocality: locality, addressCountry: code }),
          'Example Insurance',
          DETAIL_URL,
          { seedMeta: { canton: code, location: locality, company: 'Example Insurance' } },
        );
        expect(result.job).not.toBe(null);
        expect(result.job.canton).toBe(code);
      });
    }

    it('still rejects the unambiguous spelled-out name of a colliding country', () => {
      const result = toJobFromJsonLd(
        node({ addressLocality: 'Munsbach', addressCountry: 'Luxembourg' }),
        'Example Insurance',
        DETAIL_URL,
        { seedMeta: TICINO_SEED },
      );
      expect(result.job).toBe(null);
      expect(result.reason).toBe('jsonld_address_country_foreign');
    });
  });

  describe('isJsonLdCountryExplicitlyForeign — the predicate in isolation', () => {
    const withCountry = (addressCountry: unknown) => ({ jobLocation: { address: { addressCountry } } });

    it('treats a missing country as no evidence', () => {
      expect(isJsonLdCountryExplicitlyForeign({})).toBe(false);
      expect(isJsonLdCountryExplicitlyForeign({ jobLocation: {} })).toBe(false);
      expect(isJsonLdCountryExplicitlyForeign({ jobLocation: { address: {} } })).toBe(false);
      expect(isJsonLdCountryExplicitlyForeign(withCountry(''))).toBe(false);
      expect(isJsonLdCountryExplicitlyForeign(withCountry(null))).toBe(false);
    });

    it('flags unambiguously foreign declarations', () => {
      for (const c of ['US', 'USA', 'Canada', 'IT', 'Italy', 'Germany', 'Poland', 'India', 'ES']) {
        expect(isJsonLdCountryExplicitlyForeign(withCountry(c)), `expected ${c} foreign`).toBe(true);
      }
    });

    it('never flags Switzerland, however it is spelled', () => {
      for (const c of ['CH', 'che', 'Switzerland', 'Schweiz', 'Suisse', 'Svizzera', 756, 'Switzerland (CH)']) {
        expect(isJsonLdCountryExplicitlyForeign(withCountry(c)), `expected ${c} Swiss`).toBe(false);
      }
    });

    it('never flags a token that is itself a Swiss canton', () => {
      for (const c of ['FR', 'GR', 'LU', 'BE', 'NE', 'SO', 'SG', 'TG', 'TI', 'Ticino', 'Fribourg']) {
        expect(isJsonLdCountryExplicitlyForeign(withCountry(c)), `expected ${c} ambiguous`).toBe(false);
      }
    });
  });
});

describe('toJobFromJsonLd — explicit adapter detail URLs', () => {
  const { toJobFromJsonLd } = __testables;
  const frenchFustUrl = 'https://jobs.fust.ch/postes-vacants/conseiller-de-vente/d7dc248c-e5eb-4e25-b42a-93c2a9e445d6';
  const node = {
    '@type': 'JobPosting',
    title: 'Conseillère ou conseiller de vente électroménager',
    description: 'Conseiller notre clientèle, gérer les commandes et travailler avec une équipe expérimentée. Exigences: expérience dans la vente et sens du service.',
    hiringOrganization: { name: 'Fust | Swiss Household Services AG' },
    jobLocation: {
      '@type': 'Place',
      address: {
        addressCountry: 'Suisse',
        addressLocality: 'Crissier',
        addressRegion: 'VD',
      },
    },
  };

  it('keeps the generic URL classifier strict for an undeclared French route', () => {
    expect(toJobFromJsonLd(node, 'Fust', frenchFustUrl)).toMatchObject({
      job: null,
      reason: 'jsonld_not_detail_url',
    });
  });

  it('accepts the same real posting when its adapter declares that exact detail URL', () => {
    const result = toJobFromJsonLd(node, 'Fust', frenchFustUrl, {
      isSeedDetail: true,
      seedMeta: { location: 'Crissier', canton: 'VD', company: 'Fust' },
    });
    expect(result.reason).toBeNull();
    expect(result.job).toMatchObject({
      url: frenchFustUrl,
      company: 'Fust',
      location: 'Crissier, VD',
      canton: 'VD',
    });
  });

  it('does not let a declared page bless a different JSON-LD URL', () => {
    expect(toJobFromJsonLd(
      { ...node, url: 'https://jobs.fust.ch/fr/carriere' },
      'Fust',
      frenchFustUrl,
      { isSeedDetail: true },
    )).toMatchObject({ job: null, reason: 'jsonld_not_detail_url' });
  });

  it('routes a detail-only adapter through JSON-LD even when its homepage is unavailable', async () => {
    const { processCompany, setCompanyAdaptersForTests } = __testables;
    setCompanyAdaptersForTests(new Map([['fust', {
      enabled: true,
      crawlerModes: ['html', 'jsonld'],
      seedDetailUrls: [frenchFustUrl],
      seedMetaByUrl: {
        [frenchFustUrl]: { location: 'Crissier', canton: 'VD', company: 'Fust' },
      },
    }]]));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === frenchFustUrl) {
        return new Response(
          `<script type="application/ld+json">${JSON.stringify(node)}</script>`,
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const result = await processCompany(
      { key: 'fust', name: 'Fust', website: 'https://www.fust.ch/', city: 'Oberbüren' },
      /(job|career|vacanc|stellen|emploi)/i,
      {
        sourceSeeds: { byDomain: {}, byName: {} },
        companyCrawlerMode: { fust: ['html', 'jsonld'] },
        webDiscoveryEnabled: false,
        minQualityScore: 0,
        minDescriptionChars: 0,
      },
    );

    expect(result.extractedJobs).toHaveLength(1);
    expect(result.extractedJobs[0]).toMatchObject({
      url: frenchFustUrl,
      companyKey: 'fust',
      canton: 'VD',
    });
    expect(result.filteredOutByReason.jsonld_not_detail_url).toBeUndefined();
    expect(result.scrapedJobPages).toBe(1);
  });
});

afterEach(() => {
  __testables.setCompanyAdaptersForTests(new Map());
  vi.restoreAllMocks();
});
