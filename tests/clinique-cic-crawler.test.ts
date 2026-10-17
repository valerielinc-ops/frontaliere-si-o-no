import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractListingLinks,
  fetchAllCicJobs,
  isCicJob,
  isJobCloudListingProvenEmpty,
  isTrustedDomain,
  LISTING_URL,
} from '../scripts/lib/clinique-cic-job-parser.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';

const DETAIL_URL = 'https://company.jobcloud.ch/fr/jobs/clinique-cic-suisse/00000000-0000-0000-0000-000000000001/';
const FAILED_DETAIL_URL = 'https://company.jobcloud.ch/fr/jobs/clinique-cic-suisse/00000000-0000-0000-0000-000000000004/';
const PLACEHOLDER_SAXON_URL = 'https://company.jobcloud.ch/fr/jobs/clinique-cic-suisse/00000000-0000-0000-0000-000000000002/';
const PLACEHOLDER_CLARENS_URL = 'https://company.jobcloud.ch/fr/jobs/clinique-cic-suisse/00000000-0000-0000-0000-000000000003/';
const BODY = ('Rejoignez notre équipe soignante et accompagnez les patients dans un environnement clinique moderne et collaboratif. '
  + 'Vous participez aux soins, documentez les dossiers, collaborez avec les médecins et contribuez à la qualité de la prise en charge au quotidien. ').repeat(2).trim();

