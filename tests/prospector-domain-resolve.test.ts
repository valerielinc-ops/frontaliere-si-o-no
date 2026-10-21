import { beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import { resolveDomain } from '../scripts/lib/prospector/domain-resolve.mjs';

describe('Prospector domain resolution outcomes', () => {
  beforeEach(() => politeFetch.mockReset());

  it('distinguishes transient network failures from a complete unsuccessful guess set', async () => {
    let calls = 0;
    politeFetch.mockImplementation(async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 503, body: '' }
        : { ok: false, status: 404, body: '' };
    });

    await expect(resolveDomain({ name: 'Alpha Swiss Consulting' })).resolves.toMatchObject({
      domain: null,
      retryable: true,
      failureStatuses: expect.arrayContaining([503, 404]),
    });

    politeFetch.mockResolvedValue({ ok: false, status: 404, body: '' });
    await expect(resolveDomain({ name: 'Alpha Swiss Consulting' })).resolves.toMatchObject({
      domain: null,
      retryable: false,
      failureStatuses: expect.arrayContaining([404]),
    });
  });

  it('keeps failure metadata when an early guess has partial ownership evidence', async () => {
    let calls = 0;
    politeFetch.mockImplementation(async (url: string) => {
      calls++;
      return calls === 1
        ? {
          ok: true,
          status: 200,
          url: String(url),
          body: `<title>Careers</title><body>${'Alpha Swiss AG offers employment and services at 8001 Zürich, Switzerland. '.repeat(8)}</body>`,
        }
        : { ok: false, status: 503, body: '' };
    });

    await expect(resolveDomain({ name: 'Alpha Swiss AG', zip: '8001' })).resolves.toMatchObject({
      domain: expect.any(String),
      retryable: true,
      failureStatuses: expect.arrayContaining([503]),
    });
  });
});
