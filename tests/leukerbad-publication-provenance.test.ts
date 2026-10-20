import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllLeukerbadClinicJobs } from '../scripts/lib/leukerbad-clinic-job-parser.mjs';

const DE_LISTING = 'https://leukerbadclinic.ch/de/karriere/offene-stellen';
const FR_LISTING = 'https://leukerbadclinic.ch/fr/carriere/postes-vacants';
const now = new Date();
const pastDay = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
const futureDay = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);
const description = 'Nous recherchons une personne pour accompagner les patients en réadaptation, collaborer avec les équipes soignantes et participer aux soins dans notre clinique. Le poste implique une coordination attentive, une communication respectueuse et un travail quotidien avec une équipe interdisciplinaire expérimentée. Les missions comprennent la préparation des activités thérapeutiques, le suivi des objectifs individuels et la documentation des observations utiles. Chaque membre contribue à un environnement sûr, accueillant et adapté aux besoins de chaque personne accompagnée.';

const cases: ReadonlyArray<readonly [string, string]> = [
  ['a past work start', pastDay],
  ['a future work start', futureDay],
  ['an invalid calendar date', `${now.getUTCFullYear()}-02-30`],
  ['a by-arrangement work start', 'sofort oder nach Vereinbarung'],
  ['no work start', ''],
];

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Leukerbad publication provenance through the official HTML producer', () => {
  it.each(cases)('does not promote %s to publication evidence', async (_name, startingDate) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);

    const listings = [
      { lang: 'de', url: DE_LISTING, detailUrl: `${DE_LISTING}/pflegefachperson`, title: 'Pflegefachperson', applyUrl: 'https://leukerbadclinic.ch/de/karriere/bewerbung?offre=de-role' },
      { lang: 'fr', url: FR_LISTING, detailUrl: `${FR_LISTING}/infirmiere`, title: 'Infirmière en réadaptation', applyUrl: 'https://leukerbadclinic.ch/fr/carriere/candidature?offre=fr-role' },
    ] as const;
    const pages = new Map<string, string>();
    for (const listing of listings) {
      pages.set(listing.url, `<ul data-testid="liste-offres"><li><h3><a href="${listing.detailUrl}">${listing.title}</a></h3><p class="conditions">80 % · ${startingDate}</p></li></ul>`);
      pages.set(listing.detailUrl, `<main><h1>${listing.title}</h1><div class="corps-page corps-page--colonne"><p>${description}</p></div><a href="${listing.applyUrl}">Candidature</a></main>`);
    }

    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      const html = pages.get(url);
      if (!html) throw new Error(`Unexpected request ${url}`);
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }));

    const jobs = await fetchAllLeukerbadClinicJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.url)).toEqual(listings.map((listing) => listing.detailUrl));
    expect(jobs.map((job) => job.applyUrl)).toEqual(listings.map((listing) => listing.applyUrl));
    expect(jobs.every((job) => job.description.includes(description))).toBe(true);
    expect(jobs.every((job) => job.crawledAt === now.toISOString())).toBe(true);
    expect(jobs.every((job) => job.sourceConditions === (startingDate ? `80 % · ${startingDate}` : '80 %'))).toBe(true);
    expect(jobs.every((job) => job.postedDate === '' && job.datePosted === '' && job.postingDateSource === 'unknown')).toBe(true);
    expect(requests).toEqual([...listings.map((listing) => listing.url), ...listings.map((listing) => listing.detailUrl)]);
  });
});
