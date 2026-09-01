import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  assertCompleteCoopDiscovery,
  buildCoopAdapterConfig,
  ensureAdapterSeedUrls,
} from '../scripts/update-coop-jobs.mjs';
import { fingerprintJob } from '../scripts/lib/dedicated-crawler-common.mjs';
import { __testables as sharedCrawlerTestables } from '../scripts/lib/shared-jobs-crawler.mjs';
import {
  extractJsonLd,
  coopDescHtmlToMarkdown,
  validateCoopDescription,
  titleOverlap,
  applyCoopJsonLdToJob,
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
      authoritativeDetailFingerprints: [fingerprintJob({ url: presentFeedUrl })],
    };

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
