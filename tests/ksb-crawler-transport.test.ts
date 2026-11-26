import { afterEach, describe, expect, it, vi } from 'vitest';

const { launchStealthOrChromiumMock } = vi.hoisted(() => ({
  launchStealthOrChromiumMock: vi.fn(),
}));

vi.mock('../scripts/lib/stealth-browser.mjs', () => ({
  chromeUserAgent: () => 'Mozilla/5.0 Chrome/140.0.0.0',
  isStealthBrowser: () => false,
  launchStealthOrChromium: launchStealthOrChromiumMock,
}));

import { fetchAllKsbJobs } from '../scripts/lib/ksb-job-parser.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  launchStealthOrChromiumMock.mockReset();
});

describe('KSB Workday transport fallback', () => {
  it('bootstraps the browser on KSB German career page after a listing transport failure', async () => {
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const page = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      evaluate: vi.fn().mockImplementation(async (_fn, args) => {
        const url = String(args.requestUrl);
        if (url.endsWith('/jobs')) {
          return {
            status: 200,
            body: JSON.stringify({
              total: 1,
              jobPostings: [{
                title: 'Pflegefachperson Intensivpflege',
                externalPath: '/job/Baden/Pflegefachperson_R-10001',
                locationsText: 'Baden, Switzerland',
              }],
            }),
          };
        }
        if (url.endsWith('/sidebar')) return { status: 200, body: '[]' };
        return {
          status: 200,
          body: JSON.stringify({
            jobPostingInfo: {
              jobDescription: '<p>Für unsere Intensivstation suchen wir eine engagierte Pflegefachperson. Sie arbeiten eng mit Kolleginnen und Kollegen aus mehreren Bereichen zusammen, dokumentieren Ihre Arbeit sorgfältig, bringen Ideen zur Verbesserung der Abläufe ein und erhalten flexible Arbeitszeiten, Weiterbildungen sowie ein kollegiales Team in einem modernen Umfeld. Gute Deutschkenntnisse und eine strukturierte Arbeitsweise runden Ihr Profil ab.</p>',
              location: 'Baden, Switzerland',
              timeType: 'Full time',
            },
          }),
        };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      version: () => '140.0.0',
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    launchStealthOrChromiumMock.mockResolvedValue(browser);

    const jobs = await fetchAllKsbJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe('https://kantonsspitalbaden.wd3.myworkdayjobs.com/de-DE/ksb-careers/job/Baden/Pflegefachperson_R-10001');
    expect(page.goto).toHaveBeenCalledWith(
      'https://kantonsspitalbaden.wd3.myworkdayjobs.com/de-DE/ksb-careers',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
