import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  assertCoopAdapterParity,
  assertCompleteCoopDiscovery,
  assertCoopSingleCompanyKeyScope,
  buildCoopAdapterConfig,
  ensureAdapterSeedUrls,
  fetchCoopJobDetailUrls,
  findUnrecognizedCoopDivisions,
  isCoopJob,
} from '../scripts/update-coop-jobs.mjs';
import { fingerprintJob } from '../scripts/lib/dedicated-crawler-common.mjs';
import { __testables as sharedCrawlerTestables } from '../scripts/lib/shared-jobs-crawler.mjs';
import {
  extractJsonLd,
  coopDescHtmlToMarkdown,
  validateCoopDescription,
  titleOverlap,
  applyCoopJsonLdToJob,
  applyCoopSourceDetailToJob,
  enrichCoopSourceBackedJobs,
  buildCoopTranslationCacheEntry,
} from '../scripts/lib/coop-job-parser.mjs';

const frenchDetailFixture = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'coop-french-detail.json'), 'utf8'),
);

describe('Coop authoritative detail routing', () => {
  it('publishes the feed allowlist only through explicit detail seeds', () => {
    const seedDetailUrls = [
      frenchDetailFixture.url,
      'https://jobs.coopjobs.ch/offene-stellen/verkaeuferin-verkaeufer/11111111-1111-4111-8111-111111111111',
      'https://jobs.coopjobs.ch/posti-vacanti/venditrice-venditore/22222222-2222-4222-8222-222222222222',
    ];
    const seedMetaByUrl = Object.fromEntries(seedDetailUrls.map((url) => [url, { canton: 'VD' }]));
    const updatedAt = 'fixed-for-test';
    const adapter = buildCoopAdapterConfig(
      { companyKey: 'coop-ticino', seedUrls: ['https://jobs.coopjobs.ch/stellenangebote'] },
      seedDetailUrls,
      seedMetaByUrl,
      updatedAt,
    );

    expect(adapter.seedUrls).toBeUndefined();
    expect(adapter.seedDetailUrls).toEqual(seedDetailUrls);
    expect(adapter.seedMetaByUrl).toEqual(seedMetaByUrl);
    expect(adapter.authoritativeDetailSnapshot).toBe(true);
    expect(adapter.authoritativeLifecycleDomains).toEqual(['jobs.coopjobs.ch']);
    expect(new Set(adapter.seedDetailUrls).size).toBe(seedDetailUrls.length);
    expect(buildCoopAdapterConfig(adapter, seedDetailUrls, seedMetaByUrl, updatedAt)).toEqual(adapter);
  });

  it('writes the feed allowlist atomically and fails closed on a stale or invalid adapter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-adapter-'));
    const adapterPath = path.join(tmpDir, 'coop-ticino.json');
    const urls = [frenchDetailFixture.url];
    const meta = { [urls[0]]: { canton: 'VD', location: 'Chavornay' } };

    expect(ensureAdapterSeedUrls(urls, meta, adapterPath)).toMatchObject({
      seedDetailUrls: urls,
      seedMetaByUrl: meta,
      authoritativeDetailSnapshot: true,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
    });

    fs.writeFileSync(adapterPath, '{ invalid json');
    expect(() => ensureAdapterSeedUrls(urls, meta, adapterPath)).toThrow();
  });

  it('compares adapter metadata structurally, independent of object key order', () => {
    const urls = [
      'https://jobs.coopjobs.ch/offene-stellen/one/11111111-1111-4111-8111-111111111111',
      'https://jobs.coopjobs.ch/offene-stellen/two/22222222-2222-4222-8222-222222222222',
    ];
    const expectedMeta = {
      [urls[0]]: { canton: 'ZH', location: 'Zurich' },
      [urls[1]]: { canton: 'BE', location: 'Bern' },
    };
    const reversedMeta = {
      [urls[1]]: { location: 'Bern', canton: 'BE' },
      [urls[0]]: { location: 'Zurich', canton: 'ZH' },
    };
    const adapter = buildCoopAdapterConfig({}, urls, reversedMeta, 'fixed-for-test');
    expect(assertCoopAdapterParity(adapter, urls, expectedMeta)).toBe(true);
  });

  it('accounts duplicate URLs, duplicate UUID aliases and malformed rows explicitly', async () => {
    const canonicalUrl = 'https://jobs.coopjobs.ch/offene-stellen/one/11111111-1111-4111-8111-111111111111';
    const aliasUrl = 'https://jobs.coopjobs.ch/postes-vacantes/un/11111111-1111-4111-8111-111111111111';
    const swissJob = (directlink) => ({
      links: { directlink },
      attributes: { '30': ['Zurigo'], '70': ['Coop Genossenschaft'] },
    });
    const jobs = [
      swissJob(canonicalUrl),
      swissJob(canonicalUrl),
      swissJob(aliasUrl),
      { links: {}, attributes: { '30': ['Zurigo'] } },
    ];
    const discovery = await fetchCoopJobDetailUrls({
      fetchImpl: async () => new Response(JSON.stringify({ total: jobs.length, jobs }), { status: 200 }),
    });

    expect(discovery).toMatchObject({
      apiTotal: 4,
      fetched: 4,
      urls: [canonicalUrl],
      droppedNonCh: 0,
      droppedMalformedUrl: 1,
      droppedDuplicateUrl: 1,
      droppedDuplicateIdentity: 1,
    });
    expect(assertCompleteCoopDiscovery(discovery)).toBe(true);
  });

  it('rejects a partial or internally inconsistent authoritative feed', () => {
    expect(() => assertCompleteCoopDiscovery({
      apiTotal: null,
      fetched: 0,
      droppedNonCh: 0,
      urls: [],
      seedMetaByUrl: {},
    })).toThrow(/did not expose a non-negative integer total/);

    expect(() => assertCompleteCoopDiscovery({
      apiTotal: 500,
      fetched: 499,
      droppedNonCh: 0,
      urls: Array.from({ length: 499 }, (_, index) => `https://jobs.coopjobs.ch/job/${index}`),
      seedMetaByUrl: {},
    })).toThrow(/fetched 499\/500/);

    expect(() => assertCompleteCoopDiscovery({
      apiTotal: 2,
      fetched: 2,
      droppedNonCh: 0,
      urls: ['https://jobs.coopjobs.ch/job/one'],
      seedMetaByUrl: { 'https://jobs.coopjobs.ch/job/one': { canton: 'ZH' } },
    })).toThrow(/discovery invariant failed/);

    const offHost = 'https://careers.example.com/job/55555555-5555-4555-8555-555555555555';
    expect(() => assertCompleteCoopDiscovery({
      apiTotal: 1,
      fetched: 1,
      droppedNonCh: 0,
      urls: [offHost],
      seedMetaByUrl: { [offHost]: { canton: 'ZH' } },
    })).toThrow(/trusted-hosts=false/);
  });

  it('fails closed on API total drift and on the pagination safety ceiling', () => {
    const url = 'https://jobs.coopjobs.ch/offene-stellen/one/88888888-8888-4888-8888-888888888888';
    const complete = {
      apiTotal: 1,
      fetched: 1,
      droppedNonCh: 0,
      droppedMalformedUrl: 0,
      droppedDuplicateUrl: 0,
      droppedDuplicateIdentity: 0,
      urls: [url],
      seedMetaByUrl: { [url]: { canton: 'ZH' } },
    };
    expect(() => assertCompleteCoopDiscovery({ ...complete, apiTotals: [1, 2] }))
      .toThrow(/totals=1,2/);
    expect(() => assertCompleteCoopDiscovery({
      ...complete,
      apiTotal: 10_001,
      apiTotals: [10_001],
      fetched: 10_000,
    })).toThrow(/fetched 10000\/10001/);
  });

  it('ages only feed-absent Coop identities across the homepage-to-ATS boundary', () => {
    const presentOldUrl = 'https://jobs.coopjobs.ch/offene-stellen/old-title/11111111-1111-4111-8111-111111111111';
    const presentFeedUrl = 'https://jobs.coopjobs.ch/postes-vacantes/new-title/11111111-1111-4111-8111-111111111111';
    const absentUrl = 'https://jobs.coopjobs.ch/offene-stellen/closed/22222222-2222-4222-8222-222222222222';
    const existing = [
      {
        id: 'present',
        companyKey: 'coop-ticino',
        source: 'Company Careers Crawler',
        url: presentOldUrl,
        crawlerMissStreak: 1,
        slug: 'present-route',
        previousSlugs: ['present-legacy-route'],
      },
      {
        id: 'absent',
        companyKey: 'coop-ticino',
        source: 'Company Careers Crawler',
        url: absentUrl,
        slug: 'absent-route',
        previousSlugs: ['absent-legacy-route'],
        previousSlugsByLocale: { fr: ['ancienne-route'] },
      },
      {
        id: 'sibling',
        companyKey: 'fust',
        source: 'Company Careers Crawler',
        url: 'https://jobs.coopjobs.ch/offene-stellen/fust/33333333-3333-4333-8333-333333333333',
      },
    ];
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': [fingerprintJob({ url: presentFeedUrl })],
      },
    };
    expect(fingerprintJob({ url: presentOldUrl })).toBe(fingerprintJob({ url: presentFeedUrl }));

    const first = sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(first.removed).toBe(0);
    expect(first.prunedExisting).toEqual([
      expect.objectContaining({ id: 'present', slug: 'present-route', previousSlugs: ['present-legacy-route'] }),
      expect.objectContaining({
        id: 'absent',
        crawlerMissStreak: 1,
        slug: 'absent-route',
        previousSlugs: ['absent-legacy-route'],
        previousSlugsByLocale: { fr: ['ancienne-route'] },
      }),
      existing[2],
    ]);
    expect(first.prunedExisting[0]).not.toHaveProperty('crawlerMissStreak');

    const second = sharedCrawlerTestables.pruneStaleCrawlerJobs(first.prunedExisting, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(second.prunedExisting.find((job) => job.id === 'absent')?.crawlerMissStreak).toBe(2);
    const third = sharedCrawlerTestables.pruneStaleCrawlerJobs(second.prunedExisting, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(third.removed).toBe(1);
    expect(third.prunedExisting.map((job) => job.id)).toEqual(['present', 'sibling']);
  });

  it('maps a legacy record without companyKey to the only scoped crawler key', () => {
    const url = 'https://jobs.coopjobs.ch/offene-stellen/legacy/55555555-5555-4555-8555-555555555555';
    const existing = [{
      id: 'legacy',
      company: 'Coop Genossenschaft',
      source: 'Company Careers Crawler',
      url,
      crawlerMissStreak: 1,
      previousSlugs: ['legacy-route'],
    }];
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
      authoritativeLegacyCompanyAliases: ['coop genossenschaft'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': [fingerprintJob({ url })],
      },
    };
    const { prunedExisting, removed } = sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(removed).toBe(0);
    expect(prunedExisting).toEqual([expect.objectContaining({ id: 'legacy', previousSlugs: ['legacy-route'] })]);
    expect(prunedExisting[0]).not.toHaveProperty('crawlerMissStreak');
    expect(prunedExisting[0].previousSlugs).toEqual(['legacy-route']);
  });

  it('does not scope a legacy sibling without companyKey to Coop', () => {
    const sibling = {
      id: 'legacy-jumbo',
      company: 'Jumbo, Division der Coop Genossenschaft',
      source: 'Company Careers Crawler',
      url: 'https://jobs.coopjobs.ch/offene-stellen/jumbo/99999999-9999-4999-8999-999999999999',
      previousSlugs: ['jumbo-legacy-route'],
    };
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch'],
      authoritativeLegacyCompanyAliases: ['coop', 'coop genossenschaft', 'coop city'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': ['id|coopjobs.ch|11111111-1111-4111-8111-111111111111'],
      },
    };
    expect(sharedCrawlerTestables.pruneStaleCrawlerJobs([sibling], [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    })).toEqual({ prunedExisting: [sibling], removed: 0 });
  });

  it('keeps authoritative fingerprints separated by lifecycle domain', () => {
    const coopUrl = 'https://jobs.coopjobs.ch/offene-stellen/coop/66666666-6666-4666-8666-666666666666';
    const otherUrl = 'https://careers.example.ch/job/77777777-7777-4777-8777-777777777777';
    const existing = [{
      id: 'coop-domain-only',
      companyKey: 'coop-ticino',
      source: 'Company Careers Crawler',
      url: coopUrl,
    }];
    const result = {
      companyKey: 'coop-ticino',
      companyDomain: 'coop.ch',
      processedCandidates: 1,
      authoritativeLifecycleDomains: ['jobs.coopjobs.ch', 'careers.example.ch'],
      authoritativeDetailFingerprintsByDomain: {
        'jobs.coopjobs.ch': [fingerprintJob({ url: otherUrl })],
        'careers.example.ch': [fingerprintJob({ url: coopUrl })],
      },
    };
    const { prunedExisting } = sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    });
    expect(prunedExisting[0].crawlerMissStreak).toBe(1);
  });

  it('does not apply cross-domain lifecycle to a non-authoritative feed', () => {
    const existing = [{
      id: 'kept',
      companyKey: 'coop-ticino',
      source: 'Company Careers Crawler',
      url: 'https://jobs.coopjobs.ch/offene-stellen/kept/44444444-4444-4444-8444-444444444444',
    }];
    const result = { companyKey: 'coop-ticino', companyDomain: 'coop.ch', processedCandidates: 1 };
    expect(sharedCrawlerTestables.pruneStaleCrawlerJobs(existing, [], [result], {
      scopeCompanyKeys: ['coop-ticino'],
    })).toEqual({ prunedExisting: existing, removed: 0 });
  });

  it('routes the representative French detail only when the feed declares it', () => {
    const seedMeta = { location: 'Chavornay', canton: 'VD', company: 'Coop Genossenschaft' };
    expect(sharedCrawlerTestables.toJobFromJsonLd(
      frenchDetailFixture.jsonLd,
      'Coop',
      frenchDetailFixture.url,
      { seedMeta },
    )).toMatchObject({ job: null, reason: 'jsonld_not_detail_url' });

    expect(sharedCrawlerTestables.toJobFromJsonLd(
      frenchDetailFixture.jsonLd,
      'Coop',
      frenchDetailFixture.url,
      { seedMeta, isSeedDetail: true },
    )).toMatchObject({
      reason: null,
      job: {
        url: frenchDetailFixture.url,
        company: 'Coop Genossenschaft',
        location: 'Chavornay, Vaud',
        canton: 'VD',
      },
    });
  });
});

