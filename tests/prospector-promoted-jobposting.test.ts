import { describe, expect, it, vi } from 'vitest';
import { buildJobPostingFacts, buildJobPostingSchema } from '../build-plugins/shared/jobPostingSchema';

const specListings = vi.hoisted(() => ({
  christinavassalli: {
    title: 'Pflegefachperson',
    location: 'Lugano',
    description: 'Diese Stelle bietet eine abwechslungsreiche Aufgabe mit Verantwortung, Zusammenarbeit im Team und direktem Kontakt zu den betreuten Menschen. Weitere Informationen und Anforderungen stehen auf der vollständigen Stellenanzeige.',
    url: 'https://christinavassalli.ch/jobs/pflegefachperson/',
  },
  premiumpflege24: {
    title: 'Diplomierte Pflegefachperson',
    location: 'Lugano',
    description: 'Diese Stelle bietet eine abwechslungsreiche Aufgabe mit Verantwortung, Zusammenarbeit im Team und direktem Kontakt zu den betreuten Menschen. Weitere Informationen und Anforderungen stehen auf der vollständigen Stellenanzeige.',
    url: 'https://premiumpflege24.ch/jobs/pflegefachperson/',
  },
}));

vi.mock('../scripts/lib/prospector/spec-crawler.mjs', () => ({
  createSpecUrlPolicy: () => ({
    dispatcher: { close: async () => {} },
  }),
  fetchRuntimePage: async () => null,
  loadSpec: (companyKey: string) => ({ companyKey }),
  runSpecInProduction: async (spec: { companyKey: keyof typeof specListings }) => [specListings[spec.companyKey]],
}));

import { fetchAllChristinavassalliJobs } from '../scripts/lib/christinavassalli-job-parser.mjs';
import { fetchAllPremiumpflege24Jobs } from '../scripts/lib/premiumpflege24-job-parser.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('promoted Prospector parsers — JobPosting mandatory fields', () => {
  it.each([
    ['christinavassalli', fetchAllChristinavassalliJobs],
    ['premiumpflege24', fetchAllPremiumpflege24Jobs],
  ] as const)('%s keeps unverified listings ineligible while preserving facts and verified mandatory fields', async (_key, fetchJobs) => {
    const [job] = await fetchJobs();

    expect(job).toHaveProperty('postalCode', '');
    expect(job).toHaveProperty('streetAddress', '');
    expect(job.baseSalary?.value?.minValue).toBeGreaterThan(0);

    for (const locale of LOCALES) {
      const schema = buildJobPostingSchema(job, {
        locale,
        url: `https://frontaliereticino.ch/lavoro/${locale}/${job.slug}/`,
        now: new Date(),
      });

      expect(schema).toBeNull();
      expect(job.title).toBeTruthy();
      expect(job.url).toBe(specListings[_key].url);
      expect(buildJobPostingFacts(job, locale).hiringOrganization.name).toBeTruthy();
      // A separate positively sourced fixture preserves the mandatory contract;
      // the undated parser output above must never be promoted to reported.
      const sourceDate = new Date(Date.now() - 86400000).toISOString();
      const verified = buildJobPostingSchema({ ...job, postingDateSource: 'reported', datePosted: sourceDate, postedDate: sourceDate }, {
        locale, url: `https://frontaliereticino.ch/lavoro/${locale}/${job.slug}/`, now: new Date(),
      });
      expect(verified).not.toBeNull();
      expect(verified?.datePosted).toBe(sourceDate);
      expect(verified?.baseSalary.value.minValue).toBeGreaterThan(0);
      expect(verified?.jobLocation.address.postalCode).toBeTruthy();
      expect(verified?.jobLocation.address.streetAddress).toBeTruthy();
    }
  });
});
