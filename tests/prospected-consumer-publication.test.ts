import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';

const fixture = vi.hoisted(() => ({
  datePosted: undefined as string | undefined,
  legacyAliasOnly: false,
  requests: [] as string[],
  body: 'Sie übernehmen eine verantwortungsvolle Aufgabe in unserem Team in Zürich. Zu Ihren Tätigkeiten gehören die Beratung unserer Kunden, die Planung täglicher Abläufe und die sorgfältige Dokumentation der Ergebnisse. Wir suchen eine qualifizierte Fachperson mit abgeschlossener Ausbildung und Freude an der Zusammenarbeit. Wir bieten eine umfassende Einführung, geregelte Arbeitszeiten, moderne Arbeitsmittel und Möglichkeiten zur beruflichen Weiterbildung. Bitte senden Sie Ihre vollständigen Bewerbungsunterlagen über die angegebene Kontaktadresse.',
}));

// Inject only the stored spec and deterministic network transport. Extraction,
// detail enrichment, source date validation and every consumer remain real.
vi.mock('../scripts/lib/prospector/spec-crawler.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/prospector/spec-crawler.mjs')>();
  return {
    ...actual,
    loadSpec: (companyKey: string) => ({
      companyKey, companyName: companyKey, companyHost: 'jobs.example.test',
      platform: 'custom', mode: 'jsonld', sourceLang: 'de',
      seedUrls: ['https://jobs.example.test/jobs'], detailEnrichment: true,
      detailFetchWorkers: 1,
    }),
    runSpecInProduction: async (spec: Parameters<typeof actual.runSpecInProduction>[0]) => {
      const rows = await actual.runSpecInProduction(spec, {
        fetchImpl: async (input: string | URL | Request) => {
          const url = String(input);
          fixture.requests.push(url);
          if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
          if (!['https://jobs.example.test/jobs', 'https://jobs.example.test/jobs/role-1'].includes(url)) {
            throw new Error(`Unexpected fixture request: ${url}`);
          }
          const posting = {
            '@context': 'https://schema.org', '@type': 'JobPosting',
            title: 'Sachbearbeiter Administration',
            description: `<p>${fixture.body}</p>`,
            url: 'https://jobs.example.test/jobs/role-1',
            hiringOrganization: { '@type': 'Organization', name: spec.companyName },
            jobLocation: { '@type': 'Place', address: {
              '@type': 'PostalAddress', addressLocality: 'Zürich',
              addressRegion: 'ZH', addressCountry: 'CH', postalCode: '8001',
              streetAddress: 'Bahnhofstrasse 1',
            } },
            ...(fixture.datePosted === undefined ? {} : { datePosted: fixture.datePosted }),
          };
          return new Response(`<html><body><script type="application/ld+json">${JSON.stringify(posting)}</script><h1>${posting.title}</h1><p>${fixture.body}</p></body></html>`, {
            headers: { 'content-type': 'text/html' },
          });
        },
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        sleepImpl: async () => {}, retries: 0,
      });
      // Separate compatibility boundary: an old unmarked row must not become
      // reported just because a plausible legacy alias survived in storage.
      return fixture.legacyAliasOnly ? rows.map(row => {
        const { postingDateSource: _marker, postedDate: _posted, datePosted: _date, ...rest } = row;
        return { ...rest, postedAt: '2026-09-01', postedDate: '2026-09-01' };
      }) : rows;
    },
  };
});

