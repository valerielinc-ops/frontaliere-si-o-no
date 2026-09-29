import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAvaloqListingLinks,
  parseAvaloqJobDetail,
  isAvaloqTargetLocation,
  inferAvaloqCanton,
  fetchAvaloqJobsFromApi,
  assertCompleteAvaloqSnapshot,
  buildAvaloqLocalizedContent,
  dropStaleLocaleDescriptions,
} from '../scripts/lib/avaloq-job-parser.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('avaloq-job-parser', () => {
  it('rejects an empty target without a complete source proof', () => {
    expect(() => assertCompleteAvaloqSnapshot([])).toThrow(/authoritative source snapshot/);
  });

  it('accepts an empty target only when the complete source was classified', () => {
    const rows = [];
    Object.defineProperties(rows, {
      avaloqSourceSnapshot: { value: 'authoritative-api-snapshot' },
      avaloqSourceReadComplete: { value: true },
      avaloqSourceTerminationProven: { value: true },
      avaloqSourcePaginationIntegrityProven: { value: true },
      avaloqSourceTotalFound: { value: 2 },
      avaloqSourceRecordsSeen: { value: 2 },
      avaloqSourcePostingCount: { value: 2 },
      avaloqClassifiedPostingCount: { value: 2 },
    });
    expect(assertCompleteAvaloqSnapshot(rows)).toBe(true);
  });

  it('rejects a zero target when the API total proves that the read was truncated', async () => {
    const posting = {
      id: '744000000000001',
      name: 'Zürich role',
      location: { city: 'Zürich', country: { code: 'CH' } },
    };
    let listCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/postings/744000000000001')) {
        return new Response(JSON.stringify(posting), { status: 200 });
      }
      listCalls += 1;
      return new Response(JSON.stringify({
        content: listCalls === 1 ? [posting] : [],
        totalFound: 2,
      }), { status: 200 });
    }));

    const rows = await fetchAvaloqJobsFromApi(100, () => false);
    expect(rows).toHaveLength(0);
    expect(listCalls).toBe(2);
    expect(() => assertCompleteAvaloqSnapshot(rows)).toThrow(/authoritative source snapshot/);
  });

  it('rejects a zero target when repeated source pages fake totalFound coverage', async () => {
    const sourcePage = [
      { id: '744000000000001', name: 'Zürich role', location: { city: 'Zürich', country: { code: 'CH' } } },
      { id: '744000000000002', name: 'Basel role', location: { city: 'Basel', country: { code: 'CH' } } },
    ];
    let listCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/postings/744000000000001')) {
        return new Response(JSON.stringify(sourcePage[0]), { status: 200 });
      }
      if (url.pathname.endsWith('/postings/744000000000002')) {
        return new Response(JSON.stringify(sourcePage[1]), { status: 200 });
      }
      listCalls += 1;
      return new Response(JSON.stringify({ content: sourcePage, totalFound: 4 }), { status: 200 });
    }));

    const rows = await fetchAvaloqJobsFromApi(100, () => false);
    expect(rows).toHaveLength(0);
    expect(listCalls).toBe(2);
    expect(() => assertCompleteAvaloqSnapshot(rows)).toThrow(/authoritative source snapshot/);
  });

  it('rejects an unknown country paired with an unrecognised location', async () => {
    const posting = {
      id: '744000000000003',
      name: 'Unmapped role',
      location: { city: 'Unmapped City', country: { code: 'UNKNOWN' } },
    };
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/postings/744000000000003')) {
        return new Response(JSON.stringify(posting), { status: 200 });
      }
      return new Response(JSON.stringify({ content: [posting], totalFound: 1 }), { status: 200 });
    }));

    await expect(fetchAvaloqJobsFromApi(100, () => false))
      .rejects.toThrow(/unrecognised Avaloq location/);
  });

  it('links the SmartRecruiters posting page and publishes the company section (#5253)', async () => {
    // `www.avaloq.com/careers/job-openings/<id>` now answers 303 → the generic
    // listing, and the ad opens with a company paragraph the parser dropped.
    const posting = {
      id: '744000152257749',
      name: 'Solution Manager - Architect (with Avaloq Experience)',
      postingUrl: 'https://jobs.smartrecruiters.com/Avaloq1/744000152257749-solution-manager-architect-with-avaloq-experience-',
      applyUrl: 'https://jobs.smartrecruiters.com/Avaloq1/744000152257749-solution-manager-architect-with-avaloq-experience-?oga=true',
      location: { city: 'Bioggio', region: 'Canton Ticino', country: 'ch', fullLocation: 'Bioggio, Canton Ticino, Switzerland' },
      jobAd: {
        sections: {
          companyDescription: { text: '<p>Founded and headquartered in Switzerland, Avaloq is continuously expanding its global footprint.</p>' },
          jobDescription: { text: '<p>We are seeking an experienced Solution Manager - Architect.</p>' },
          qualifications: { text: '<ul><li>Minimum 5+ years of professional experience with Avaloq</li></ul>' },
          additionalInformation: { text: '<p>We are pleased to offer hybrid and flexible working.</p>' },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/postings/744000152257749')) {
        return new Response(JSON.stringify(posting), { status: 200 });
      }
      return new Response(JSON.stringify({ content: [posting], totalFound: 1 }), { status: 200 });
    }));

    const [row] = await fetchAvaloqJobsFromApi(100, () => true);
    expect(row.canonicalUrl).toBe(posting.postingUrl);
    expect(row.canonicalUrl).not.toContain('www.avaloq.com/careers/job-openings/');
    expect(row.applyUrl).toBe(posting.applyUrl);
    expect(row.description.indexOf('Founded and headquartered in Switzerland'))
      .toBeLessThan(row.description.indexOf('We are seeking an experienced Solution Manager'));
    expect(row.description).toContain('Minimum 5+ years of professional experience with Avaloq');
  });

  it('extracts public job detail links from listing page html', () => {
    const html = `
      <div style="display:none">
        <a href="/careers/job-openings/744000113443570-data-platform-manager">Data Platform Manager</a>
        <a href="/careers/job-openings/744000112640738-apprendista-di-commercio-afc-con-maturita">Apprendista</a>
      </div>
    `;
    expect(parseAvaloqListingLinks(html)).toEqual([
      'https://www.avaloq.com/careers/job-openings/744000113443570-data-platform-manager',
      'https://www.avaloq.com/careers/job-openings/744000112640738-apprendista-di-commercio-afc-con-maturita',
    ]);
  });

  it('extracts links from SmartRecruiters embedded IDs when no href links exist', () => {
    const html = `<script>{"props":{"pageProps":{"jobs":[{"applyUrl":"https:\\/\\/smartrecruiters.com\\/v1\\/companies\\/Avaloq1\\/postings\\/744000118386833"},{"applyUrl":"https:\\/\\/smartrecruiters.com\\/v1\\/companies\\/Avaloq1\\/postings\\/744000118375717"}]}}}</script>`;
    expect(parseAvaloqListingLinks(html)).toEqual([
      'https://www.avaloq.com/careers/job-openings/744000118386833',
      'https://www.avaloq.com/careers/job-openings/744000118375717',
    ]);
  });

  it('parses an Avaloq detail page and extracts location, apply url and sections', () => {
    const html = `
      <html>
        <head><title>Data Platform Manager | Job Openings - Avaloq</title></head>
        <body>
          <h1>Data Platform Manager</h1>
          Location
          Strada Regina 40
          6934 Bioggio
          Switzerland
          Work arrangement
          Full-time
          Apply
          Data Platform Manager
          A bit about the role
          This is an exciting opportunity for you to lead the platform team.
          Your key tasks
          Lead, mentor and manage a team of DBAs.
          A bit about you
          7+ years of experience and strong Oracle knowledge.
          It would be a real bonus if you have
          Oracle Certified Professional.
          Additional information
          We offer hybrid work and an inclusive workplace.
          <a href="https://jobs.smartrecruiters.com/Avaloq1/744000113443570-data-platform-manager?oga=true">Apply</a>
        </body>
      </html>
    `;
    const parsed = parseAvaloqJobDetail(html, 'https://www.avaloq.com/careers/job-openings/744000113443570-data-platform-manager');
    expect(parsed.title).toBe('Data Platform Manager');
    expect(parsed.location).toBe('Bioggio');
    expect(parsed.postalCode).toBe('6934');
    expect(parsed.applyUrl).toContain('jobs.smartrecruiters.com/Avaloq1/');
    expect(parsed.description).toContain('Il ruolo');
    expect(parsed.description).toContain('Le tue responsabilita');
    expect(parsed.description).toContain('Il tuo profilo');
  });

  it('matches Ticino and Grigioni locations', () => {
    expect(isAvaloqTargetLocation('Bioggio')).toBe(true);
    expect(isAvaloqTargetLocation('Chur')).toBe(true);
    expect(isAvaloqTargetLocation('Lugano, Italy')).toBe(false);
    expect(inferAvaloqCanton('Bioggio')).toBe('TI');
    expect(inferAvaloqCanton('Chur')).toBe('GR');
  });
});

