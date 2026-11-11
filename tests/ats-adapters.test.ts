import { describe, expect, it } from 'vitest';
import {
  ProspectiveAdapter,
  ReflineAdapter,
  UmantisAdapter,
  JobsChAdapter,
  SwissDevJobsAdapter
} from '../scripts/lib/ats-adapters/index.mjs';

describe('ProspectiveAdapter', () => {
  const adapter = new ProspectiveAdapter();

  it('mappa correttamente un annuncio Prospective con campi svizzeri', () => {
    const raw = {
      viewkey: 'vk_12345',
      title: 'Polymechaniker EFZ',
      company: 'Stadler Rail AG',
      location: 'Bussnang',
      attributes: { canton: 'TG' },
      description: '<p>Lavora con noi</p>',
      directlink: 'https://jobs.stadlerrail.com/apply/12345'
    };

    const mapped = adapter.mapJob(raw);
    expect(mapped.id).toBe('prospective_vk_12345');
    expect(mapped.provider).toBe('prospective');
    expect(mapped.title).toBe('Polymechaniker EFZ');
    expect(mapped.company).toBe('Stadler Rail AG');
    expect(mapped.location).toBe('Bussnang');
    expect(mapped.canton).toBe('TG');
    expect(mapped.applicationUrl).toBe('https://jobs.stadlerrail.com/apply/12345');
    expect(mapped.publishedAt).toBeNull();
  });

  it('effettua fetch e paginazione con mock fetchFn', async () => {
    const mockFetch = async (url: string) => {
      if (url.includes('offset=0')) {
        return {
          ok: true,
          json: async () => ({
            total: 2,
            jobs: [{ viewkey: 'j1', title: 'Job 1' }]
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          total: 2,
          jobs: [{ viewkey: 'j2', title: 'Job 2' }]
        })
      };
    };

    const jobs = await adapter.fetchJobs('1000', { limit: 1, maxPages: 2, fetchFn: mockFetch as any });
    expect(jobs).toHaveLength(2);
    expect(jobs[0].id).toBe('prospective_j1');
    expect(jobs[1].id).toBe('prospective_j2');
  });
});

describe('ReflineAdapter', () => {
  const adapter = new ReflineAdapter();

  it('estrae customer e jobId univoco dall URL Refline canonico', () => {
    const url = 'https://apply.refline.ch/123456/0890/pub/1/index.html';
    const identity = adapter.extractJobIdentity(url);
    expect(identity).not.toBeNull();
    expect(identity?.customer).toBe('123456');
    expect(identity?.jobId).toBe('0890');
    expect(identity?.canonicalKey).toBe('refline_123456_0890');
  });

  it('estrae schema.org JobPosting e mappa i campi', () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "JobPosting",
              "title": "Dipl. Pflegefachperson HF",
              "hiringOrganization": { "name": "Inselspital Bern" },
              "jobLocation": { "address": { "addressLocality": "Bern", "addressRegion": "BE" } },
              "datePosted": "2026-11-01T08:00:00Z",
              "description": "<p>Reparto cure intense</p>"
            }
          </script>
        </head>
      </html>
    `;
    const jsonLd = adapter.extractJsonLdJobPosting(html);
    expect(jsonLd).not.toBeNull();
    const mapped = adapter.mapJobPosting(jsonLd, 'https://apply.refline.ch/insel/42/pub/de/index.html');
    expect(mapped?.id).toBe('refline_insel_42');
    expect(mapped?.title).toBe('Dipl. Pflegefachperson HF');
    expect(mapped?.company).toBe('Inselspital Bern');
    expect(mapped?.canton).toBe('BE');
    expect(mapped?.publishedAt).toBe('2026-11-01T08:00:00Z');
  });

  it('keeps an absent schema.org publication date unknown', () => {
    const mapped = adapter.mapJobPosting({ '@type': 'JobPosting', title: 'Engineer' }, 'https://apply.refline.ch/insel/43/pub/de/index.html');
    expect(mapped?.publishedAt).toBeNull();
  });
});

describe('UmantisAdapter', () => {
  const adapter = new UmantisAdapter();

  it('estrae data-pagination-next-href e le righe dei posti vacanti', () => {
    const html = `
      <div id="joblist">
        <a href="/Vacancies/101/Description/1">Software Architect</a>
        <a href="/Vacancies/102/Description/1">DevOps Engineer</a>
        <div data-pagination-next-href="?tc1=p2&_token=xyz">Next</div>
      </div>
    `;
    const { jobs, nextHref } = adapter.parseListingPage(html, 'https://jobs.bobst.com/Jobs/All');
    expect(jobs).toHaveLength(2);
    expect(jobs[0].id).toBe('umantis_101');
    expect(jobs[0].title).toBe('Software Architect');
    expect(nextHref).toBe('https://jobs.bobst.com/Jobs/All?tc1=p2&_token=xyz');
  });

  it('does not assign a crawl date to an Umantis job with no publication date', () => {
    expect(adapter.mapJob('101', 'Software Architect', 'Bobst', 'Mex', '<p>Role</p>', 'https://jobs.bobst.com/Vacancies/101/Description/en').publishedAt)
      .toBeNull();
  });
});

describe('JobsChAdapter', () => {
  const adapter = new JobsChAdapter();

  it('estrae annuncio da schema.org JobPosting incorporato', () => {
    const html = `
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Sviluppatore React Native",
          "hiringOrganization": "Banca del Sempione",
          "jobLocation": { "address": { "addressLocality": "Lugano", "addressRegion": "TI" } }
        }
      </script>
    `;
    const job = adapter.extractJobDataFromHtml(html, 'https://www.jobs.ch/de/stellenangebote/detail/999888/');
    expect(job).not.toBeNull();
    expect(job?.id).toBe('jobsch_999888');
    expect(job?.title).toBe('Sviluppatore React Native');
    expect(job?.company).toBe('Banca del Sempione');
    expect(job?.canton).toBe('TI');
    expect(job?.publishedAt).toBeNull();
  });

  it('keeps an absent initial-state publication date unknown', () => {
    const html = '<script>window.__INITIAL_STATE__ = {"job":{"id":"111","title":"Engineer"}};</script>';
    expect(adapter.extractJobDataFromHtml(html, 'https://www.jobs.ch/en/jobs/detail/111/')?.publishedAt).toBeNull();
  });
});

describe('SwissDevJobsAdapter', () => {
  const adapter = new SwissDevJobsAdapter();

  it('mappa le offerte light con stipendio annuale CHF e tecnologie', () => {
    const raw = {
      _id: 'sdj_555',
      name: 'Senior Fullstack Engineer',
      company: 'Fintech Lugano SA',
      actualCity: 'Lugano',
      annualSalaryFrom: 115000,
      annualSalaryTo: 140000,
      technologies: ['TypeScript', 'Go', 'Docker'],
      slug: 'senior-fullstack-engineer-fintech-lugano'
    };

    const mapped = adapter.mapLightJob(raw);
    expect(mapped?.id).toBe('swissdevjobs_sdj_555');
    expect(mapped?.salaryMin).toBe(115000);
    expect(mapped?.salaryMax).toBe(140000);
    expect(mapped?.salaryCurrency).toBe('CHF');
    expect(mapped?.skills).toContain('Go');
    expect(mapped?.publishedAt).toBeNull();
  });

  it('estrae il detailedJob dal blocco script della pagina', () => {
    const html = `
      <html>
        <script>
          window.__detailedJob = {"jobId":"sdj_777","body":"<p>Great tech stack</p>"};
        </script>
      </html>
    `;
    const detailed = adapter.extractDetailedJob(html);
    expect(detailed).not.toBeNull();
    expect(detailed?.jobId).toBe('sdj_777');
  });
});
