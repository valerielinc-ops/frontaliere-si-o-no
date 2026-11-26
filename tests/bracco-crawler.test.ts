/**
 * Bracco Suisse (Workday) runner — description fields.
 *
 * Fixture: the start of a live Workday `jobDescription` (Cadempino, 2026-09-29).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBraccoDescriptionFields,
  classifyBraccoFetchAbortKind,
  dropBraccoFabricatedText,
  fetchBraccoJobs,
} from '../scripts/update-bracco-jobs.mjs';
import { resetWorkdayImplicitRateLimitStateForTests } from '../scripts/lib/ats-clients/workday-client.mjs';
import { keepStoredSourceBodies } from '../scripts/lib/stored-source-body.mjs';

const TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'bracco', 'workday-description-cadempino.txt'), 'utf8').trim();

afterEach(() => {
  resetWorkdayImplicitRateLimitStateForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Bracco custom-main fetch abort taxonomy', () => {
  it('records an exhausted retryable HTTP response separately from a connection error', () => {
    expect(classifyBraccoFetchAbortKind(Object.assign(new Error('HTTP 429'), {
      status: 429,
      retryBudgetExhausted: true,
    }))).toBe('retryable-http-response');
    expect(classifyBraccoFetchAbortKind(new TypeError('fetch failed')))
      .toBe('connection-level-fetch');
    expect(classifyBraccoFetchAbortKind(Object.assign(new Error('HTTP 404'), {
      status: 404,
    }))).toBeNull();
  });
});

describe('Bracco crawl provenance', () => {
  it('retries a transient Workday 429 before accepting the listing', async () => {
    vi.useFakeTimers();
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    let listingAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/jobs')) {
        listingAttempts += 1;
        if (listingAttempts === 1) return new Response('', { status: 429 });
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Digital Learning & Training Internship',
            externalPath: '/job/CHE---Cadempino/Digital-Learning_R1',
            locationsText: 'Cadempino, Switzerland',
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          title: 'Digital Learning & Training Internship',
          location: 'Cadempino, Switzerland',
          jobDescription: TEXT,
          timeType: 'Full time',
          jobReqId: 'R1',
        },
      }), { status: 200 });
    }));

    const pending = fetchBraccoJobs();
    await vi.runAllTimersAsync();
    const [job] = await pending;

    expect(listingAttempts).toBe(2);
    expect(job.url).toContain('Digital-Learning_R1');
  });

  it('does not hide an exhausted detail retry as a partial listing', async () => {
    vi.useFakeTimers();
    vi.stubEnv('JOBS_CRAWLER_RETRIES', '1');
    vi.stubEnv('JOBS_CRAWLER_RETRY_BASE_MS', '0');
    let detailAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/jobs')) {
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Digital Learning & Training Internship',
            externalPath: '/job/CHE---Cadempino/Digital-Learning_R1',
            locationsText: 'Cadempino, Switzerland',
          }],
        }), { status: 200 });
      }
      detailAttempts += 1;
      return new Response('', { status: 429 });
    }));

    const rejection = expect(fetchBraccoJobs({ browserFallback: null })).rejects.toMatchObject({
      retryExhausted: true,
      status: 429,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(detailAttempts).toBe(2);
  });

  it('propagates the successful Workday listing observation time', async () => {
    const observedAt = new Date('2026-10-13T10:20:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(observedAt);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/jobs')) {
        return new Response(JSON.stringify({
          total: 1,
          jobPostings: [{
            title: 'Digital Learning & Training Internship',
            externalPath: '/job/CHE---Cadempino/Digital-Learning_R1',
            locationsText: 'Cadempino, Switzerland',
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          title: 'Digital Learning & Training Internship',
          location: 'Cadempino, Switzerland',
          jobDescription: TEXT,
          timeType: 'Full time',
          jobReqId: 'R1',
        },
      }), { status: 200 });
    }));

    const pending = fetchBraccoJobs();
    await vi.runAllTimersAsync();
    const [job] = await pending;

    expect(job.crawledAt).toBe(observedAt.toISOString());
  });
});

describe('buildBraccoDescriptionFields', () => {
  it('publishes the Workday text alone, keyed by its language', () => {
    const fields = buildBraccoDescriptionFields('MEDICAL DEVICE SPECIALIST - ACIST', TEXT, 'Cadempino');
    expect(fields.description).toBe(TEXT);
    expect(fields.sourceLang).toBe('en');
    expect(fields.descriptionByLocale).toEqual({ en: TEXT });
    expect(fields.description).not.toContain('Bracco Suisse S.A. is part of the Bracco Group');
  });

  it('emits no body under the shared word floor, and such a job is not published', () => {
    for (const text of ['', 'Short Workday teaser for a QA Operator in Plan-les-Ouates.']) {
      const fields = buildBraccoDescriptionFields('QA Operator', text, 'Plan-les-Ouates');
      expect(fields.description).toBe('');
      expect(fields.description).not.toMatch(/position at Bracco/);
      const url = 'https://bracco.wd3.myworkdayjobs.com/en-US/Careers/job/Plan-les-Ouates/QA-Operator_R0001';
      // What the merge does with it: no stored source body → the job is omitted.
      expect(keepStoredSourceBodies([{ url, ...fields }], [], (u: string) => u)).toEqual([]);
      // A stored source body from an earlier read is kept instead.
      const kept = keepStoredSourceBodies([{ url, ...fields }], [{ url, sourceLang: 'en', description: TEXT, descriptionByLocale: { en: TEXT } }], (u: string) => u);
      expect(kept).toHaveLength(1);
      expect(kept[0].description).toBe(TEXT);
    }
  });
});

describe('dropBraccoFabricatedText', () => {
  it('removes the Italian blurb and the translations of the blurb-appended source', () => {
    const job: any = {
      sourceLang: 'en',
      descriptionByLocale: {
        en: `${TEXT}\n\nBracco Suisse S.A. is part of the Bracco Group, an international leader in diagnostic imaging and healthcare. Its Swiss vacancies are published from the complete Swiss source feed.`,
        it: "Posizione aperta presso Bracco Suisse S.A. a Cadempino.\nRuolo: MEDICAL DEVICE SPECIALIST.\n\nBracco Suisse S.A. fa parte del Gruppo Bracco, leader internazionale nell'imaging diagnostico.",
        de: 'Bracco ist eine internationale Gruppe … gehören zu den bekannten Büros.',
      },
    };
    expect(dropBraccoFabricatedText(job)).toBe(true);
    expect(Object.keys(job.descriptionByLocale)).toEqual(['en']);
    expect(job.needsRetranslation).toBe(true);
  });

  it('leaves a clean stored job alone', () => {
    const job: any = { sourceLang: 'en', descriptionByLocale: { en: TEXT, it: 'Bracco è un Gruppo internazionale attivo nel settore sanitario.' } };
    expect(dropBraccoFabricatedText(job)).toBe(false);
    expect(job.descriptionByLocale.it).toContain('Gruppo internazionale');
  });
});