// ──────────────────────────────────────────────────────────────
// Real HTML fixtures from Coop detail pages
// ──────────────────────────────────────────────────────────────

const FIXTURE_DETAIL1_JSONLD = `<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Detailhandelsfachfrau:mann / -assistent:in",
  "datePosted": "2025-09-26",
  "employmentType": "FULL_TIME",
  "description": "<p><div>Deine Aufgaben</div><br><ul><li>Du erhältst an 2 Tagen einen abwechslungsreichen Einblick in den Beruf.</li><li>Du darfst aktiv mitarbeiten.</li><li>Du lernst das Unternehmen kennen.</li></ul></p><br><p><div>Das bringst du mit</div><br><ul><li>Du bist interessiert den Lehrberuf kennen zu lernen.</li><li>Du bist motiviert und hast Freude am Umgang mit Kund:innen.</li><li>Du befindest dich in der 7. oder 8. Schulstufe.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Spannende Einblicke in die Welt des Detailhandels.</li><li>Persönliche Betreuung während der Schnupperlehre.</li><li>Die Möglichkeit, erste Berufserfahrungen zu sammeln.</li></ul></p>",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "Coop"
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "Schweiz",
      "addressLocality": "Dietlikon",
      "addressRegion": "Dietlikon"
    }
  }
}
</script>`;

