/**
 * CHUV (Hireserve feed + vacancy page).
 *
 * Issue 5253: a vacancy page that was not read used to be published as a stub
 * assembled from the feed classifications ("<title> — CHUV · Département: … ·
 * Catégorie: … · Lieu: … · Taux d'activité: …"). Only the source's body above
 * the 50-word floor is published; below it the job stays out of the run and
 * the standard pipeline keeps the stored source body under its miss grace.
 * Fixtures are minimised feed and page shapes (the Hireserve `job_description`
 * block the parser reads); no `data/**` is read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllChuvJobs, FEED_URL } from '../scripts/lib/chuv-job-parser.mjs';

const SOURCE_WORDS = ('Le Service de médecine interne du CHUV recherche un-e infirmier-ère diplômé-e pour son unité de soins aigus. '
  + 'Vous assurez la prise en soins globale des patient-e-s hospitalisé-e-s, collaborez étroitement avec l équipe médicale et '
  + 'interprofessionnelle, participez à la formation des étudiant-e-s et contribuez aux projets qualité du service. Vous êtes titulaire '
  + 'd un diplôme d infirmier-ère reconnu en Suisse et justifiez d une expérience en médecine aiguë.').split(' ');
const text = (n: number) => SOURCE_WORDS.slice(0, n).join(' ');
const page = (body: string) => `<html><body><div class="job_description"><h1>Infirmier-ère en médecine interne</h1><p>${body}</p></div></body></html>`;

const FEED = {
  jobs: [{
    id: 101,
    title: 'Infirmier-ère en médecine interne',
    status: 'Open',
    display_in_list: 'Y',
    weblink: 'https://recrutement.chuv.ch/vacancy/101',
    locations: [{ city: 'Lausanne' }],
    classifications: {},
  }],
};

function stubChuv(page: string | null) {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (url === FEED_URL) return new Response(JSON.stringify(FEED), { status: 200 });
    return page === null ? new Response('', { status: 503 }) : new Response(page, { status: 200 });
  });
  return fetchAllChuvJobs();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAllChuvJobs — only a source body above the floor is published', () => {
  it('publishes the vacancy body under its own language', async () => {
    const [job] = await stubChuv(page(text(SOURCE_WORDS.length)));
    expect(job.sourceLang).toBe('fr');
    expect(job.description).toContain('unité de soins aigus');
  });

  it('does not publish a vacancy whose page could not be read, and invents no description', async () => {
    const jobs = await stubChuv(null);
    expect(jobs).toEqual([]);
    expect(JSON.stringify(jobs)).not.toMatch(/ — CHUV|Département:|Taux d'activité:/);
  });

  it('publishes a 50-word source body and not a 49-word one', async () => {
    expect(await stubChuv(page(text(49)))).toEqual([]);
    const [job] = await stubChuv(page(text(50)));
    expect(job.description.split(/\s+/)).toHaveLength(50);
  });
});
