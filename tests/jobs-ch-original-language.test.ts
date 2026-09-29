import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  fetchJobsChVacancyInOriginalLanguage,
  parseVacancyLanguage,
} from '../scripts/lib/jobs-ch-company-pages.mjs';
import { fetchAllStrabagJobs } from '../scripts/lib/strabag-job-parser.mjs';
import { fetchAllHofweissbadJobs } from '../scripts/lib/hofweissbad-job-parser.mjs';
import { fetchAllVisionapartmentsJobs } from '../scripts/lib/visionapartments-job-parser.mjs';
import { fetchAllSaintGobainWeberIsoverJobs } from '../scripts/lib/saint-gobain-weber-isover-job-parser.mjs';

/**
 * jobs.ch serves a MACHINE TRANSLATION on the `/en/vacancies/detail/<uuid>/`
 * route that company profiles link to: the JSON-LD `JobPosting` and the
 * `vacancy-detail` state carry `requestedLang:"en"` next to the vacancy's real
 * `originalLanguage`. The four jobs.ch company-page crawlers published that
 * English translation as the source text with `sourceLang: 'en'` (audit run
 * 36528331656: strabag, saint-gobain-weber-isover, visionapartments at word
 * overlap 0.06-0.15 against the German page; hofweissbad published the
 * translation too). Fixture minimised from the live pages of strabag vacancy
 * 6f2b1045-1245-475b-a118-6690e3b5c0d7 (2026-09-29): same UUID, same JSON-LD
 * fields, descriptions cut to their first paragraph.
 */

const UUID = '6f2b1045-1245-475b-a118-6690e3b5c0d7';
const EN_URL = `https://www.jobs.ch/en/vacancies/detail/${UUID}/`;
const DE_URL = `https://www.jobs.ch/de/stellenangebote/detail/${UUID}/`;
const ROUTES = `"translatedRoutes":{"de":"\\u002Fde\\u002Fstellenangebote\\u002Fdetail\\u002F${UUID}\\u002F","fr":"\\u002Ffr\\u002Foffres-emplois\\u002Fdetail\\u002F${UUID}\\u002F","en":"\\u002Fen\\u002Fvacancies\\u002Fdetail\\u002F${UUID}\\u002F"}`;

const DE_BODY = '<p>Bei STRABAG bauen rund 89.000 Menschen an mehr als 2.400 Standorten weltweit am Fortschritt. '
  + 'Einzigartigkeit und individuelle Stärken kennzeichnen dabei nicht nur unsere Projekte, sondern auch jede:n Einzelne:n von uns.</p>'
  + '<p>Deine Aufgaben</p><ul><li>Wartung und Reparatur von Baumaschinen im Spezialtiefbau</li>'
  + '<li>Fehlerdiagnose an hydraulischen und elektrischen Systemen</li></ul>'
  + '<p>Dein Profil</p><ul><li>Abgeschlossene Lehre als Baumaschinenmechaniker:in EFZ</li><li>Führerausweis Kat. B</li></ul>';
const EN_BODY = '<div> <p>At STRABAG, around 89,000 people at more than 2,400 locations worldwide are building progress. '
  + 'Uniqueness and individual strengths characterise not only our projects but also each and every one of us.</p>'
  + '<p>Your tasks</p><ul><li>Maintenance and repair of construction machinery in deep foundation engineering</li>'
  + '<li>Fault diagnosis on hydraulic and electrical systems</li></ul>'
  + '<p>Your profile</p><ul><li>Completed apprenticeship as a construction machinery mechanic EFZ</li><li>Driving licence cat. B</li></ul></div>';

function detailPage({ title, body, requestedLang, url }: { title: string, body: string, requestedLang: string, url: string }) {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title,
    description: body,
    identifier: { '@type': 'PropertyValue', name: 'Job ID', value: UUID },
    url,
    datePosted: '2026-09-03T04:03:13+02:00',
    hiringOrganization: { '@type': 'Organization', name: 'Strabag BMTI GmbH' },
    employmentType: requestedLang === 'de' ? 'Festanstellung' : 'Permanent position',
    workHours: '42 - 42 hours/week',
    jobLocation: {
      '@type': 'Place',
      address: { '@type': 'PostalAddress', streetAddress: 'Buzibachstrasse 31d', postalCode: '6023', addressLocality: 'Rothenburg', addressCountry: 'CH' },
    },
  };
  return `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify(posting)}</script>
</head><body><div id="root"></div>
<script>window.__INIT__={${ROUTES},"queries":[{"state":{"data":{"originalLanguage":"de","requestedLang":"${requestedLang}","title":${JSON.stringify(title)}}},"queryKey":["vacancy-detail","${UUID}"]}]}</script>
</body></html>`;
}

const EN_PAGE = detailPage({
  title: 'Construction Machinery Mechanic: Specialist in Deep Foundation Engineering',
  body: EN_BODY,
  requestedLang: 'en',
  url: EN_URL,
});
const DE_PAGE = detailPage({
  title: 'Baumaschinenmechaniker:in Spezialtiefbau',
  body: DE_BODY,
  requestedLang: 'de',
  url: DE_URL,
});

