import { beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import { synthesizeSpec } from '../scripts/lib/prospector/synthesize.mjs';
import { scheduleSynthesisRetry } from '../scripts/lib/prospector/candidate-store.mjs';

describe('Prospector synthesis transient source failures', () => {
  beforeEach(() => politeFetch.mockReset());

  it('marks exhausted transient HTTP responses retryable', async () => {
    politeFetch.mockResolvedValue({ ok: false, status: 503, url: 'https://employer.example/jobs', body: '' });

    await expect(synthesizeSpec({
      careersUrl: 'https://employer.example/jobs',
      domain: 'employer.example',
      name: 'Employer',
    })).resolves.toMatchObject({
      spec: null,
      reason: 'seed irraggiungibile (503)',
      vacancies: [],
      retryable: true,
    });
  });

  it.each([
    ['permanent 404', { status: 404 }, false],
    ['robots block', { status: 0, blockedByRobots: true }, false],
    ['URL policy block', { status: 0, policyBlocked: true }, false],
    ['invalid URL response without transport evidence', { status: 0 }, false],
    ['transient transport failure', { status: 0, transportError: 'timeout' }, true],
  ])('classifies %s without turning it into an empty success', async (_label, response, retryable) => {
    politeFetch.mockResolvedValue({
      ok: false,
      url: 'https://employer.example/jobs',
      body: '',
      ...response,
    });

    await expect(synthesizeSpec({
      careersUrl: 'https://employer.example/jobs',
      domain: 'employer.example',
      name: 'Employer',
    })).resolves.toMatchObject({ spec: null, retryable });
  });

  it('keeps the candidate retryable if any attempted seed had a transient failure', async () => {
    politeFetch
      .mockResolvedValueOnce({ ok: false, status: 503, url: 'https://employer.example/jobs', body: '' })
      .mockResolvedValueOnce({ ok: false, status: 404, url: 'https://employer.example/careers', body: '' });

    await expect(synthesizeSpec({
      careersUrl: 'https://employer.example/jobs',
      careersUrls: ['https://employer.example/careers'],
      domain: 'employer.example',
      name: 'Employer',
    })).resolves.toMatchObject({
      spec: null,
      reason: 'seed irraggiungibile (503)',
      reasonCode: 'transient_seed_failure',
      retryable: true,
    });
  });

  it('keeps a reachable seed with no extractable vacancies retryable', async () => {
    politeFetch.mockResolvedValue({
      ok: true,
      url: 'https://employer.example/jobs',
      body: '<html><body><h1>Careers</h1></body></html>',
    });

    await expect(synthesizeSpec({
      careersUrl: 'https://employer.example/jobs',
      domain: 'employer.example',
      name: 'Employer',
    })).resolves.toMatchObject({
      spec: null,
      reason: 'nessun annuncio estratto dal seed',
      reasonCode: 'no_verified_vacancies',
      retryable: true,
      diagnostics: { attemptedUrls: 1, reachablePages: 1 },
    });
  });

  it('caps repeated synthesis retries and leaves the final no-vacancy reason terminally recoverable', () => {
    expect(scheduleSynthesisRetry({ synthesisAttempts: 5 }, 'no verified vacancies', Date.parse('2026-10-20T12:00:00.000Z'))).toMatchObject({
      synthesisRetryable: false,
      synthesisRetryExhausted: true,
      synthesisRetryAt: null,
      synthesisAttempts: 6,
    });
  });

  it('tries a second source-backed career URL when the preferred seed has no vacancies', async () => {
    const jobPosting = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Tecnico di manutenzione',
      description: 'Cerchiamo una persona esperta per la manutenzione di impianti industriali e la collaborazione con il nostro team tecnico.',
      url: 'https://employer.example/jobs/123',
    };
    const pages = new Map([
      ['https://employer.example/old-jobs', '<html><body>Keine offenen Stellen</body></html>'],
      ['https://employer.example/jobs', `<script type="application/ld+json">${JSON.stringify(jobPosting)}</script>`],
    ]);
    politeFetch.mockImplementation(async (url) => ({
      ok: true,
      url: String(url),
      body: pages.get(String(url)) || '',
    }));

    const result = await synthesizeSpec({
      careersUrl: 'https://employer.example/old-jobs',
      careersUrls: ['https://employer.example/jobs'],
      domain: 'employer.example',
      name: 'Employer',
    });

    expect(politeFetch).toHaveBeenCalledTimes(2);
    expect(result.spec).toMatchObject({ seedUrls: ['https://employer.example/jobs'], mode: 'jsonld' });
    expect(result.vacancies).toHaveLength(1);
  });

  it('follows a same-origin careers link discovered on a reachable homepage', async () => {
    const jobPosting = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Tecnico di manutenzione',
      description: 'Cerchiamo una persona esperta per la manutenzione di impianti industriali e la collaborazione con il nostro team tecnico.',
      url: 'https://employer.example/jobs/123',
    };
    politeFetch.mockImplementation(async (url) => ({
      ok: true,
      url: String(url),
      body: String(url) === 'https://employer.example/'
        ? '<html><body><a href="/jobs">Careers</a></body></html>'
        : `<script type="application/ld+json">${JSON.stringify(jobPosting)}</script>`,
    }));

    const result = await synthesizeSpec({ domain: 'employer.example', name: 'Employer' });

    expect(politeFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://employer.example/',
      'https://employer.example/jobs',
    ]);
    expect(result.spec).toMatchObject({ seedUrls: ['https://employer.example/jobs'] });
  });
});
