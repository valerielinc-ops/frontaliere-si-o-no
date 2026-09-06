import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCnpJobs } from '../scripts/lib/cnp-job-parser.mjs';

/**
 * Sibling of `kantonsspital-uri-rexx-crawler.test.ts` for the OTHER batch
 * parser #7082 hardened the same way: `jobup-ch-feed-common.mjs` discarded the
 * whole feed on the first row whose `lieu` the source places outside the Swiss
 * target (#7459 / #7461). A row the source itself excludes is one row.
 */

const FEED_URL = 'https://www.jobup.ch/masks/cnp/list_cnp.asp?cmd=json';

const BODY = 'Le Centre Neuchâtelois de Psychiatrie recherche une personne motivée pour '
  + 'rejoindre ses équipes pluridisciplinaires. Vous participez à la prise en charge '
  + 'ambulatoire et hospitalière des patients, en collaboration étroite avec les médecins, '
  + 'les infirmiers et les psychologues du réseau. Vous bénéficiez d\'un encadrement '
  + 'structuré, d\'une formation continue et de perspectives de développement au sein '
  + 'd\'une institution publique reconnue. Nous offrons des conditions de travail selon '
  + 'la convention collective, un environnement bienveillant et des horaires réguliers.';

function detailHtml(title: string) {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title,
    description: `<p>${BODY}</p>`,
  })}</script></head><body><h1>${title}</h1></body></html>`;
}

function feedRow(id: string, titre: string, lieu: string) {
  return { link: `https://www.jobup.ch/fr/emplois/detail/${id}/`, titre, lieu, ref: id, contrat: 'permanent' };
}

function stubFeed(rows: Array<ReturnType<typeof feedRow>>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(FEED_URL)) {
      return new Response(JSON.stringify({ jobs: rows, jobcount: rows.length }), { status: 200 });
    }
    const row = rows.find((r) => r.link === url);
    if (row) return new Response(detailHtml(row.titre), { status: 200 });
    return new Response('', { status: 404 });
  }));
}

describe('jobup.ch feed per-record quarantine', () => {
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

  it('quarantines only the row whose lieu the source places outside Switzerland', async () => {
    const rows = [
      feedRow('a1', 'Infirmier·ère en psychiatrie 80-100%', '2000 Neuchâtel'),
      feedRow('a2', 'Psychologue FSP 60%', '2300 La Chaux-de-Fonds'),
      feedRow('a3', 'Consultant international', 'Paris, France'),
    ];
    stubFeed(rows);

    const jobs = await fetchAllCnpJobs();

    expect(jobs.map((job: { url: string }) => job.url)).toEqual([rows[0].link, rows[1].link]);
  });

  it('still fails closed when the rejected rows are systemic rather than outliers', async () => {
    stubFeed([
      feedRow('a1', 'Infirmier·ère en psychiatrie 80-100%', '2000 Neuchâtel'),
      feedRow('a2', 'Psychologue FSP 60%', '2300 La Chaux-de-Fonds'),
      feedRow('a3', 'Aide-soignant·e 70%', '2400 Le Locle'),
      feedRow('a4', 'Consultant international', 'Paris, France'),
      feedRow('a5', 'Chef de projet', 'Lyon, France'),
      feedRow('a6', 'Responsable qualité', 'Besançon, France'),
    ]);

    await expect(fetchAllCnpJobs()).resolves.toEqual([]);
  });

  // #7702 (follow-up of #7609): on a listing this small the ratio has no
  // sample — two rows the source legitimately places abroad read as 67% and
  // used to suppress the live Swiss vacancy with them, which is the traffic
  // loss #7459 closed, restricted to the small tenants. Six of the eight
  // jobup.ch tenants publish four records or fewer, so this is their norm.
  it('publishes the surviving row when the listing is below the ratio sample floor', async () => {
    const rows = [
      feedRow('a1', 'Infirmier·ère en psychiatrie 80-100%', '2000 Neuchâtel'),
      feedRow('a2', 'Consultant international', 'Paris, France'),
      feedRow('a3', 'Chef de projet', 'Lyon, France'),
    ];
    stubFeed(rows);

    const jobs = await fetchAllCnpJobs();

    expect(jobs.map((job: { url: string }) => job.url)).toEqual([rows[0].link]);
  });
});
