/**
 * Tests for the shared jobup.ch feed parser.
 *
 * Covers Romandie employers that publish jobs via the jobup.ch mask endpoint
 * (used by the Jalios JCMS PluginJobUp integration and others):
 *   - Pôle Santé Pays-d'Enhaut (key `hpe`) — VD Château-d'Oex
 *
 * eHnv (key `ehnv`) moved off jobup.ch to a Johdi Suite ATS — see
 * `tests/parsers/johdisuite-ehnv-parser.test.ts`. The jobup.ch mask `ehnv`
 * returned 0 jobs for 5+ consecutive days while eHnv's real career page
 * listed ~15 openings (stale/disconnected feed, confirmed 2026-07-08).
 *
 * Verifies:
 *   - Exported constants on each thin wrapper
 *   - isCompanyJob / isTrustedDomain matchers
 *   - parseJobupLieu (postal + city extraction from `lieu` field)
 *   - parseJobupDate (DD/MM/YYYY → YYYY-MM-DD)
 *   - detectEmploymentTypeFromOccupation (range → FULL_TIME/PART_TIME/OTHER)
 *   - Double-decoded HTML entities (jobup returns `&amp;nbsp;` → ` `)
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  createJobupChFeedParser,
  parseJobupLieu,
  parseJobupDate,
  detectEmploymentTypeFromOccupation,
  decodeEntities,
  looksLikeJsonFeedBody,
} from '../../scripts/lib/jobup-ch-feed-common.mjs';
import {
  POLE_SANTE_PAYS_ENHAUT_KEY,
  POLE_SANTE_PAYS_ENHAUT_COMPANY_NAME,
  isPoleSantePaysEnhautJob,
  isTrustedDomain as isPsTrusted,
} from '../../scripts/lib/pole-sante-pays-enhaut-job-parser.mjs';

describe('jobup.ch employers — exported constants', () => {
  it('PSPE constants', () => {
    expect(POLE_SANTE_PAYS_ENHAUT_KEY).toBe('pole-sante-pays-enhaut');
    expect(POLE_SANTE_PAYS_ENHAUT_COMPANY_NAME).toMatch(/Pays-d'Enhaut/);
  });
});

describe('isCompanyJob — matchers', () => {
  it('PSPE matches by jobup mask URL', () => {
    expect(isPoleSantePaysEnhautJob({ url: 'https://www.jobup.ch/masks/hpe/anything' })).toBe(true);
    expect(isPoleSantePaysEnhautJob({ url: 'https://www.jobup.ch/masks/ehnv/anything' })).toBe(false);
  });

  it('PSPE matches by corporate domain', () => {
    expect(isPoleSantePaysEnhautJob({ url: 'https://www.pspe.ch/jcms/x' })).toBe(true);
  });
});

describe('isTrustedDomain — jobup.ch is always trusted', () => {
  it('PSPE trusts jobup.ch and pspe.ch', () => {
    expect(isPsTrusted('https://www.jobup.ch/fr/emplois/detail/xyz')).toBe(true);
    expect(isPsTrusted('https://jobup.ch/x')).toBe(true);
    expect(isPsTrusted('https://www.pspe.ch/x')).toBe(true);
    expect(isPsTrusted('https://malicious.example/x')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isPsTrusted('not-a-url')).toBe(false);
    expect(isPsTrusted('')).toBe(false);
  });
});

describe('parseJobupLieu — postal code + city extraction', () => {
  it('splits "1660 Château-d\'Oex"', () => {
    expect(parseJobupLieu('1660 Château-d\'Oex')).toEqual({ postal: '1660', city: 'Château-d\'Oex' });
  });

  it('decodes entity-encoded city names', () => {
    expect(parseJobupLieu('1400 Yverdon-les-Bains')).toEqual({ postal: '1400', city: 'Yverdon-les-Bains' });
  });

  it('handles missing postal code', () => {
    expect(parseJobupLieu('Lausanne')).toEqual({ postal: '', city: 'Lausanne' });
  });

  it('handles entity-encoded city', () => {
    expect(parseJobupLieu('1660 Ch&#226;teau d\'Oex')).toEqual({ postal: '1660', city: 'Château d\'Oex' });
  });

  it('returns empty for empty input', () => {
    expect(parseJobupLieu('')).toEqual({ postal: '', city: '' });
  });
});

describe('parseJobupDate — DD/MM/YYYY → ISO', () => {
  it('parses two-digit day and month', () => {
    expect(parseJobupDate('11/05/2026')).toBe('2026-05-11');
  });

  it('parses single-digit day and month', () => {
    expect(parseJobupDate('3/5/2024')).toBe('2024-05-03');
  });

  it('returns empty for invalid input', () => {
    expect(parseJobupDate('not-a-date')).toBe('');
    expect(parseJobupDate('2024-05-03')).toBe('');
    expect(parseJobupDate('')).toBe('');
  });
});

describe('detectEmploymentTypeFromOccupation', () => {
  it('detects FULL_TIME at >=90%', () => {
    expect(detectEmploymentTypeFromOccupation('100', '100%')).toBe('FULL_TIME');
    expect(detectEmploymentTypeFromOccupation('80', '100%')).toBe('FULL_TIME');
    expect(detectEmploymentTypeFromOccupation('90', '90')).toBe('FULL_TIME');
  });

  it('detects PART_TIME at <90%', () => {
    expect(detectEmploymentTypeFromOccupation('50', '70%')).toBe('PART_TIME');
    expect(detectEmploymentTypeFromOccupation('20', '40%')).toBe('PART_TIME');
  });

  it('returns OTHER for missing data', () => {
    expect(detectEmploymentTypeFromOccupation('', '')).toBe('OTHER');
    expect(detectEmploymentTypeFromOccupation('', '0%')).toBe('OTHER');
  });
});

describe('decodeEntities — handles double-encoded entities', () => {
  it('decodes single-encoded named entities', () => {
    expect(decodeEntities('Foo&nbsp;Bar')).toBe('Foo Bar');
    expect(decodeEntities('Ch&acirc;teau')).toBe('Château');
  });

  it('decodes double-encoded entities (jobup quirk)', () => {
    // jobup returns "Bâtiment&amp;nbsp;/&amp;nbsp;Construction"
    // where `&amp;nbsp;` should become ` ` (space)
    expect(decodeEntities('B&#226;timent&amp;nbsp;/&amp;nbsp;Construction')).toBe('Bâtiment / Construction'.replace(/ /g, ' '));
  });

  it('decodes numeric entities', () => {
    expect(decodeEntities('&#8217;')).toBe('’');
    expect(decodeEntities('&#x2014;')).toBe('—');
  });

  it('leaves unknown entities intact', () => {
    expect(decodeEntities('&unknownEntity;')).toBe('&unknownEntity;');
  });
});

describe('looksLikeJsonFeedBody — Playwright fallback body guard', () => {
  it('accepts raw JSON object/array bodies', () => {
    expect(looksLikeJsonFeedBody('{"jobcount":"7","jobs":[]}')).toBe(true);
    expect(looksLikeJsonFeedBody('  [\n{"titre":"x"}\n]  ')).toBe(true);
  });

  it('accepts a JSONP-wrapped body (jobup xCallback quirk)', () => {
    expect(looksLikeJsonFeedBody('xCallback({"jobs":[]});')).toBe(true);
  });

  it('rejects a 200 anti-bot/CAPTCHA challenge page', () => {
    expect(looksLikeJsonFeedBody('<!DOCTYPE html><html><head><title>Just a moment...</title>')).toBe(false);
    expect(looksLikeJsonFeedBody('Please enable JavaScript to continue')).toBe(false);
  });

  it('rejects empty / nullish bodies', () => {
    expect(looksLikeJsonFeedBody('')).toBe(false);
    expect(looksLikeJsonFeedBody('   ')).toBe(false);
    expect(looksLikeJsonFeedBody(undefined as any)).toBe(false);
  });
});

describe('createJobupChFeedParser — config validation', () => {
  it('throws on missing required config', () => {
    expect(() => createJobupChFeedParser({} as any)).toThrow();
    expect(() => createJobupChFeedParser({
      companyKey: 'x',
      companyName: 'X',
      // missing jobupKey, defaultCanton
    } as any)).toThrow();
  });

  it('returns the three required functions', () => {
    const p = createJobupChFeedParser({
      companyKey: 'test',
      companyName: 'Test',
      companyDomain: 'test.ch',
      jobupKey: 'test',
      defaultCanton: 'VD',
      defaultCity: 'Lausanne',
      defaultPostalCode: '1000',
    });
    expect(typeof p.fetchAllJobs).toBe('function');
    expect(typeof p.isCompanyJob).toBe('function');
    expect(typeof p.isTrustedDomain).toBe('function');
  });
});

const JOBUP_DETAIL_URL = 'https://www.jobup.ch/fr/emplois/detail/fixture-job/';
const SECOND_JOBUP_DETAIL_URL = 'https://www.jobup.ch/fr/emplois/detail/second-fixture-job/';
const sourceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const SOURCE_DATE_DMY = [
  String(sourceDate.getUTCDate()).padStart(2, '0'),
  String(sourceDate.getUTCMonth() + 1).padStart(2, '0'),
  sourceDate.getUTCFullYear(),
].join('/');
const JOBUP_FEED_JOB = {
  titre: 'Infirmier·ère référent·e',
  puddate: SOURCE_DATE_DMY,
  lieu: '1660 Château-d\'Oex',
  ref: 'Santé / Médecine',
  link: JOBUP_DETAIL_URL,
  canton: 'Riviera - Chablais',
  contrat: 'PERMANENT',
  occupationmin: '80',
  occupationmax: '100%',
};

const RICH_JOBUP_DETAIL = `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: JOBUP_FEED_JOB.titre,
  description: `<p>Vous accompagnez les résidentes et résidents dans les activités de la vie quotidienne et coordonnez les soins avec une équipe interdisciplinaire.</p>
    <h2>Votre mission</h2><ul><li>Assurer des soins individualisés et documentés.</li><li>Collaborer avec les proches et les partenaires médicaux.</li></ul>
    <h2>Votre profil</h2><p>Vous disposez d'un diplôme reconnu, d'une expérience clinique solide et d'excellentes compétences relationnelles.</p>`,
})}</script>`;

const JOBUP_CONSUMERS = [
  {
    label: 'CNP',
    companyKey: 'cnp',
    companyName: 'Centre Neuchâtelois de Psychiatrie (CNP)',
    companyDomain: 'cnp.ch',
    jobupKey: 'cnp',
    defaultCanton: 'NE',
    defaultCity: 'Marin-Epagnier',
    defaultPostalCode: '2074',
  },
  {
    label: 'Pôle Santé Pays-d\'Enhaut',
    companyKey: 'pole-sante-pays-enhaut',
    companyName: 'Pôle Santé Pays-d\'Enhaut',
    companyDomain: 'pspe.ch',
    jobupKey: 'hpe',
    defaultCanton: 'VD',
    defaultCity: 'Château-d\'Oex',
    defaultPostalCode: '1660',
  },
];

function stubJobupSource(
  detailResponse: (init?: RequestInit, url?: string) => Promise<Response> | Response,
  feedJobs = [JOBUP_FEED_JOB],
) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/masks/')) {
      return new Response(JSON.stringify({ jobcount: String(feedJobs.length), jobs: feedJobs }), { status: 200 });
    }
    if (feedJobs.some((job) => job.link === url)) return await detailResponse(init, url);
    return new Response('', { status: 404 });
  }));
}

beforeEach(() => {
  process.env.JOBS_CRAWLER_RETRIES = '0';
  process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
  process.env.JOBS_CRAWLER_TIMEOUT_MS = '10';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.JOBS_CRAWLER_RETRIES;
  delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  delete process.env.JOBS_CRAWLER_TIMEOUT_MS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createJobupChFeedParser — fail-closed detail contract', () => {
  it.each(JOBUP_CONSUMERS)('keeps rich live output unchanged for $label', async (config) => {
    stubJobupSource(() => new Response(RICH_JOBUP_DETAIL, { status: 200 }));
    const parser = createJobupChFeedParser(config);

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      companyKey: config.companyKey,
      url: JOBUP_DETAIL_URL,
      description: expect.stringContaining('Assurer des soins individualisés'),
    });
    expect(jobs[0].description.length).toBeGreaterThan(300);
  });

  it('keeps source URL identity and output stable across two equivalent runs', async () => {
    stubJobupSource(() => new Response(RICH_JOBUP_DETAIL, { status: 200 }));
    const parser = createJobupChFeedParser(JOBUP_CONSUMERS[0]);

    const first = await parser.fetchAllJobs();
    const second = await parser.fetchAllJobs();

    expect(second.map(({ crawledAt: _crawledAt, ...job }) => job))
      .toEqual(first.map(({ crawledAt: _crawledAt, ...job }) => job));
    expect(second[0]).toMatchObject({
      id: first[0].id,
      url: JOBUP_DETAIL_URL,
      applyUrl: JOBUP_DETAIL_URL,
      slug: first[0].slug,
    });
  });

  it.each([
    ['HTTP non-ok', () => new Response('unavailable', { status: 503 })],
    ['missing JSON-LD', () => new Response('<html><body>no job posting</body></html>', { status: 200 })],
    ['malformed JSON-LD', () => new Response('<script type="application/ld+json">{broken</script>', { status: 200 })],
    ['timeout', (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }, { once: true });
    })],
  ])('publishes no 9-word feed or title/company fallback after %s', async (_label, detailResponse) => {
    stubJobupSource(detailResponse);
    const parser = createJobupChFeedParser(JOBUP_CONSUMERS[0]);

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toEqual([]);
  });

  it('returns no partial batch when one of two detail pages is unusable', async () => {
    const secondJob = {
      ...JOBUP_FEED_JOB,
      titre: 'Médecin chef·fe de clinique',
      link: SECOND_JOBUP_DETAIL_URL,
    };
    stubJobupSource((_init, url) => url === JOBUP_DETAIL_URL
      ? new Response(RICH_JOBUP_DETAIL, { status: 200 })
      : new Response('unavailable', { status: 503 }), [JOBUP_FEED_JOB, secondJob]);
    const parser = createJobupChFeedParser(JOBUP_CONSUMERS[0]);

    await expect(parser.fetchAllJobs()).resolves.toEqual([]);
  });

  it.each([
    'http://127.0.0.1:9/private-job/',
    'https://malicious.example/off-origin-job/',
  ])('rejects an off-origin detail before fetch: %s', async (untrustedUrl) => {
    let untrustedFetches = 0;
    const feedJob = { ...JOBUP_FEED_JOB, link: untrustedUrl };
    stubJobupSource(() => {
      untrustedFetches++;
      return new Response(RICH_JOBUP_DETAIL, { status: 200 });
    }, [feedJob]);
    const parser = createJobupChFeedParser(JOBUP_CONSUMERS[0]);

    await expect(parser.fetchAllJobs()).resolves.toEqual([]);
    expect(untrustedFetches).toBe(0);
  });

  it('rejects a cross-origin detail redirect without following the target', async () => {
    let crossOriginFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/masks/')) {
        return new Response(JSON.stringify({ jobcount: '1', jobs: [JOBUP_FEED_JOB] }), { status: 200 });
      }
      expect(init?.redirect).toBe('manual');
      if (url === JOBUP_DETAIL_URL) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://malicious.example/redirected-job/' },
        });
      }
      crossOriginFetches++;
      return new Response(RICH_JOBUP_DETAIL, { status: 200 });
    }));
    const parser = createJobupChFeedParser(JOBUP_CONSUMERS[0]);

    await expect(parser.fetchAllJobs()).resolves.toEqual([]);
    expect(crossOriginFetches).toBe(0);
  });

  it.each(['', '75000 Paris', 'Bern, US'])('rejects missing or foreign source lieu instead of using configured headquarters: %s', async (lieu) => {
    let detailFetches = 0;
    stubJobupSource(() => {
      detailFetches++;
      return new Response(RICH_JOBUP_DETAIL, { status: 200 });
    }, [{ ...JOBUP_FEED_JOB, lieu }]);
    const parser = createJobupChFeedParser(JOBUP_CONSUMERS[0]);

    await expect(parser.fetchAllJobs()).resolves.toEqual([]);
    expect(detailFetches).toBe(0);
  });

  it('invalidates the whole batch when a sibling row has unresolved source geography', async () => {
    const foreignJob = {
      ...JOBUP_FEED_JOB,
      titre: 'Médecin chef·fe de clinique',
      link: SECOND_JOBUP_DETAIL_URL,
      lieu: 'Berlin',
    };
    stubJobupSource(() => new Response(RICH_JOBUP_DETAIL, { status: 200 }), [JOBUP_FEED_JOB, foreignJob]);
    const parser = createJobupChFeedParser(JOBUP_CONSUMERS[0]);

    await expect(parser.fetchAllJobs()).resolves.toEqual([]);
  });
});
