import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCicJobs } from '../scripts/lib/clinique-cic-job-parser.mjs';
import { __resetJinaBreaker } from '../scripts/lib/jina-proxy.mjs';

const MASK_URL = 'https://www.jobup.ch/masks/clinique-cic/list_clinique-cic.asp';
const DETAIL_URL = 'https://www.jobup.ch/fr/emplois/detail/cic-job-1/';
const AKAMAI_CHALLENGE = '<html><head><title>Challenge Validation</title></head><body>sec-cpt</body></html>';
const MASK_HTML = `
  <div class=job_offer>
    <a href="${DETAIL_URL}" title="Infirmier diplômé - 1907 Saxon" target="_blank">INFIRMIER DIPLÔMÉ</a>
  </div>
  <div class=job_location>Clinique CIC Saxon</div>
  <div class=job_lvlmin>CDI / 80%</div>
`;
const DETAIL_HTML = `<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  description: 'Rejoignez notre équipe soignante et accompagnez les patients dans un environnement clinique moderne et collaboratif.',
})}</script>`;

const response = (body: string) => ({
  ok: true,
  status: 200,
  text: async () => body,
});

describe('clinique CIC crawler', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.JOBS_JINA_RETRY_BASE_MS = '0';
    __resetJinaBreaker();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.JOBS_JINA_RETRY_BASE_MS;
    __resetJinaBreaker();
    vi.restoreAllMocks();
  });

  it('rescues a 200 Akamai challenge on the Jobup mask through Jina', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === MASK_URL) {
        return {
          ...response(''),
          arrayBuffer: async () => new TextEncoder().encode(AKAMAI_CHALLENGE).buffer,
        };
      }
      if (url.startsWith('https://r.jina.ai/')) return response(MASK_HTML.padEnd(240, ' '));
      if (url === DETAIL_URL) return response(DETAIL_HTML);
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const jobs = await fetchAllCicJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Infirmier diplômé');
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('https://r.jina.ai/'))).toHaveLength(1);
  });

  it('fails closed when the direct mask and every Jina rescue remain challenged', async () => {
    const challengedMask = `${AKAMAI_CHALLENGE}${MASK_HTML}`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === MASK_URL) {
        return {
          ...response(''),
          arrayBuffer: async () => new TextEncoder().encode(challengedMask).buffer,
        };
      }
      if (url.startsWith('https://r.jina.ai/')) return response(challengedMask.padEnd(240, ' '));
      if (url === DETAIL_URL) return response(DETAIL_HTML);
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const jobs = await fetchAllCicJobs();

    expect(jobs).toEqual([]);
    expect(fetchMock.mock.calls.filter(([url]) => url === DETAIL_URL)).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('https://r.jina.ai/')).length).toBeGreaterThan(0);
  });
});
