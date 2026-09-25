import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { extractPageExecutiveDetailFields } from '../scripts/lib/prospector/pageexecutive-detail.mjs';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';
import { gradeExtraction } from '../scripts/lib/prospector/validate.mjs';

const fixture = fs.readFileSync(
  path.join(process.cwd(), 'tests', 'fixtures', 'pageexecutive-job-detail.html'),
  'utf8',
);

function response(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: async () => body,
  } as any;
}

describe('Prospector PageExecutive detail boundary', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('keeps all four authoritative sections and excludes page chrome', () => {
    const detail = extractPageExecutiveDetailFields(
      fixture,
      'https://www.pageexecutive.com/job-detail/head-legal/ref/jn-072026-7069175',
    );
    expect(detail.description).toContain('About Our Client\n');
    expect(detail.description).toContain('Job Description\n');
    expect(detail.description).toContain('The Successful Applicant\n');
    expect(detail.description).toContain("What's on Offer\n");
    expect(detail.description).toContain('• Lead the Swiss compliance framework');
    expect(detail.description).not.toContain('Recommended jobs in London');
    expect(detail.description).not.toContain('Navigation Legal Cookies');
    expect(detail.locationCandidates).toEqual([expect.objectContaining({
      location: 'Zürich, Switzerland',
      addressLocality: 'Zürich',
      addressCountry: 'CH',
    })]);
  });

  it('keeps locality and canton evidence separate when PageExecutive publishes both', () => {
    const detail = extractPageExecutiveDetailFields(
      fixture.replace('Zürich, Switzerland', 'Lausanne, Vaud'),
      'https://www.pageexecutive.com/job-detail/marketing-director/ref/jn-082026-7088394',
    );
    expect(detail.locationCandidates).toEqual([expect.objectContaining({
      location: 'Lausanne, Vaud',
      addressLocality: 'Lausanne',
      addressRegion: 'Vaud',
    })]);
  });

  it('fails closed instead of accepting related-card location or whole-page chrome', () => {
    const degraded = fixture
      .replace('<span class="job-location"><i class="map-marker"></i>Zürich, Switzerland</span>', '')
      .replaceAll('job_advert__job-desc-', 'unrecognised-');
    const detail = extractPageExecutiveDetailFields(
      degraded,
      'https://www.pageexecutive.com/job-detail/head-legal/ref/jn-072026-7069175',
    );
    expect(detail.locationCandidates).toEqual([]);
    expect(detail.location).toBe('');
    expect(detail.description).toBe('');
  });

  it('enriches only source-backed Swiss detail rows and keeps the canonical URL', async () => {
    const seed = 'https://www.pageexecutive.com/jobs/switzerland';
    const swiss = 'https://www.pageexecutive.com/job-detail/head-legal/ref/jn-072026-7069175';
    const foreign = 'https://www.pageexecutive.com/job-detail/hr-director/ref/jn-072026-7061111';
    const listing = `<a href="${swiss}">Head of Legal &amp; Compliance</a>
      <a href="${foreign}">HR Director</a>`;
    const foreignDetail = fixture
      .replace('Zürich, Switzerland', 'Austin, United States')
      .replace('Head of Legal &amp; Compliance Switzerland', 'HR Director');
    const fetchImpl = vi.fn(async (url: string, opts: any) => {
      expect(opts.headers['Accept-Encoding']).toBe('identity');
      if (url === 'https://www.pageexecutive.com/robots.txt') {
        return response(url, 'User-agent: *\nAllow: /');
      }
      if (url === seed) return response(url, listing);
      if (url === swiss) return response(url, fixture);
      if (url === foreign) return response(url, foreignDetail);
      throw new Error(`unexpected URL ${url}`);
    });
    const rows = await runSpecInProduction({
      companyKey: 'michaelpage',
      companyName: 'Michael Page',
      companyHost: 'pageexecutive.com',
      platform: 'pageexecutive.com',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/job-detail/*/ref/*',
      detailFetchWorkers: 1,
      sourceLang: 'en',
    } as any, {
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      headers: { 'Accept-Encoding': 'identity' },
    });

    expect(rows).toEqual([expect.objectContaining({
      url: swiss,
      location: 'Zürich, Switzerland',
      canton: 'ZH',
      addressLocality: 'Zürich',
      addressCountry: 'CH',
    })]);
    expect(rows[0].description.length).toBeGreaterThan(300);
    expect(fetchImpl).toHaveBeenCalledWith(swiss, expect.objectContaining({ redirect: 'manual' }));
  });

  it('grades the same PageExecutive detail and transport contract used at runtime', async () => {
    const seed = 'https://www.pageexecutive.com/jobs/switzerland';
    const detailUrl = 'https://www.pageexecutive.com/job-detail/head-legal/ref/jn-072026-7069175';
    const fetchImpl = vi.fn(async (url: string, opts: any) => {
      expect(opts.headers['Accept-Encoding']).toBe('identity');
      if (url === 'https://www.pageexecutive.com/robots.txt') {
        return response(url, 'User-agent: *\nAllow: /');
      }
      if (url === detailUrl) return response(url, fixture);
      throw new Error(`unexpected URL ${url}`);
    });
    const report = await gradeExtraction({
      companyKey: 'michaelpage',
      companyName: 'Michael Page',
      companyHost: 'pageexecutive.com',
      platform: 'pageexecutive.com',
      mode: 'template',
      seedUrls: [seed],
      detailTemplate: '/job-detail/*/ref/*',
    } as any, [{ title: 'Head of Legal & Compliance Switzerland', url: detailUrl }], {
      sampleSize: 1,
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
    });
    expect(report).toMatchObject({
      reachableRate: 1,
      contentfulRate: 1,
      locationSourceRate: 1,
    });
  });
});
