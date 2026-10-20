import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCnpJobs } from '../scripts/lib/cnp-job-parser.mjs';
import { fetchAllPoleSantePaysEnhautJobs } from '../scripts/lib/pole-sante-pays-enhaut-job-parser.mjs';
import { createJobupChFeedParser } from '../scripts/lib/jobup-ch-feed-common.mjs';

const sourceDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const futureDay = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const timestamp = `${sourceDay}T23:30:00.123-03:00`;
const description = `<p>Vous accompagnez les résidentes et résidents dans les activités de la vie quotidienne et coordonnez les soins avec une équipe interdisciplinaire.</p><h2>Votre mission</h2><ul><li>Assurer des soins individualisés et documentés.</li><li>Collaborer avec les proches et les partenaires médicaux.</li></ul><h2>Votre profil</h2><p>Vous disposez d'un diplôme reconnu, d'une expérience clinique solide et d'excellentes compétences relationnelles.</p>`;
const url = 'https://www.jobup.ch/fr/emplois/detail/12345678-1234-1234-1234-123456789abc/';
function stubSource(rawDate: string | undefined) {
  const job = { titre: 'Infirmier référent', puddate: sourceDay.split('-').reverse().join('/'), lieu: "1660 Château-d'Oex",
    ref: 'Santé / Médecine', link: url, contrat: 'PERMANENT', occupationmin: '80', occupationmax: '100%' };
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: job.titre,
    description, datePosted: rawDate, dateCreated: sourceDay, dateModified: sourceDay, jobStartDate: sourceDay })}</script>`;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => new Response(
    String(input).includes('/masks/') ? JSON.stringify({ jobcount: '1', jobs: [job] }) : html,
    { status: 200 },
  )));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const company of [
  { key: 'cnp', fetchJobs: fetchAllCnpJobs },
  { key: 'pole-sante-pays-enhaut', fetchJobs: fetchAllPoleSantePaysEnhautJobs },
]) {
  describe(`${company.key} observed detail publication`, () => {
    it.each([
      ['day', sourceDay, sourceDay], ['timestamp', timestamp, timestamp],
      ['missing', undefined, ''], ['invalid', '2026-02-30', ''], ['future', futureDay, ''],
    ] as const)('%s never falls back to the feed date or clock', async (_label, raw, expected) => {
      stubSource(raw);
      const jobs = await company.fetchJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ companyKey: company.key, datePosted: expected, postedDate: expected,
        postingDateSource: expected ? 'reported' : 'unknown', url, canton: 'VD' });
      expect(jobs[0].description).toContain('soins individualisés');
      expect(jobs[0].crawledAt).toBeTruthy();
    });
  });
}
it('default factory leaves feed puddate unknown without explicit detail opt-in', async () => {
  stubSource(sourceDay);
  const parser = createJobupChFeedParser({ companyKey: 'contract-fixture', companyName: 'Fixture',
    companyDomain: 'example.test', jobupKey: 'fixture', defaultCanton: 'VD', defaultCity: "Château-d'Oex", defaultPostalCode: '1660' });
  const jobs = await parser.fetchAllJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
});
