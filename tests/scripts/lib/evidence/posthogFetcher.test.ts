import { describe, expect, it, vi } from 'vitest';

import * as phMod from '../../../../scripts/lib/evidence/posthogFetcher.mjs';

const { fetchPosthogPages } = phMod as any;

function jsonRes(body: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('fetchPosthogPages', () => {
  it('aggregates newsletter_signup events per page path', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({
        results: [
          ['/articoli-frontaliere/stipendio/', 7],
          ['/articoli-frontaliere/lamal/', 3],
          ['/calcola-stipendio/', 0], // dropped (n < 1)
        ],
      }),
    );

    const result = await fetchPosthogPages({
      apiKey: 'k',
      projectId: '123',
      host: 'https://eu.posthog.com',
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
    });

    expect(result.error).toBeUndefined();
    expect(result.pages['/articoli-frontaliere/stipendio/']).toEqual({ newsletterSignups: 7 });
    expect(result.pages['/articoli-frontaliere/lamal/']).toEqual({ newsletterSignups: 3 });
    expect(result.pages['/calcola-stipendio/']).toBeUndefined();
  });

  it('normalises absolute URLs to pathname', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({
        results: [['https://frontaliereticino.ch/articoli-frontaliere/foo/', 2]],
      }),
    );
    const result = await fetchPosthogPages({
      apiKey: 'k',
      projectId: '123',
      host: 'https://eu.posthog.com',
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
    });
    expect(result.pages['/articoli-frontaliere/foo/'].newsletterSignups).toBe(2);
  });

  it('returns error key when API is unavailable (does not throw)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'oops',
    }));
    const result = await fetchPosthogPages({
      apiKey: 'k',
      projectId: '123',
      host: 'https://eu.posthog.com',
      startDate: '2026-02-01',
      endDate: '2026-05-01',
      fetchImpl,
    });
    expect(result.error).toContain('500');
    expect(result.pages).toEqual({});
  });

  it('returns error when credentials missing', async () => {
    const original = {
      key: process.env.POSTHOG_PERSONAL_API_KEY,
      project: process.env.POSTHOG_PROJECT_ID,
    };
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
    try {
      const result = await fetchPosthogPages({
        startDate: '2026-02-01',
        endDate: '2026-05-01',
        fetchImpl: vi.fn(),
      });
      expect(result.error).toContain('POSTHOG');
    } finally {
      if (original.key !== undefined) process.env.POSTHOG_PERSONAL_API_KEY = original.key;
      if (original.project !== undefined) process.env.POSTHOG_PROJECT_ID = original.project;
    }
  });
});