const response = (body: string, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

const listingHtml = (hrefs: string[]) => `<!doctype html><html><body>${hrefs.map((href) => `<a class="job_list_item-link" href="${href}?from=list">job</a>`).join('')}</body></html>`;

function detailHtml({
  title = 'Assistant·e en soins et santé communautaire (ASSC) à 80% - 100%',
  date = '25. September 2026',
  occupation = '80–100%',
  contract = 'Durée indéterminée',
  location = 'Clarens / 1907 Saxon',
  description = BODY,
  applyHref = 'https://www.jobup.ch/fr/application/create/cic-job-1/?utm_medium=referral&amp;utm_source=company',
}: Record<string, string> = {}) {
  return `<!doctype html><html><body>
    <main><h1>${title}</h1>
      <div class="text-rich-text w-richtext"><p>${description}</p></div>
      <div class="job_details_content-right"><div class="job_details_keyinfos">
        <div><div>Date de publication</div><div class="text-size-small">${date}</div></div>
        <div><div>Taux d'activité</div><div class="text-size-small">${occupation}</div></div>
        <div><div>Type de contrat:</div><div class="text-size-small">${contract}</div></div>
        <div><div>Lieu de travail</div><div class="text-size-small">${location}</div></div>
      </div><a id="job-ad-apply-btn" href="${applyHref}">Postuler</a></div>
    </main>
  </body></html>`;
}

describe('clinique CIC JobCloud parser', () => {
  beforeEach(() => {
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    process.env.JOBS_JINA_RETRY_BASE_MS = '0';
  });

  afterEach(() => {
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    delete process.env.JOBS_JINA_RETRY_BASE_MS;
    vi.restoreAllMocks();
  });

  it('extracts only CIC JobCloud detail links and canonicalizes their trailing slash', () => {
    const other = 'https://company.jobcloud.ch/fr/jobs/other-company/00000000-0000-0000-0000-000000000000';
    expect(extractListingLinks(listingHtml([DETAIL_URL, DETAIL_URL, other]))).toEqual([DETAIL_URL]);
  });

  it('matches the migrated source and keeps unrelated JobCloud pages out', () => {
    expect(isCicJob({ companyKey: 'clinique-cic' })).toBe(true);
    expect(isCicJob({ company: 'Clinique CIC Suisse', url: DETAIL_URL })).toBe(true);
    expect(isCicJob({ company: 'Other employer', url: 'https://company.jobcloud.ch/fr/jobs/other-company/00000000-0000-0000-0000-000000000000/' })).toBe(false);
    expect(isTrustedDomain(DETAIL_URL)).toBe(true);
    expect(isTrustedDomain('https://other.jobcloud.ch/fr/jobs/clinique-cic-suisse/cic-job-1/')).toBe(false);
  });

  it('maps the live JobCloud listing, drops spontaneous placeholders, and preserves source evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const target = String(input);
      if (target === LISTING_URL) return response(listingHtml([DETAIL_URL, PLACEHOLDER_SAXON_URL, PLACEHOLDER_CLARENS_URL]));
      if (target === DETAIL_URL) return response(detailHtml());
      if (target === PLACEHOLDER_SAXON_URL) return response(detailHtml({ title: 'Offres spontanées', date: '2. Juni 2025', location: 'Saxon' }));
      if (target === PLACEHOLDER_CLARENS_URL) return response(detailHtml({ title: 'Offres spontanées', date: '31. März 2025', location: 'Clarens' }));
      throw new Error(`unexpected URL ${target}`);
    }));

    const jobs = await fetchAllCicJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Assistant·e en soins et santé communautaire (ASSC) à 80% - 100%',
      location: 'Clarens',
      canton: 'VD',
      postalCode: '1815',
      employmentType: 'FULL_TIME',
      datePosted: '2026-09-25',
      postedDate: '2026-09-25',
      postingDateSource: 'reported',
      source: expect.stringContaining('JobCloud Company Page'),
      hiringOrganization: { name: 'Clinique CIC (Saxon & Clarens)' },
    });
    expect(jobs[0].url).toBe(DETAIL_URL);
    expect(jobs[0].applyUrl).toContain('&utm_source=company');
    expect(jobs[0].description).toBe(BODY);
    expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
  });

  it('stamps a zero only when every discovered detail is an explicit placeholder', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const target = String(input);
      if (target === LISTING_URL) return response(listingHtml([PLACEHOLDER_SAXON_URL, PLACEHOLDER_CLARENS_URL]));
      return response(detailHtml({ title: 'Offres spontanées' }));
    }));

    const jobs = await fetchAllCicJobs();

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
  });

  it('does not turn an unreadable listing into a proven empty snapshot', async () => {
    const html = '<html><body><div id="job-list">markup changed</div></body></html>';
    expect(isJobCloudListingProvenEmpty(html)).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input) === LISTING_URL) return response(html);
      throw new Error(`unexpected URL ${input}`);
    }));

    const jobs = await fetchAllCicJobs();

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('throws when every discovered detail fetch fails instead of publishing a zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input) === LISTING_URL) return response(listingHtml([DETAIL_URL]), 200);
      return response('', 503);
    }));

    await expect(fetchAllCicJobs()).rejects.toThrow(/HTTP 503/);
  });

  it('throws when one discovered detail fetch fails instead of publishing a partial subset', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const target = String(input);
      if (target === LISTING_URL) return response(listingHtml([DETAIL_URL, FAILED_DETAIL_URL]));
      if (target === DETAIL_URL) return response(detailHtml());
      if (target === FAILED_DETAIL_URL) return response('', 503);
      throw new Error(`unexpected URL ${target}`);
    }));

    await expect(fetchAllCicJobs()).rejects.toThrow(/HTTP 503/);
  });

  it('rejects a malformed accepted detail instead of publishing the other jobs as a partial snapshot', async () => {
    const malformedUrl = 'https://company.jobcloud.ch/fr/jobs/clinique-cic-suisse/00000000-0000-0000-0000-000000000005/';
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const target = String(input);
      if (target === LISTING_URL) return response(listingHtml([DETAIL_URL, malformedUrl]));
      if (target === DETAIL_URL) return response(detailHtml());
      if (target === malformedUrl) return response('<html><body><div class="text-rich-text w-richtext"><p>Detail content without a heading.</p></div></body></html>');
      throw new Error(`unexpected URL ${target}`);
    }));

    await expect(fetchAllCicJobs()).rejects.toThrow(/no usable title/);
  });

  it('rejects a detail whose source description is below the minimum instead of emitting an empty description', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const target = String(input);
      if (target === LISTING_URL) return response(listingHtml([DETAIL_URL]));
      if (target === DETAIL_URL) return response(detailHtml({ description: 'Soins aux patients.' }));
      throw new Error(`unexpected URL ${target}`);
    }));

    await expect(fetchAllCicJobs()).rejects.toThrow(/no source body meeting the minimum/);
  });

  it('resolves relative JobCloud application links against the detail URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const target = String(input);
      if (target === LISTING_URL) return response(listingHtml([DETAIL_URL]));
      if (target === DETAIL_URL) return response(detailHtml({ applyHref: '/fr/apply' }));
      throw new Error(`unexpected URL ${target}`);
    }));

    const jobs = await fetchAllCicJobs();

    expect(jobs[0].applyUrl).toBe('https://company.jobcloud.ch/fr/apply');
  });
});
