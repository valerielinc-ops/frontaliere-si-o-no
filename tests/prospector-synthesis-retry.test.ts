import { beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import { synthesizeSpec } from '../scripts/lib/prospector/synthesize.mjs';

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
});