// ── #5253: text in the slot of the language it is written in ─────────────
describe('Avaloq locale slots', () => {
  // Pinned: posting 744000152257749 — English source body, the published
  // Italian/German translations and the published slugs.
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'crawler-quality-f', 'avaloq-744000152257749-locales.json'),
    'utf8',
  ));

  it('keys an English posting under en, never under it', () => {
    const localized = buildAvaloqLocalizedContent(fixture.detail, 'Avaloq');
    expect(localized.sourceLang).toBe('en');
    expect(localized.descriptionByLocale).toEqual({ en: fixture.detail.description });
    expect(localized.titleByLocale).toEqual({ en: fixture.detail.title });
    expect(localized.descriptionByLocale.it).toBeUndefined();
  });

  it('reads the language from the body, not from the title', () => {
    const italian = { ...fixture.detail, description: fixture.published.descriptionByLocale.it };
    expect(buildAvaloqLocalizedContent(italian, 'Avaloq').sourceLang).toBe('it');
  });

  it('keeps the published slug value', () => {
    const localized = buildAvaloqLocalizedContent(fixture.detail, 'Avaloq');
    expect(localized.slug).toBe(fixture.published.slug);
    expect(localized.slugByLocale).toEqual({ en: fixture.published.slug });
  });

  it('drops an it slot that holds the English source (copy or other English text) and flags retranslation', () => {
    const copy = { sourceLang: 'en', description: fixture.detail.description, descriptionByLocale: { en: fixture.detail.description, it: fixture.detail.description } };
    expect(dropStaleLocaleDescriptions(copy)).toEqual(['it']);
    expect(copy.descriptionByLocale).toEqual({ en: fixture.detail.description });
    expect(copy.needsRetranslation).toBe(true);

    const olderEnglish = { sourceLang: 'en', descriptionByLocale: { en: 'Short fresh body.', it: fixture.detail.description } };
    expect(dropStaleLocaleDescriptions(olderEnglish)).toEqual(['it']);
  });

  it('keeps genuine translations and leaves the flag alone when nothing is stale', () => {
    const job = {
      sourceLang: 'en',
      descriptionByLocale: { en: fixture.detail.description, ...fixture.published.descriptionByLocale },
    };
    expect(dropStaleLocaleDescriptions(job)).toEqual([]);
    expect(Object.keys(job.descriptionByLocale).sort()).toEqual(['de', 'en', 'it']);
    expect(job).not.toHaveProperty('needsRetranslation');
  });
});
