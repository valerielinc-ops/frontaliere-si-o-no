import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  fetchAllRitualsCosmeticsJobs,
  ritualsSlugDisambiguator,
} from '../scripts/lib/rituals-cosmetics-job-parser.mjs';

/**
 * Rituals runs several concurrent Workday reqs for the same role in the same
 * city (live: R3932-R3935, four "Mitarbeiter Warenverräumung (m/w/d)" reqs at
 * Basel St Jakob Park). Without a per-req slug suffix they shared one route,
 * and the slice housekeeping archived all but one as within-slice duplicates
 * on every crawl (2026-09-30: 159 of 665 live reqs filed as expired), which
 * made data/jobs/expired/by-crawler/rituals-cosmetics.json swing between
 * ~40 KB and ~1 MB and tripped the accumulator byte guard downstream.
 */

const ORIGINAL_FETCH = global.fetch;
const PUBLIC_BASE = 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals';

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

type Posting = { title: string; locationsText: string; path: string; reqId: string };

const LONG_BODY = '<p>'
  + 'Responsibilities and requirements of the role, described at length by the employer. '.repeat(5)
  + '</p>';

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockRitualsTenant(postings: Posting[]) {
  global.fetch = vi.fn(async (url: any, init: any = {}) => {
    const href = String(url);
    if (init?.method === 'POST' && href.endsWith('/jobs')) {
      const body = JSON.parse(init.body || '{}');
      if (body.offset > 0) return json({ total: postings.length, jobPostings: [] });
      return json({
        total: postings.length,
        jobPostings: postings.map((posting) => ({
          title: posting.title,
          externalPath: posting.path,
          locationsText: posting.locationsText,
          postedOn: 'Posted Today',
          bulletFields: posting.reqId ? [posting.reqId] : [],
        })),
      });
    }
    const posting = postings.find((candidate) => href.endsWith(candidate.path));
    if (posting) {
      return json({
        jobPostingInfo: {
          title: posting.title,
          location: posting.locationsText,
          jobDescription: LONG_BODY,
        },
      });
    }
    return new Response('', { status: 404 });
  }) as any;
}

const TITLE = 'Mitarbeiter Warenverräumung (m/w/d)';
const LEGACY_SLUG = 'mitarbeiter-warenverraumung-m-w-d-rituals-cosmetics-ch';
const posting = (reqId: string, store = 'Basel St Jakob Park'): Posting => ({
  title: TITLE,
  locationsText: store,
  path: `/job/${store.replace(/\s+/g, '-')}/Mitarbeiter-Warenverrumung--m-w-d-_${reqId}`,
  reqId,
});
const idOf = (p: Posting) => `rituals-cosmetics-${createHash('sha1').update(`${PUBLIC_BASE}${p.path}`).digest('hex').slice(0, 12)}`;

function quiet() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('Rituals Cosmetics slug disambiguator', () => {
  it('gives every unpublished same-role req in the same store its own route', async () => {
    quiet();
    const reqs = ['R3932', 'R3933', 'R3934', 'R3935'].map((reqId) => posting(reqId));
    mockRitualsTenant(reqs);

    const jobs: any[] = await fetchAllRitualsCosmeticsJobs();

    expect(jobs).toHaveLength(4);
    expect(new Set(jobs.map((job) => job.slug)).size).toBe(4);
    for (const job of jobs) {
      const reqId = String(job.jobReqId).toLowerCase();
      expect(job.slugDisambiguator).toBe(reqId);
      expect(job.slug).toBe(`${LEGACY_SLUG}-${reqId}`);
      expect(job.slugByLocale).toEqual({ [job.sourceLang]: job.slug });
    }
  }, 20_000);

  it('keeps the indexed route of a published req and suffixes only the new one beside it', async () => {
    quiet();
    const legacy = posting('R3291');
    const fresh = posting('R3390');
    mockRitualsTenant([legacy, fresh]);
    const existingJobs = [{
      id: idOf(legacy),
      jobReqId: 'R3291',
      companyKey: 'rituals-cosmetics',
      company: 'Rituals Cosmetics Switzerland',
      slug: 'collaboratore-trice-warenverraumung-m-w-d-rituals-cosmetics-switzerland-basel',
      slugByLocale: { de: LEGACY_SLUG },
    }];

    const jobs: any[] = await fetchAllRitualsCosmeticsJobs({ existingJobs });
    const byReq = new Map(jobs.map((job) => [job.jobReqId, job]));

    // Published legacy req: byte-identical to what the parser emitted before,
    // so the merge keeps its live slugs and no migration is requested.
    expect(byReq.get('R3291').slug).toBe(LEGACY_SLUG);
    expect(byReq.get('R3291')).not.toHaveProperty('slugDisambiguator');
    // The unpublished req beside it no longer collides with it.
    expect(byReq.get('R3390').slug).toBe(`${LEGACY_SLUG}-r3390`);
    expect(byReq.get('R3390').slugDisambiguator).toBe('r3390');
  }, 20_000);

  it('re-emits the suffix a published req was minted with', async () => {
    quiet();
    const minted = posting('R3950', 'Schoenbuehl Shoppyland');
    mockRitualsTenant([minted]);
    const existingJobs = [{
      id: idOf(minted),
      jobReqId: 'R3950',
      companyKey: 'rituals-cosmetics',
      slug: `${LEGACY_SLUG}-r3950`,
      slugDisambiguator: 'r3950',
    }];

    const [job]: any[] = await fetchAllRitualsCosmeticsJobs({ existingJobs });

    expect(job.slugDisambiguator).toBe('r3950');
    expect(job.slug).toBe(`${LEGACY_SLUG}-r3950`);
  }, 20_000);

  it('matches a published req by job id when the requisition ID is missing', async () => {
    quiet();
    const legacy = posting('R4001');
    mockRitualsTenant([legacy]);
    const existingJobs = [{ id: idOf(legacy), companyKey: 'rituals-cosmetics', slug: LEGACY_SLUG }];

    const [job]: any[] = await fetchAllRitualsCosmeticsJobs({ existingJobs });

    expect(job.slug).toBe(LEGACY_SLUG);
    expect(job).not.toHaveProperty('slugDisambiguator');
  }, 20_000);

  it('ignores another employer with the same requisition ID', async () => {
    quiet();
    mockRitualsTenant([posting('R2404')]);
    const existingJobs = [{ id: 'other-1', jobReqId: 'R2404', companyKey: 'other', company: 'Other AG', url: 'https://other.example/jobs/R2404' }];

    const [job]: any[] = await fetchAllRitualsCosmeticsJobs({ existingJobs });

    expect(job.slugDisambiguator).toBe('r2404');
  }, 20_000);

  it('derives the suffix from the requisition ID, falling back to the posting URL', () => {
    expect(ritualsSlugDisambiguator('R3932', `${PUBLIC_BASE}/job/x_R3932`)).toBe('r3932');
    const url = `${PUBLIC_BASE}/job/x`;
    expect(ritualsSlugDisambiguator('', url)).toBe(createHash('sha1').update(url).digest('hex').slice(0, 8));
    expect(ritualsSlugDisambiguator('', '')).toBe('');
  });
});
