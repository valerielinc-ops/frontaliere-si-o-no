/**
 * The shared Workday crawl follows the orchestrated-crawl translation contract
 * (owner decision 2026-10-03, the same one SUPSI and USI follow): with
 * SKIP_AI_TRANSLATION=1 it makes no inline AI localization call, and the job
 * falls through to enrichJobLocalesDCC, which marks it for translate-pending.
 * Without the flag the inline path is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ aiLocalize: vi.fn() }));

vi.mock('../scripts/lib/ai-models.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/ai-models.mjs')>()),
  getPreferredModel: () => 'test-model',
}));
vi.mock('../scripts/lib/dedicated-crawler-common.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/dedicated-crawler-common.mjs')>()),
  aiLocalizeJobContentDCC: mocks.aiLocalize,
}));

import { __testables } from '../scripts/lib/shared-jobs-crawler.mjs';

const source = {
  endpoint: 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/jobs',
  origin: 'https://example.wd5.myworkdayjobs.com',
  appliedFacets: {},
};
const description = `<p>${'Wir suchen eine erfahrene Fachperson für die Finanzbuchhaltung in Lugano mit Verantwortung für Abschlüsse und Reporting. '.repeat(4)}</p>`;

function stubWorkday() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === source.endpoint) {
      return new Response(JSON.stringify({
        total: 1,
        jobPostings: [{
          title: 'Senior Finance Engineer',
          externalPath: '/job/Lugano/senior-finance-engineer',
          locationsText: 'Lugano, Switzerland',
          postedOn: 'Posted Today',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/wday/cxs/') && url.includes('/job/')) {
      return new Response(JSON.stringify({
        jobPostingInfo: { jobDescription: description, location: 'Lugano, Switzerland' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('<html><body><h1>Senior Finance Engineer</h1></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });
}

const config = { aiLocalizationEnabled: true, aiLocalizationMaxJobsPerRun: 5 };

describe('crawlWorkdayJobs — SKIP_AI_TRANSLATION', () => {
  beforeEach(() => {
    mocks.aiLocalize.mockReset();
    mocks.aiLocalize.mockResolvedValue(null);
    stubWorkday();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('makes no inline AI localization call inside the orchestrated crawl', async () => {
    vi.stubEnv('SKIP_AI_TRANSLATION', '1');
    const jobs = await __testables.crawlWorkdayJobs({ name: 'Example Company' }, source, config);
    expect(jobs).toHaveLength(1);
    expect(mocks.aiLocalize).not.toHaveBeenCalled();
  });

  it('still localizes inline outside the orchestrated crawl', async () => {
    vi.stubEnv('SKIP_AI_TRANSLATION', '');
    const jobs = await __testables.crawlWorkdayJobs({ name: 'Example Company' }, source, config);
    expect(jobs).toHaveLength(1);
    expect(mocks.aiLocalize).toHaveBeenCalledTimes(1);
  });
});