const FIXTURE_DETAIL2_JSONLD = `<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Verkaufsberater:in Textil",
  "datePosted": "2026-03-05",
  "employmentType": "PART_TIME",
  "description": "<p><div>Aufgaben</div><br><ul><li>Mit deiner freundlichen und fachkompetenten Beratung begeisterst du unsere Kundschaft.</li><li>Du hältst dich an die internen Vorgaben und so stellst du sicher, dass die Waren attraktiv präsentiert sind.</li><li>Mit der Ware auf unserer Verkaufsfläche und im Lager gehst du sorgfältig um und du erledigst die anfallenden Unterhaltsarbeiten.</li></ul></p><br><p><div>Anforderungen</div><br><ul><li>Du besitzt eine abgeschlossene Grundbildung und hast Erfahrung im Detailhandel, vorzugsweise im Bekleidungsbereich.</li><li>Du bist eine kundenorientierte Persönlichkeit, die sich für Mode begeistert.</li><li>Du kommunizierst stilsicher in Deutsch und verfügst über weitere Sprachkenntnisse.</li><li>Du bist flexibel, motiviert und ein:e Teamplayer:in.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Abwechslungsreiche und verantwortungsvolle Tätigkeit.</li><li>Zeitgemässe Anstellungsbedingungen mit Personalrabatt und weiteren Benefits.</li><li>Gute Sozialleistungen und mindestens fünf Wochen Ferien.</li><li>Möglichkeiten sich persönlich und fachlich weiterzuentwickeln.</li></ul></p>",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "Coop City"
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "Schweiz",
      "addressLocality": "Chur",
      "addressRegion": "Graubünden"
    }
  }
}
</script>`;