const profile = `<!doctype html><html><head>
  <link rel="canonical" href="https://www.jobs.ch/en/companies/39383-strabag-ag/"/>
</head><body><h1>STRABAG AG</h1>
  <ul><li><a href="/en/companies/39383-strabag-ag/vacancies/">Jobs (1)</a></li></ul>
  <a href="/en/vacancies/detail/${UUID}/">Baumaschinenmechaniker:in</a>
</body></html>`;

function sourceStub(overrides: Record<string, () => string> = {}) {
  const fetched: string[] = [];
  const fetchPage = async (url: string) => {
    fetched.push(url);
    if (overrides[url]) return overrides[url]();
    if (url.includes('/companies/')) return profile;
    if (url === EN_URL) return EN_PAGE;
    if (url === DE_URL) return DE_PAGE;
    throw Object.assign(new Error(`HTTP 404 from ${url}`), { status: 404 });
  };
  return { fetchPage, fetched };
}

describe('parseVacancyLanguage', () => {
  it('reads the declared original language, the served language and the routes', () => {
    const parsed = parseVacancyLanguage(EN_PAGE);
    expect(parsed.originalLanguage).toBe('de');
    expect(parsed.requestedLang).toBe('en');
    expect(parsed.translatedRoutes.de).toBe(`/de/stellenangebote/detail/${UUID}/`);
  });

  it('returns nulls on a page without the vacancy state', () => {
    expect(parseVacancyLanguage('<html><body>maintenance</body></html>')).toEqual({
      originalLanguage: null,
      requestedLang: null,
      translatedRoutes: {},
    });
  });
});

describe('fetchJobsChVacancyInOriginalLanguage', () => {
  it('follows the original-language route when /en/ serves a translation', async () => {
    const { fetchPage, fetched } = sourceStub();
    const vacancy = await fetchJobsChVacancyInOriginalLanguage(EN_URL, { fetchPage });
    expect(fetched).toEqual([EN_URL, DE_URL]);
    expect(vacancy.url).toBe(DE_URL);
    expect(vacancy.sourceLang).toBe('de');
    expect(vacancy.translated).toBe(false);
    expect(vacancy.html).toContain('Bei STRABAG bauen');
  });

  it('does not refetch a vacancy already served in its own language', async () => {
    const enOriginal = EN_PAGE.replace('"originalLanguage":"de"', '"originalLanguage":"en"');
    const { fetchPage, fetched } = sourceStub({ [EN_URL]: () => enOriginal });
    const vacancy = await fetchJobsChVacancyInOriginalLanguage(EN_URL, { fetchPage });
    expect(fetched).toEqual([EN_URL]);
    expect(vacancy).toMatchObject({ url: EN_URL, sourceLang: 'en', translated: false });
  });

  it('keeps the vacancy (as a labelled translation) when the original route fails', async () => {
    const { fetchPage } = sourceStub({ [DE_URL]: () => { throw new Error('fetch failed'); } });
    const vacancy = await fetchJobsChVacancyInOriginalLanguage(EN_URL, { fetchPage });
    expect(vacancy).toMatchObject({ url: EN_URL, sourceLang: null, translated: true });
  });

  it('refuses an original-language route that points at another vacancy', async () => {
    const foreignRoute = EN_PAGE.replace(`\\u002Fde\\u002Fstellenangebote\\u002Fdetail\\u002F${UUID}`, '\\u002Fde\\u002Fstellenangebote\\u002Fdetail\\u002Faaaaaaaa-0000-0000-0000-000000000000');
    const { fetchPage, fetched } = sourceStub({ [EN_URL]: () => foreignRoute });
    const vacancy = await fetchJobsChVacancyInOriginalLanguage(EN_URL, { fetchPage });
    expect(fetched).toEqual([EN_URL]);
    expect(vacancy.translated).toBe(true);
  });
});

describe.each([
  ['strabag', fetchAllStrabagJobs],
  ['hofweissbad', fetchAllHofweissbadJobs],
  ['visionapartments', fetchAllVisionapartmentsJobs],
  ['saint-gobain-weber-isover', fetchAllSaintGobainWeberIsoverJobs],
])('%s publishes the vacancy in the language it was written in', (key, fetchAll) => {
  it('German text, sourceLang de, original-language URL, unchanged id', async () => {
    const { fetchPage } = sourceStub();
    const jobs = await fetchAll({ fetchPage });
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job.sourceLang).toBe('de');
    expect(job.title).toBe('Baumaschinenmechaniker:in Spezialtiefbau');
    expect(job.description).toContain('Bei STRABAG bauen rund 89.000 Menschen');
    expect(job.description).not.toContain('At STRABAG');
    expect(job.descriptionByLocale).toEqual({ de: job.description });
    expect(job.url).toBe(DE_URL);
    expect(job.applyUrl).toBe(DE_URL);
    // The id stays hashed on the profile's /en/ link: records published before
    // this fix keep their identity.
    const urlHash = createHash('sha1').update(EN_URL).digest('hex').slice(0, 12);
    expect(job.id).toBe(`${key}-${urlHash}`);
  });

  it('keeps the vacancy when the original-language page cannot be read', async () => {
    const { fetchPage } = sourceStub({ [DE_URL]: () => { throw new Error('fetch failed'); } });
    const jobs = await fetchAll({ fetchPage });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe(EN_URL);
  });
});
