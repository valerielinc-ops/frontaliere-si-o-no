import { describe, expect, it, vi } from 'vitest';
import { JOB_ACTIVE_IDS_URL, JOB_DETAIL_BASE } from '../functions/src/assistedApplicationAiJob.js';
import { parseActiveJobIdIndex } from '../functions/src/assistedApplicationActiveJobIndex.js';
import { checkPostingLiveness, postingAddressOf, resolvePostingAddressOf } from '../functions/src/assistedApplicationLiveness.js';

const JOB_ID = 'medbase-ccaaa7fa003b';
const POSTING_URL = 'https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Frauenfeld/Apprenticeship_R15163';
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function makeFetch(activeIndex: () => Response) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (url === JOB_ACTIVE_IDS_URL) return activeIndex();
    if (url.includes('/wday/cxs/acme/Careers/jobs')) return json({ total: 0, jobPostings: [] });
    if (url.includes('/wday/cxs/acme/Careers/job/')) return json({ errorCode: 'S22', message: 'permission denied' }, 403);
    // The historical detail can remain HTTP 200 after the active inventory drops the posting.
    if (url.includes(`/data/job-detail/${JOB_ID}.json`)) return new Response(null, { status: 200 });
    return new Response('<html><body></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  });
  return { calls, fetchImpl };
}

function activeIndex(ids: string[], generatedAt = new Date().toISOString()) {
  return () => json({ schemaVersion: 1, generatedAt, total: ids.length, ids });
}

describe('assisted-application liveness active-ID corroboration', () => {
  it('gets the canonical page from published detail for a legacy order with a stale apply URL', async () => {
    const jobId = 'helsana-872317162e36';
    const staleApplyUrl = 'https://careers.helsana.ch/talentcommunity/apply/1426391333/?locale=de_DE';
    const postingUrl = 'https://careers.helsana.ch/job/it-management-assistenz-a-80-helsana-dubendorf-stettbach-homeoff/1426391333/';
    const detailUrl = `${JOB_DETAIL_BASE}/${encodeURIComponent(jobId)}.json`;
    const fetchImpl = vi.fn(async (url: string) => url === detailUrl
      ? json({
        description: 'Published posting description',
        applyUrl: staleApplyUrl,
        slugByLocale: { de: 'it-management-assistenz-a-80-helsana-dubendorf-stettbach-homeoff' },
      })
      : new Response('', { status: 404 }));

    await expect(resolvePostingAddressOf({
      job: { postingUrl: staleApplyUrl, applyUrl: staleApplyUrl },
      channel: { applyUrl: staleApplyUrl },
    }, { jobId, jobUrl: staleApplyUrl }, {
      fetchImpl, resolve: publicDns,
    })).resolves.toBe(postingUrl);
    expect(fetchImpl).toHaveBeenCalledWith(detailUrl, expect.anything());
  });

  it('prefers the canonical job posting URL over a legacy channel posting URL', () => {
    expect(postingAddressOf({
      channel: { postingUrl: 'https://example.test/talentcommunity/apply/stale' },
      job: { postingUrl: 'https://example.test/job/active', applyUrl: 'https://example.test/talentcommunity/apply/stale' },
    })).toBe('https://example.test/job/active');
    expect(postingAddressOf({
      channel: { postingUrl: 'https://example.test/talentcommunity/apply/stale' },
      job: { applyUrl: 'https://example.test/talentcommunity/apply/stale' },
    }, { jobUrl: 'https://example.test/job/active' })).toBe('https://example.test/job/active');
  });

  it('rejects an index containing IDs outside the shared job-ID grammar', () => {
    const generatedAt = new Date().toISOString();
    const payload = JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      total: 2,
      ids: ['ok', 'bad/id'],
    });

    expect(parseActiveJobIdIndex(new TextEncoder().encode(payload))).toBeNull();
  });

  it('refunds a Workday withdrawal when the fresh active inventory omits the ID, even if detail remains 200', async () => {
    const { calls, fetchImpl } = makeFetch(activeIndex(['another-active-job']));

    const result = await checkPostingLiveness({
      order: { jobId: JOB_ID, jobUrl: POSTING_URL },
      posting: { applyUrl: POSTING_URL },
      fetchImpl,
      resolve: publicDns,
    });

    expect(result).toMatchObject({ page: { result: 'expired', code: 'ats_api_gone' }, datasetGone: true, closed: true });
    expect(calls).toContain(`GET ${JOB_ACTIVE_IDS_URL}`);
    expect(calls).not.toContain(`HEAD https://cdn.frontaliereticino.ch/data/job-detail/${JOB_ID}.json`);
  });

  it('checks the actual posting page before a stale apply URL that redirects to the homepage', async () => {
    const applyUrl = 'https://careers.helsana.ch/talentcommunity/apply/1426391333/';
    const postingUrl = 'https://careers.helsana.ch/job/D%C3%BCbendorf-Stettbach-IT-Management-Assistenz/1426391333/';
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === JOB_ACTIVE_IDS_URL) return activeIndex([JOB_ID])();
      if (url === postingUrl) {
        const response = new Response(`<html><body>${'Helsana career posting. '.repeat(30)}<a>Jetzt bewerben</a></body></html>`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
        Object.defineProperty(response, 'url', { value: postingUrl });
        return response;
      }
      if (url === applyUrl) return new Response(null, { status: 301, headers: { location: '/' } });
      return new Response(null, { status: 404 });
    });
    const result = await checkPostingLiveness({
      order: { jobId: JOB_ID, jobUrl: applyUrl },
      posting: { postingUrl, applyUrl },
      fetchImpl,
      resolve: publicDns,
    });

    expect(result).toMatchObject({
      page: { result: 'active' },
      datasetGone: false,
      closed: false,
    });
    expect(calls).toContain(postingUrl);
    expect(calls).not.toContain(applyUrl);
  });

  it('fails closed when the ID is active or the membership index is empty, stale, or unavailable', async () => {
    const missingIndex = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
    const responses = [
      activeIndex([JOB_ID]),
      activeIndex(['another-active-job'], missingIndex),
      () => new Response(null, { status: 404 }),
      activeIndex([]),
    ];

    for (const indexResponse of responses) {
      const { fetchImpl } = makeFetch(indexResponse);
      const result = await checkPostingLiveness({
        order: { jobId: JOB_ID, jobUrl: POSTING_URL },
        posting: { applyUrl: POSTING_URL },
        fetchImpl,
        resolve: publicDns,
      });
      expect(result).toMatchObject({ page: { code: 'ats_api_gone' }, datasetGone: false, closed: false });
    }
  });
});