const FIXTURE_DESC_HTML_1 = `<p><div>Deine Aufgaben</div><br><ul><li>Du erhältst an 2 Tagen einen abwechslungsreichen Einblick in den Beruf.</li><li>Du darfst aktiv mitarbeiten.</li><li>Du lernst das Unternehmen kennen.</li></ul></p><br><p><div>Das bringst du mit</div><br><ul><li>Du bist interessiert den Lehrberuf kennen zu lernen.</li><li>Du bist motiviert und hast Freude am Umgang mit Kund:innen.</li><li>Du befindest dich in der 7. oder 8. Schulstufe.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Spannende Einblicke in die Welt des Detailhandels.</li><li>Persönliche Betreuung während der Schnupperlehre.</li><li>Die Möglichkeit, erste Berufserfahrungen zu sammeln.</li></ul></p>`;

const FIXTURE_DESC_HTML_2 = `<p><div>Aufgaben</div><br><ul><li>Mit deiner freundlichen und fachkompetenten Beratung begeisterst du unsere Kundschaft.</li><li>Du hältst dich an die internen Vorgaben und so stellst du sicher, dass die Waren attraktiv präsentiert sind.</li><li>Mit der Ware auf unserer Verkaufsfläche und im Lager gehst du sorgfältig um und du erledigst die anfallenden Unterhaltsarbeiten.</li></ul></p><br><p><div>Anforderungen</div><br><ul><li>Du besitzt eine abgeschlossene Grundbildung und hast Erfahrung im Detailhandel, vorzugsweise im Bekleidungsbereich.</li><li>Du bist eine kundenorientierte Persönlichkeit, die sich für Mode begeistert.</li><li>Du kommunizierst stilsicher in Deutsch und verfügst über weitere Sprachkenntnisse.</li><li>Du bist flexibel, motiviert und ein:e Teamplayer:in.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Abwechslungsreiche und verantwortungsvolle Tätigkeit.</li><li>Zeitgemässe Anstellungsbedingungen mit Personalrabatt und weiteren Benefits.</li><li>Gute Sozialleistungen und mindestens fünf Wochen Ferien.</li><li>Möglichkeiten sich persönlich und fachlich weiterzuentwickeln.</li></ul></p>`;

// ──────────────────────────────────────────────────────────────
// extractJsonLd tests
// ──────────────────────────────────────────────────────────────

