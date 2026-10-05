import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllArdentisJobs } from '../scripts/lib/ardentis-job-parser.mjs';
import { fetchAllHugJobs } from '../scripts/lib/hug-job-parser.mjs';
import { fetchAllImadJobs } from '../scripts/lib/imad-job-parser.mjs';
import { fetchAllHospiceGeneralJobs } from '../scripts/lib/hospice-general-job-parser.mjs';
import { buildJobPostingSchema, buildJobPostingFacts } from '../build-plugins/shared/jobPostingSchema';

afterEach(() => vi.unstubAllGlobals());

const consumers = [
  ['Ardentis1', fetchAllArdentisJobs],
  ['HUG', fetchAllHugJobs],
  ['Imad', fetchAllImadJobs],
  ['Hospicegeneral', fetchAllHospiceGeneralJobs],
] as const;

describe.each(consumers)('%s publication provenance through real client and consumer', (tenant, fetchJobs) => {
  it.each(['valid', 'missing', 'future', 'invalid', 'non-string', 'created-only'])('retains the job and validates %s releasedDate', async kind => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString().replace('Z', '+02:00');
    const releasedDate = kind === 'valid' ? past : kind === 'future'
      ? new Date(Date.now() + 3 * 86400000).toISOString()
      : kind === 'invalid' ? 'not-a-date' : kind === 'non-string' ? 123 : undefined;
    const posting = {
      id: 'publication-evidence', name: 'Infirmier diplômé', releasedDate,
      createdOn: kind === 'created-only' ? past : undefined,
      location: { city: 'Genève', region: 'GE', country: { code: 'CH' }, postalCode: '1201' },
      postingUrl: `https://jobs.smartrecruiters.com/${tenant}/publication-evidence`,
      applyUrl: `https://jobs.smartrecruiters.com/${tenant}/publication-evidence?oga=true`,
      jobAd: { sections: { jobDescription: { text: '<p>Soins et accompagnement des patients. Description source conservée.</p>' } } },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('api.smartrecruiters.com');
      expect(url.pathname).toContain(`/companies/${tenant}/postings`);
      return new Response(JSON.stringify(url.searchParams.has('limit')
        ? { totalFound: 1, content: [posting] } : posting), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const jobs = await fetchJobs();
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job).toMatchObject({
      datePosted: kind === 'valid' ? past : '',
      postedDate: kind === 'valid' ? past : '',
      postingDateSource: kind === 'valid' ? 'reported' : 'unknown',
    });
    expect(job.description).toContain('Description source conservée');
    expect(job.applyUrl).toContain('publication-evidence');
    expect(Number.isFinite(Date.parse(job.crawledAt))).toBe(true);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const schema = buildJobPostingSchema(job, { locale, url: job.url });
      if (kind === 'valid') expect(schema?.datePosted).toBe(past);
      else expect(schema).toBeNull();
      expect(buildJobPostingFacts(job, locale).hiringOrganization.name).toBeTruthy();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
