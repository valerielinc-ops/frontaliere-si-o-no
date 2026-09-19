import { afterEach, describe, expect, it, vi } from 'vitest';
import { looksLikeShortLabelValue, extractCompanyFromText, extractLocationFromText, __testables } from '../scripts/lib/shared-jobs-crawler.mjs';

const { buildKnownJobUrlsSet } = __testables;

describe('crawlWorkdayJobs — concrete Swiss location default (#9210)', () => {
  it('drops country-only records and keeps records with a concrete Swiss locality by default', async () => {
    const source = {
      endpoint: 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/jobs',
      origin: 'https://example.wd5.myworkdayjobs.com',
      appliedFacets: {},
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === source.endpoint) {
        return new Response(JSON.stringify({
          total: 2,
          jobPostings: [
            {
              title: 'Senior Finance Analyst',
              externalPath: '/job/Switzerland/senior-finance-analyst',
              locationsText: 'Switzerland',
              postedOn: 'Posted Today',
            },
            {
              title: 'Senior Finance Engineer',
              externalPath: '/job/Lugano/senior-finance-engineer',
              locationsText: 'Lugano, Switzerland',
              postedOn: 'Posted Today',
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    });

    const jobs = await __testables.crawlWorkdayJobs(
      { name: 'Example Company' },
      source,
      { aiLocalizationEnabled: false },
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Senior Finance Engineer',
      location: 'Lugano, Switzerland',
      canton: 'TI',
    });
  });
});

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

  it('reads the Italian workplace label used by the Coop detail page', () => {
    const html = `
      <html><body>
        <h1>Impiegata o impiegato del commercio al dettaglio</h1>
        <h4>Luogo di lavoro</h4>
        <p>Mendrisio</p>
      </body></html>
    `;
    expect(extractLocationFromText(html, '')).toBe('Mendrisio');
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
      applyUrl: frenchFustUrl,
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

  it('accepts a canonical/shortlink JSON-LD url variant carrying the same job identity (#7026 item 2)', () => {
    // Same UUID as frenchFustUrl, but under a `/s/{uuid}` shell that
    // isLikelyJobDetailUrl() does NOT recognise as a detail URL on its own
    // (no `/job/`, `/jobs/…`, `/vacanc…`, `/offene-stellen/…` etc. segment) —
    // so on the OLD code this is rejected via BOTH declaredSeedDetail (exact
    // string mismatch) AND the isLikelyJobDetailUrl() fallback, isolating the
    // new extractJobIdentityFromUrl() branch as what makes this pass.
    const shortlinkUrl = 'https://jobs.fust.ch/s/d7dc248c-e5eb-4e25-b42a-93c2a9e445d6';
    const result = toJobFromJsonLd(
      { ...node, url: shortlinkUrl },
      'Fust',
      frenchFustUrl,
      { isSeedDetail: true, seedMeta: { location: 'Crissier', canton: 'VD', company: 'Fust' } },
    );
    expect(result.reason).toBeNull();
    expect(result.job).toMatchObject({ company: 'Fust', canton: 'VD' });
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

describe('toJobFromJsonLd — employer workplace and multi-site locations (#9210)', () => {
  const { toJobFromJsonLd, toJobFromHtmlFallback } = __testables;
  const DESCRIPTION = [
    'We are looking for an experienced specialist to join the team.',
    'You will manage daily operations and collaborate with colleagues.',
    'Requirements: professional experience, excellent communication skills,',
    'fluent English and a relevant degree.',
  ].join(' ');

  const posting = (jobLocation: unknown) => ({
    '@type': 'JobPosting',
    title: 'Experienced Operations Specialist',
    description: DESCRIPTION,
    hiringOrganization: { name: 'Example Employer' },
    jobLocation,
  });

  it('chooses the Swiss ABB site from a multi-site JSON-LD posting and strips the canton suffix', () => {
    const result = toJobFromJsonLd(
      posting([
        {
          '@type': 'Place',
          address: {
            addressCountry: 'United States of America',
            addressLocality: 'Richmond',
            addressRegion: 'Virginia',
          },
        },
        {
          '@type': 'Place',
          address: {
            addressCountry: 'Switzerland',
            addressLocality: 'Quartino, Ticino',
            addressRegion: 'Ticino',
            postalCode: '6572',
            streetAddress: 'Via Luserte Sud 9',
          },
        },
      ]),
      'ABB',
      'https://careers.abb/global/en/job/ABB1GLOBALJR00045264EXTERNALENGLOBAL/R-D-Hardware-Engineer_JR00045264',
      { seedMeta: { location: 'Untersiggenthal, Aargau, Switzerland', canton: 'AG' } },
    );

    expect(result.job).toMatchObject({ location: 'Quartino', canton: 'TI' });
  });

  it('prefers the Coop workplace metadata over the administrative JSON-LD location', () => {
    const result = toJobFromJsonLd(
      posting({
        '@type': 'Place',
        address: {
          addressCountry: 'Svizzera',
          addressLocality: 'Gossau',
          addressRegion: 'Gossau',
          postalCode: '9200',
          streetAddress: 'Industriestrasse 109',
        },
      }),
      'Coop',
      'https://jobs.coopjobs.ch/posti-vacanti/impiegata-o-del-commercio-al-dettaglio/ec40ee71-3b7d-4a3a-8bd2-a593aa2df109',
      {
        isSeedDetail: true,
        seedMeta: {
          canton: 'TI',
          'sza_workplace.city': 'Mendrisio',
          'sza_workplace.zip': '6850',
          'sza_workplace.street': 'Via Ligornetto 1',
        },
      },
    );

    expect(result.job).toMatchObject({ location: 'Mendrisio', canton: 'TI' });
  });

  it('keeps the workplace city in the HTML fallback branch', () => {
    const html = `
      <html><head><title>Experienced Operations Specialist</title></head><body>
        <h1>Experienced Operations Specialist</h1>
        <h4>Luogo di lavoro</h4><p>Mendrisio</p>
        <h2>Responsabilità</h2>
        <p>In this role you will support daily operations, coordinate colleagues, and maintain reliable service for customers across the region.</p>
        <h2>Requisiti</h2>
        <p>Professional experience, good communication skills, attention to detail, and a relevant vocational or academic qualification are required.</p>
      </body></html>
    `;
    const result = toJobFromHtmlFallback(
      html,
      'https://jobs.coopjobs.ch/posti-vacanti/impiegata-o-del-commercio-al-dettaglio/ec40ee71-3b7d-4a3a-8bd2-a593aa2df109',
      'Coop',
      'Gossau',
      {
        isSeedDetail: true,
        seedMeta: { canton: 'TI', 'sza_workplace.city': 'Mendrisio' },
      },
    );

    expect(result.job).toMatchObject({ location: 'Mendrisio', canton: 'TI' });
  });

  it('keeps the historical Ticino fallback when no location field is readable', () => {
    const result = toJobFromJsonLd(
      posting({ '@type': 'Place', address: {} }),
      'Example Employer',
      'https://careers.example.com/job/experienced-operations-specialist',
      { seedMeta: { canton: 'TI' } },
    );

    expect(result.job).toMatchObject({ location: 'Ticino', canton: 'TI' });
  });
});

afterEach(() => {
  __testables.setCompanyAdaptersForTests(new Map());
  vi.restoreAllMocks();
});