describe('extractJsonLd — Coop pages', () => {
  it('extracts JobPosting from detail page 1', () => {
    const ld = extractJsonLd(FIXTURE_DETAIL1_JSONLD);
    expect(ld).not.toBeNull();
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.title).toBe('Detailhandelsfachfrau:mann / -assistent:in');
  });

  it('extracts JobPosting from detail page 2', () => {
    const ld = extractJsonLd(FIXTURE_DETAIL2_JSONLD);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Verkaufsberater:in Textil');
    expect(ld.hiringOrganization.name).toBe('Coop City');
  });

  it('returns null for pages without JSON-LD', () => {
    expect(extractJsonLd('<html><body>No JSON-LD here</body></html>')).toBeNull();
  });

  // Markup-drift resilience — mirrors the permissive Straumann extractor so a
  // silent regex/`@type` miss never drops a recoverable Coop listing (#1792).
  it('tolerates single-quoted type attribute and reordered attributes', () => {
    const html = `<script data-x="1" type='application/ld+json'>
      {"@type":"JobPosting","title":"Single-quoted","description":"x"}
    </script>`;
    const ld = extractJsonLd(html);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Single-quoted');
  });

  it('matches @type as an array', () => {
    const html = `<script type="application/ld+json">
      {"@type":["JobPosting","WPHeader"],"title":"Array type"}
    </script>`;
    const ld = extractJsonLd(html);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Array type');
  });

  it('extracts JobPosting nested in @graph', () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebPage"},{"@type":"JobPosting","title":"Graph job"}]}
    </script>`;
    const ld = extractJsonLd(html);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Graph job');
  });
});

// ──────────────────────────────────────────────────────────────
// coopDescHtmlToMarkdown tests
// ──────────────────────────────────────────────────────────────

describe('coopDescHtmlToMarkdown', () => {
  it('converts detail 1 description to markdown ≥ 350 chars', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md.length).toBeGreaterThanOrEqual(350);
  });

  it('preserves section headers from detail 1', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).toContain('## Deine Aufgaben');
    expect(md).toContain('## Das bringst du mit');
    expect(md).toContain('## Was wir bieten');
  });

  it('preserves list items from detail 1', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).toContain('- Du erhältst an 2 Tagen');
    expect(md).toContain('- Du darfst aktiv mitarbeiten');
    expect(md).toContain('- Spannende Einblicke');
  });

  it('converts detail 2 description to markdown ≥ 400 chars', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md.length).toBeGreaterThanOrEqual(400);
  });

  it('preserves detail 2 sections', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md).toContain('## Aufgaben');
    expect(md).toContain('## Anforderungen');
    expect(md).toContain('## Was wir bieten');
  });

  it('preserves detail 2 content', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md).toContain('Beratung begeisterst du unsere Kundschaft');
    expect(md).toContain('Bekleidungsbereich');
    expect(md).toContain('Personalrabatt');
  });

  it('does not contain raw HTML tags', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).not.toMatch(/<(div|span|p|ul|li|br)\b/);
  });

  it('returns empty for empty input', () => {
    expect(coopDescHtmlToMarkdown('')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────
// validateCoopDescription tests
// ──────────────────────────────────────────────────────────────

describe('validateCoopDescription', () => {
  it('passes for detail 1 markdown', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    const result = validateCoopDescription(md, FIXTURE_DESC_HTML_1.length);
    expect(result.ok).toBe(true);
  });

  it('passes for detail 2 markdown', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    const result = validateCoopDescription(md, FIXTURE_DESC_HTML_2.length);
    expect(result.ok).toBe(true);
  });

  it('fails for very short description', () => {
    const result = validateCoopDescription('Short text', 1000);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('too short'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// titleOverlap tests
// ──────────────────────────────────────────────────────────────

describe('titleOverlap — Coop titles', () => {
  it('returns 1 for exact match', () => {
    expect(titleOverlap('Verkaufsberater:in Textil', 'Verkaufsberater:in Textil')).toBe(1);
  });

  it('handles colon-style Swiss German titles', () => {
    expect(
      titleOverlap('Detailhandelsfachfrau:mann / -assistent:in', 'Detailhandelsfachfrau:mann / -assistent:in')
    ).toBe(1);
  });

  it('returns high overlap when OG title adds company prefix', () => {
    // OG: "Coop City: Verkaufsberater:in Textil" vs stored: "Verkaufsberater:in Textil"
    expect(titleOverlap('Verkaufsberater:in Textil', 'Coop City: Verkaufsberater:in Textil')).toBeGreaterThanOrEqual(0.6);
  });

  it('returns low overlap for different roles', () => {
    expect(titleOverlap('Logistiker:in EBA', 'Verkaufsberater:in Textil')).toBeLessThan(0.5);
  });

  it('returns 1 for empty expected', () => {
    expect(titleOverlap('', 'anything')).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────
// applyCoopJsonLdToJob tests
// ──────────────────────────────────────────────────────────────

describe('applyCoopJsonLdToJob — location update from JSON-LD', () => {
  it('updates location and addressLocality when JSON-LD has different locality', () => {
    const job = {
      title: 'Verkaufsberater:in',
      location: 'Castione',
      addressLocality: 'Castione',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Canobbio',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.location).toBe('Canobbio');
    expect(updated.addressLocality).toBe('Canobbio');
    // Canton stays TI since "Ticino" normalizes to TI (same as before)
    expect(updated.canton).toBe('TI');
  });

  it('updates canton when JSON-LD addressRegion differs', () => {
    const job = {
      title: 'Logistiker:in',
      location: 'Ticino',
      addressLocality: 'Ticino',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Chur',
          addressRegion: 'Graubünden',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.location).toBe('Chur');
    expect(updated.addressLocality).toBe('Chur');
    expect(updated.canton).toBe('GR');
    expect(updated.addressRegion).toBe('GR');
  });

  it('updates company when JSON-LD has a more specific store name', () => {
    const job = {
      title: 'Verkaufsberater:in Textil',
      location: 'Chur',
      addressLocality: 'Chur',
      canton: 'GR',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Chur',
          addressRegion: 'Graubünden',
        },
      },
      hiringOrganization: { name: 'Coop City' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.company).toBe('Coop City');
  });

  it('does not update company when JSON-LD name is short (<=4 chars)', () => {
    const job = {
      title: 'Logistiker:in',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      company: 'Coop Ticino',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Lugano',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    // "Coop" is only 4 chars, should not replace "Coop Ticino"
    expect(updated.company).toBe('Coop Ticino');
  });

  it('returns changed=false when JSON-LD matches existing job data', () => {
    const job = {
      title: 'Test Job',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop City',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Lugano',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop City' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Lugano');
    expect(updated.company).toBe('Coop City');
  });

  it('handles null/missing JSON-LD gracefully', () => {
    const job = {
      title: 'Test',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      company: 'Coop',
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, null);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Lugano');
  });

  it('handles JSON-LD with empty jobLocation', () => {
    const job = {
      title: 'Test',
      location: 'Bellinzona',
      addressLocality: 'Bellinzona',
      canton: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {},
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Bellinzona');
  });
});

// ──────────────────────────────────────────────────────────────
// applyCoopJsonLdToJob — concurrency safety (follow-up #1883 item 2)
//
// The Coop post-process pass fetches/repairs jobs from a bounded pool of
// up to 12 concurrent workers (JOBS_COOP_DETAIL_CONCURRENCY in
// scripts/update-coop-jobs.mjs). That is only safe if applyCoopJsonLdToJob
// holds NO module-level mutable state (Map/Set/cache) and NEVER mutates the
// caller's `job` object — otherwise two workers could corrupt each other's
// jobs → wrong description/location assigned to the wrong listing across
// ~2200 pages. The function is currently a pure transform (shallow-copies via
// `{...job}` and returns `{ job, changed }`); these tests lock that invariant
// so a future refactor that introduces a shared cache fails loudly.
// ──────────────────────────────────────────────────────────────

describe('applyCoopJsonLdToJob — concurrency safety', () => {
  it('does not mutate the input job (returns a distinct object)', () => {
    const job = {
      title: 'Verkaufsberater:in',
      location: 'Castione',
      addressLocality: 'Castione',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop',
    };
    const snapshot = JSON.parse(JSON.stringify(job));
    const jsonLd = {
      jobLocation: { address: { addressLocality: 'Chur', addressRegion: 'Graubünden' } },
      hiringOrganization: { name: 'Coop City' },
    };
    const { job: updated } = applyCoopJsonLdToJob(job, jsonLd);
    // Original is untouched…
    expect(job).toEqual(snapshot);
    // …and the returned object is a different reference carrying the changes.
    expect(updated).not.toBe(job);
    expect(updated.addressLocality).toBe('Chur');
    expect(updated.company).toBe('Coop City');
  });

  it('keeps interleaved calls independent (no cross-call state leakage)', () => {
    // Simulate two pool workers whose calls interleave: build both inputs,
    // apply in alternating order, and assert neither result bleeds into the
    // other. A module-level cache keyed by anything shared would fail here.
    const jobA = { title: 'A', location: 'Lugano', addressLocality: 'Lugano', canton: 'TI', addressRegion: 'TI', company: 'Coop' };
    const jobB = { title: 'B', location: 'Bellinzona', addressLocality: 'Bellinzona', canton: 'TI', addressRegion: 'TI', company: 'Coop' };
    const ldA = { jobLocation: { address: { addressLocality: 'Chur', addressRegion: 'Graubünden' } }, hiringOrganization: { name: 'Coop City' } };
    const ldB = { jobLocation: { address: { addressLocality: 'Canobbio', addressRegion: 'Ticino' } }, hiringOrganization: { name: 'Coop Pronto' } };

    const r1 = applyCoopJsonLdToJob(jobA, ldA);
    const r2 = applyCoopJsonLdToJob(jobB, ldB);
    const r3 = applyCoopJsonLdToJob(jobA, ldA); // re-run A after B ran

    expect(r1.job.addressLocality).toBe('Chur');
    expect(r1.job.canton).toBe('GR');
    expect(r1.job.company).toBe('Coop City');

    expect(r2.job.addressLocality).toBe('Canobbio');
    expect(r2.job.canton).toBe('TI');
    expect(r2.job.company).toBe('Coop Pronto');

    // Deterministic: A produces the same result regardless of B running between.
    expect(r3.job).toEqual(r1.job);
  });
});

describe('Coop-family source-detail contract (#5253)', () => {
  const cases = [
    ['fust', 'https://jobs.fust.ch/offene-stellen/test/11111111-1111-4111-8111-111111111111', 'Oberbüren', 'St. Gallen', 'SG'],
    ['interdiscount', 'https://jobs.coopjobs.ch/offene-stellen/test/22222222-2222-4222-8222-222222222222', 'Jegenstorf', 'Jegenstorf', 'BE'],
    ['jumbo', 'https://jobs.coopjobs.ch/offene-stellen/test/33333333-3333-4333-8333-333333333333', 'Dietikon', 'Zürich', 'ZH'],
    ['volg-fenaco', 'https://jobs.fenaco.com/offene-stellen/test/44444444-4444-4444-8444-444444444444', 'Höri', 'Zürcher Unterland/Limmattal', 'ZH'],
  ] as const;
  const detailDescription = `<h2>Deine Aufgaben</h2><ul>${Array.from({ length: 26 }, (_, index) => `<li>Source-backed Aufgabe ${index + 1} mit Verantwortung und sorgfältiger Zusammenarbeit im Team.</li>`).join('')}</ul>`;

  function jsonLd(title: string, locality: string, region: string) {
    return {
      '@type': 'JobPosting',
      title,
      description: detailDescription,
      jobLocation: { address: { addressLocality: locality, addressRegion: region, addressCountry: 'Schweiz', postalCode: '3000', streetAddress: 'Detailstrasse 1' } },
    };
  }

  it.each(cases)('%s replaces listing fallbacks without changing identity or route history', (companyKey, url, locality, region, canton) => {
    const listing = {
      id: `${companyKey}-stable`, url, companyKey, title: 'Verkäuferin Verkäufer',
      description: 'Listing boilerplate that must disappear',
      descriptionByLocale: { de: 'Listing boilerplate that must disappear' },
      location: 'Fallback Hauptsitz', canton: 'TI', slug: `${companyKey}-stable-route`,
      slugByLocale: { de: `${companyKey}-stable-route` }, previousSlugs: [`${companyKey}-legacy`],
      previousSlugsByLocale: { de: [`${companyKey}-legacy-de`] }, sourceLang: 'de',
    };
    const identity = Object.fromEntries(['id', 'url', 'slug', 'slugByLocale', 'previousSlugs', 'previousSlugsByLocale'].map((key) => [key, structuredClone(listing[key as keyof typeof listing])]));
    const result = applyCoopSourceDetailToJob(listing, jsonLd(listing.title, locality, region));

    expect(result).toMatchObject({ location: locality, addressLocality: locality, canton, addressRegion: canton });
    expect(result.description).not.toContain('Listing boilerplate');
    expect(result.description.trim().split(/\s+/).length).toBeGreaterThanOrEqual(50);
    for (const [key, value] of Object.entries(identity)) expect(result[key]).toEqual(value);
  });

  it('fails the whole enrichment before publishing a partial or malformed detail batch', async () => {
    const jobs = cases.slice(0, 2).map(([companyKey, url]) => ({
      id: `${companyKey}-stable`, companyKey, url, title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    }));
    const fetchImpl = async (input: URL) => String(input).includes('22222222')
      ? new Response('<html>missing JSON-LD</html>', { status: 200 })
      : new Response(`<script type="application/ld+json">${JSON.stringify(jsonLd(jobs[0].title, 'Oberbüren', 'St. Gallen'))}</script>`, { status: 200 });

    await expect(enrichCoopSourceBackedJobs(jobs, { fetchImpl, concurrency: 2 }))
      .rejects.toThrow(/has no JobPosting JSON-LD/);
    expect(jobs.every((job) => job.description === 'listing fallback')).toBe(true);
  });

  it('rejects a cross-host redirect before fetching or publishing its payload', async () => {
    const job = {
      id: 'stable', companyKey: 'jumbo', url: cases[2][1], title: 'Verkäuferin Verkäufer',
      description: 'listing fallback', location: 'Fallback Hauptsitz', canton: 'TI', sourceLang: 'de',
    };
    const requests: string[] = [];
    const fetchImpl = async (input: string | URL) => {
      requests.push(String(input));
      return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/jobs/one' } });
    };

    await expect(enrichCoopSourceBackedJobs([job], { fetchImpl, allowedHosts: ['jobs.coopjobs.ch'] }))
      .rejects.toThrow(/origin not allowed/);
    expect(requests).toEqual([job.url]);
    expect(job.description).toBe('listing fallback');
  });

  it('accepts ISO CH/CHE country evidence when addressRegion is an ATS district', () => {
    const [companyKey, url, locality, region] = cases[3];
    const listing = { id: 'stable', companyKey, url, title: 'Verkäuferin Verkäufer', description: 'listing', location: 'fallback', canton: 'TI', sourceLang: 'de' };
    for (const country of ['CH', 'CHE']) {
      const detail = jsonLd(listing.title, locality, region);
      detail.jobLocation.address.addressCountry = country;
      expect(applyCoopSourceDetailToJob(listing, detail)).toMatchObject({ location: locality, canton: 'ZH' });
    }
  });

  it('is idempotent for an already source-backed payload', () => {
    const [companyKey, url, locality, region] = cases[3];
    const listing = { id: 'stable', companyKey, url, title: 'Verkäuferin Verkäufer', description: 'listing', location: 'fallback', canton: 'TI', sourceLang: 'de' };
    const detail = jsonLd(listing.title, locality, region);
    const first = applyCoopSourceDetailToJob(listing, detail);
    expect(applyCoopSourceDetailToJob(first, detail)).toEqual(first);
  });
});

// ──────────────────────────────────────────────────────────────
// Translation-cache redirect-history preservation (issue #2962)
//
// All 9 URLs flagged by the daily 404-risk audit were Coop jobs whose old
// (sitemap-referenced) slugs were left unserved. The Coop translation cache is
// the only crawler-specific persistence layer, and it must carry redirect
// history (previousSlugs / previousSlugsByLocale) so that, when the cache
// re-injects a job into data/jobs.json, the build plugin can still emit bridge
// pages for the old URLs instead of letting them 404.
// ──────────────────────────────────────────────────────────────
describe('buildCoopTranslationCacheEntry — redirect-history preservation (#2962)', () => {
  const jobWithHistory = {
    url: 'https://jobs.coopjobs.ch/offene-stellen/metzger/abc-123',
    slug: 'metzger-in-fleischfachfrau-fleischfachmann-coop-genossenschaft-goldach-sankt-gallen-i5fg9z',
    company: 'Coop Genossenschaft',
    companyKey: 'coop',
    location: 'Goldach',
    canton: 'SG',
    titleByLocale: { it: 'Macellaio', en: 'Butcher', de: 'Metzger', fr: 'Boucher' },
    slugByLocale: {
      it: 'metzger-in-fleischfachfrau-fleischfachmann-coop-genossenschaft-goldach-sankt-gallen-i5fg9z',
      en: 'butcher-meat-specialist-coop-genossenschaft-goldach-i5fg9z',
      de: 'metzger-in-fleischfachfrau-fleischfachmann-coop-genossenschaft-goldach-sankt-gallen-i5fg9z',
      fr: 'boucher-specialiste-de-la-viande-coop-genossenschaft-goldach-i5fg9z',
    },
    previousSlugs: ['butcher-meat-specialist-coop-genossenschaft-goldach'],
    previousSlugsByLocale: {
      en: ['butcher-meat-specialist-coop-genossenschaft-goldach'],
      fr: ['boucher-specialiste-de-la-viande-coop-genossenschaft-goldach'],
    },
  };

  it('carries previousSlugs and previousSlugsByLocale through the cache entry', () => {
    const entry = buildCoopTranslationCacheEntry(jobWithHistory);
    expect(entry.previousSlugs).toEqual(jobWithHistory.previousSlugs);
    expect(entry.previousSlugsByLocale).toEqual(jobWithHistory.previousSlugsByLocale);
    // Existing translation fields still preserved.
    expect(entry.slugByLocale).toEqual(jobWithHistory.slugByLocale);
    expect(entry.titleByLocale).toEqual(jobWithHistory.titleByLocale);
  });

  it('omits redirect-history keys entirely when there is no history (no empty-placeholder churn)', () => {
    const entry = buildCoopTranslationCacheEntry({
      url: 'https://jobs.coopjobs.ch/offene-stellen/x/1',
      slug: 'fresh-job-coop-lugano',
      slugByLocale: { it: 'fresh-job-coop-lugano' },
      // no previousSlugs / previousSlugsByLocale
    });
    expect(entry).not.toHaveProperty('previousSlugs');
    expect(entry).not.toHaveProperty('previousSlugsByLocale');
    // Empty objects/arrays are not treated as history.
    const entryEmpty = buildCoopTranslationCacheEntry({
      url: 'u', slug: 's', previousSlugs: [], previousSlugsByLocale: {},
    });
    expect(entryEmpty).not.toHaveProperty('previousSlugs');
    expect(entryEmpty).not.toHaveProperty('previousSlugsByLocale');
  });

  it('is pure/deterministic (does not stamp cachedAt itself)', () => {
    const a = buildCoopTranslationCacheEntry(jobWithHistory);
    const b = buildCoopTranslationCacheEntry(jobWithHistory);
    expect(a).toEqual(b);
    expect(a).not.toHaveProperty('cachedAt');
  });
});

describe('findUnrecognizedCoopDivisions (#6945 item 1)', () => {
  it('flags a Coop-scoped job whose company text is not in the allowlist', () => {
    const jobs = [
      { companyKey: 'coop-ticino', company: 'Coop' },
      { companyKey: 'coop-ticino', company: 'Some New Coop Division AG' },
    ];
    expect(isCoopJob(jobs[0])).toBe(true);
    expect(isCoopJob(jobs[1])).toBe(false);
    expect(findUnrecognizedCoopDivisions(jobs)).toEqual(['Some New Coop Division AG']);
  });

  it('ignores jobs scoped to a different crawler', () => {
    const jobs = [
      { companyKey: 'fust', company: 'Fust' },
      { companyKey: 'jumbo', company: 'Jumbo' },
    ];
    expect(findUnrecognizedCoopDivisions(jobs)).toEqual([]);
  });

  it('returns no entries when every Coop-scoped job matches the allowlist', () => {
    const jobs = [
      { companyKey: 'coop-ticino', company: 'Coop City' },
      { companyKey: 'coop-ticino', company: 'coop.ch' },
    ];
    expect(findUnrecognizedCoopDivisions(jobs)).toEqual([]);
  });

  it('dedupes repeated unrecognized company names', () => {
    const jobs = [
      { companyKey: 'coop-ticino', company: 'Mystery Coop Brand' },
      { companyKey: 'coop-ticino', company: 'Mystery Coop Brand' },
    ];
    expect(findUnrecognizedCoopDivisions(jobs)).toEqual(['Mystery Coop Brand']);
  });
});

describe('assertCoopSingleCompanyKeyScope (#6945 item 2)', () => {
  it('passes when no company key scope is pre-set in env', () => {
    expect(() => assertCoopSingleCompanyKeyScope({})).not.toThrow();
  });

  it('passes when the pre-set scope is only coop-ticino itself', () => {
    expect(() => assertCoopSingleCompanyKeyScope({ JOBS_CRAWLER_COMPANY_KEYS: 'coop-ticino' })).not.toThrow();
    expect(() => assertCoopSingleCompanyKeyScope({ JOBS_CRAWLER_COMPANY_KEY: 'Coop-Ticino' })).not.toThrow();
  });

  it('fails closed when an extraneous company key has leaked into the scope', () => {
    expect(() => assertCoopSingleCompanyKeyScope({ JOBS_CRAWLER_COMPANY_KEYS: 'coop-ticino,fust' }))
      .toThrow(/sole company-key scope/);
    expect(() => assertCoopSingleCompanyKeyScope({ JOBS_CRAWLER_COMPANY_KEY: 'jumbo' }))
      .toThrow(/sole company-key scope/);
  });
});