import { fetchAllAnicuraJobs } from '../scripts/lib/anicura-job-parser.mjs';
import { fetchAllGrischapersonalJobs } from '../scripts/lib/grischapersonal-job-parser.mjs';
import { fetchAllAtecPersonalJobs } from '../scripts/lib/atec-personal-job-parser.mjs';
import { fetchAllParmagJobs } from '../scripts/lib/parmag-job-parser.mjs';
import { fetchAllPantrChJobs } from '../scripts/lib/pantr-ch-job-parser.mjs';
import { fetchAllMcmGroupJobs } from '../scripts/lib/mcm-group-job-parser.mjs';
import { fetchAllBenuJobs } from '../scripts/lib/benu-job-parser.mjs';
import { fetchAllAnkerSwissJobs } from '../scripts/lib/anker-swiss-job-parser.mjs';
import { fetchAllBuerstenTechnikJobs } from '../scripts/lib/buersten-technik-job-parser.mjs';
import { fetchAllGmoJobs } from '../scripts/lib/gmo-job-parser.mjs';
import { fetchAllMuellerSteinmaurJobs } from '../scripts/lib/mueller-steinmaur-job-parser.mjs';
import { fetchAllElpromJobs } from '../scripts/lib/elprom-job-parser.mjs';
import { fetchAllApplyJobs } from '../scripts/lib/apply-job-parser.mjs';
import { fetchAllChristinavassalliJobs } from '../scripts/lib/christinavassalli-job-parser.mjs';
import { fetchAllPremiumpflege24Jobs } from '../scripts/lib/premiumpflege24-job-parser.mjs';
import { fetchAllBrefispersonalJobs } from '../scripts/lib/brefispersonal-job-parser.mjs';
import { fetchAllStellentreffJobs } from '../scripts/lib/stellentreff-job-parser.mjs';
import { fetchAllGuggerbachJobs } from '../scripts/lib/guggerbach-job-parser.mjs';
import { fetchAllFisbaJobs } from '../scripts/lib/fisba-job-parser.mjs';
import { fetchAllEndesoJobs } from '../scripts/lib/endeso-job-parser.mjs';
import { fetchAllNeoproconseilsJobs } from '../scripts/lib/neoproconseils-job-parser.mjs';
import { fetchAllStaJobs } from '../scripts/lib/sta-job-parser.mjs';
import { fetchAllYellowsharkJobs } from '../scripts/lib/yellowshark-job-parser.mjs';
import { fetchAllStellenpartnerJobs } from '../scripts/lib/stellenpartner-job-parser.mjs';

const consumers = [
  ['anicura', fetchAllAnicuraJobs],
  ['grischapersonal', fetchAllGrischapersonalJobs],
  ['atec-personal', fetchAllAtecPersonalJobs],
  ['parmag', fetchAllParmagJobs],
  ['pantr-ch', fetchAllPantrChJobs],
  ['mcm-group', fetchAllMcmGroupJobs],
  ['benu', fetchAllBenuJobs],
  ['anker-swiss', fetchAllAnkerSwissJobs],
  ['buersten-technik', fetchAllBuerstenTechnikJobs],
  ['gmo', fetchAllGmoJobs],
  ['mueller-steinmaur', fetchAllMuellerSteinmaurJobs],
  ['elprom', fetchAllElpromJobs],
  ['apply', fetchAllApplyJobs],
  ['christinavassalli', fetchAllChristinavassalliJobs],
  ['premiumpflege24', fetchAllPremiumpflege24Jobs],
  ['brefispersonal', fetchAllBrefispersonalJobs],
  ['stellentreff', fetchAllStellentreffJobs],
  ['guggerbach', fetchAllGuggerbachJobs],
  ['fisba', fetchAllFisbaJobs],
  ['endeso', fetchAllEndesoJobs],
  ['neoproconseils', fetchAllNeoproconseilsJobs],
  ['sta', fetchAllStaJobs],
  ['yellowshark', fetchAllYellowsharkJobs],
  ['stellenpartner', fetchAllStellenpartnerJobs],
] as const;

beforeEach(() => {
  clearPoliteFetchStateForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture.requests.length = 0;
  fixture.legacyAliasOnly = false;
  fixture.datePosted = undefined;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(consumers)('%s source publication through the real spec pipeline', (_key, fetchJobs) => {
  it.each([
    ['reported timestamp', '2026-10-01T09:30:00+02:00', false, '2026-10-01T09:30:00+02:00'],
    ['missing date', undefined, false, ''],
    ['future date', '2099-10-01T09:30:00+02:00', false, ''],
    ['invalid calendar', '2026-02-30', false, ''],
    ['unmarked legacy aliases', undefined, true, ''],
  ] as const)('%s keeps the job and preserves only publication evidence', async (_label, raw, legacy, expected) => {
    fixture.datePosted = raw;
    fixture.legacyAliasOnly = legacy;
    const jobs = await fetchJobs();
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    // Grischa's listing-only source has a stable query identity and text fragment.
    const publicUrl = _key === 'grischapersonal'
      ? 'https://jobs.example.test/jobs/role-1?jobid=701673307c49#:~:text=Sachbearbeiter%20Administration'
      : 'https://jobs.example.test/jobs/role-1';
    expect(job).toMatchObject({
      postedDate: expected, datePosted: expected,
      postingDateSource: expected ? 'reported' : 'unknown',
      url: publicUrl,
      applyUrl: publicUrl,
      crawledAt: '2026-10-04T12:00:00.000Z',
      title: 'Sachbearbeiter Administration',
      companyKey: _key,
    });
    expect(job.description).toContain(fixture.body);
    expect(job.id).toBeTruthy();
    expect(job.slug).toBeTruthy();
    expect(fixture.requests).toContain('https://jobs.example.test/jobs');
    expect(fixture.requests).toContain('https://jobs.example.test/jobs/role-1');
  });
});
