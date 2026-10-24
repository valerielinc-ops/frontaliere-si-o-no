import { beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import { synthesizeSpec } from '../scripts/lib/prospector/synthesize.mjs';
import { scheduleSynthesisRetry } from '../scripts/lib/prospector/candidate-store.mjs';
import { parseSynthesisLimit } from '../scripts/lib/prospector/synthesis-schedule.mjs';
import {
  normalizeSpecPagination,
  readDeclaredListingTotal,
} from '../scripts/lib/prospector/spec-crawler.mjs';

describe('Prospector synthesis transient source failures', () => {
  beforeEach(() => politeFetch.mockReset());

  it('rejects non-finite, fractional, and negative synthesis limits', () => {
    expect(parseSynthesisLimit('25')).toBe(25);
    expect(parseSynthesisLimit(0)).toBe(0);
    expect(() => parseSynthesisLimit('Infinity')).toThrow('--limit must be a non-negative safe integer');
    expect(() => parseSynthesisLimit('1.5')).toThrow('--limit must be a non-negative safe integer');
    expect(() => parseSynthesisLimit('-1')).toThrow('--limit must be a non-negative safe integer');
  });

  it('marks exhausted transient HTTP responses retryable', async () => {
    politeFetch.mockResolvedValue({ ok: false, status: 503, url: 'https://employer.example/jobs', body: '' });

    await expect(synthesizeSpec({
      careersUrl: 'https://employer.example/jobs',
      name: 'Employer',
    })).resolves.toMatchObject({
      spec: null,
      reason: 'seed irraggiungibile (503)',
      vacancies: [],
      retryable: true,
    });
  });

  it('treats a missing fetch response as a retryable transport failure', async () => {
    politeFetch.mockResolvedValue(undefined);

    await expect(synthesizeSpec({
      careersUrl: 'https://employer.example/jobs',
      name: 'Employer',
    })).resolves.toMatchObject({
      spec: null,
      reason: 'seed irraggiungibile (0)',
      reasonCode: 'transient_seed_failure',
      retryable: true,
      diagnostics: { attemptedUrls: 1, reachablePages: 0, malformedResponses: 1 },
    });
  });

  it('treats a successful response without a string body as a retryable malformed response', async () => {
    politeFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://employer.example/jobs',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        url: 'https://employer.example/',
        body: '<html><body>No open positions</body></html>',
      });

    await expect(synthesizeSpec({
      careersUrl: 'https://employer.example/jobs',
      domain: 'employer.example',
      name: 'Employer',
    })).resolves.toMatchObject({
      spec: null,
      reason: 'seed irraggiungibile (200)',
      reasonCode: 'transient_seed_failure',
      retryable: true,
      diagnostics: { attemptedUrls: 2, reachablePages: 1, malformedResponses: 1 },
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
      .mockResolvedValueOnce({ ok: false, status: 404, url: 'https://employer.example/', body: '' })
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

    expect(politeFetch).toHaveBeenCalledTimes(3);
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

  it('emits the bounded Brefis pagination contract from the source index', async () => {
    const jobPosting = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Sanitärinstallateur/in EFZ',
      description: 'Wir suchen eine zuverlässige Fachperson für die Installation und Wartung von Sanitäranlagen in einem erfahrenen Team.',
      url: 'https://brefis.ch/Vacancyboard/Detail/46980',
    };
    politeFetch.mockResolvedValue({
      ok: true,
      url: 'https://brefis.ch/Vacancyboard/',
      body: '<html><body><h1>Offene Stellen <span class="count">48</span></h1>'
        + `<script type="application/ld+json">${JSON.stringify(jobPosting)}</script>`
        + '</body></html>',
    });

    const result = await synthesizeSpec({
      careersUrl: 'https://brefis.ch/Vacancyboard/',
      tenantHost: 'brefis.ch',
      domain: 'brefis.ch',
      name: 'brefis personal ag',
    });

    expect(result.spec).toMatchObject({
      pagination: { maxPages: 10, minCoverage: 0.95 },
    });
    const pagination = normalizeSpecPagination(result.spec);
    expect(readDeclaredListingTotal(
      '<h1>Offene Stellen <span class="count">48</span></h1>',
      pagination,
      result.spec,
    )).toBe(48);
  });

  it('does not refetch a supplied career seed when the discovered link only adds a fragment', async () => {
    politeFetch.mockImplementation(async (url) => ({
      ok: true,
      url: String(url),
      body: String(url) === 'https://employer.example/'
        ? '<html><body><a href="/jobs#open">Careers</a></body></html>'
        : '<html><body>No open positions</body></html>',
    }));

    await synthesizeSpec({
      careersUrl: 'https://employer.example/jobs',
      domain: 'employer.example',
      name: 'Employer',
    });

    expect(politeFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://employer.example/jobs',
      'https://employer.example/',
    ]);
  });

  it('reserves fetch attempts for tenant and employer homepages ahead of old career URLs', async () => {
    politeFetch.mockImplementation(async (url) => ({
      ok: true,
      url: String(url),
      body: '<html><body>No open positions</body></html>',
    }));

    await synthesizeSpec({
      careersUrl: 'https://ats.example/old-jobs',
      careersUrls: [
        'https://ats.example/old-jobs',
        'https://ats.example/archive/1',
        'https://ats.example/archive/2',
        'https://ats.example/archive/3',
        'https://ats.example/archive/4',
      ],
      tenantHost: 'tenant.ats.example',
      domain: 'employer.ch',
      name: 'Employer',
    });

    const attempted = politeFetch.mock.calls.map(([url]) => String(url));
    expect(attempted).toHaveLength(5);
    expect(attempted).toEqual([
      'https://ats.example/old-jobs',
      'https://tenant.ats.example/',
      'https://employer.ch/',
      'https://ats.example/archive/1',
      'https://ats.example/archive/2',
    ]);
  });

  it('tries tenant and employer homepages before following multiple links from the career seed', async () => {
    const attempted = [];
    const careerSeed = 'https://ats.example/old-jobs';
    politeFetch.mockImplementation(async (url) => {
      const current = String(url);
      attempted.push(current);
      return {
        ok: true,
        url: current,
        body: current === careerSeed
          ? '<a href="/dept/1">Careers information 1</a><a href="/dept/2">Careers information 2</a>'
            + '<a href="/dept/3">Careers information 3</a><a href="/dept/4">Careers information 4</a>'
          : '<html><body>No open positions</body></html>',
      };
    });

    await synthesizeSpec({
      careersUrl: careerSeed,
      tenantHost: 'tenant.ats.example',
      domain: 'employer.ch',
      name: 'Employer',
    });

    expect(attempted).toEqual([
      careerSeed,
      'https://tenant.ats.example/',
      'https://employer.ch/',
      'https://ats.example/dept/1',
      'https://ats.example/dept/2',
    ]);
    expect(attempted).toHaveLength(5);
  });

  it('follows a careers link discovered on the homepage before remaining seeds within the five-fetch budget', async () => {
    const attempted = [];
    politeFetch.mockImplementation(async (url) => {
      const current = String(url);
      attempted.push(current);
      return {
        ok: true,
        url: current,
        body: current === 'https://employer.example/'
          ? '<html><body><a href="/open-roles">Careers</a></body></html>'
          : '<html><body>No open positions</body></html>',
      };
    });

    await synthesizeSpec({
      careersUrl: 'https://employer.example/old-jobs',
      careersUrls: [
        'https://employer.example/old-jobs',
        'https://employer.example/archive/1',
        'https://employer.example/archive/2',
        'https://employer.example/archive/3',
        'https://employer.example/archive/4',
      ],
      domain: 'employer.example',
      name: 'Employer',
    });

    expect(attempted).toEqual([
      'https://employer.example/old-jobs',
      'https://employer.example/',
      'https://employer.example/open-roles',
      'https://employer.example/archive/1',
      'https://employer.example/archive/2',
    ]);
    expect(attempted).toHaveLength(5);
  });
});
