import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
  fetchHtmlViaJinaWithRetry: vi.fn(),
}));

vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>()),
  fetchHtml: mocks.fetchHtml,
}));

vi.mock('../scripts/lib/jina-proxy.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/jina-proxy.mjs')>()),
  fetchHtmlViaJinaWithRetry: mocks.fetchHtmlViaJinaWithRetry,
}));

import { fetchRehaAndeerListingHtml } from '../scripts/lib/reha-andeer-job-parser.mjs';

describe('Reha Andeer listing fetch', () => {
  afterEach(() => {
    mocks.fetchHtml.mockReset();
    mocks.fetchHtmlViaJinaWithRetry.mockReset();
    vi.restoreAllMocks();
  });

  it('rescues a source-specific HTTP 404 through verified clean-egress HTML', async () => {
    const error = Object.assign(new Error('HTTP 404 from https://reha-andeer.ch/offene-stellen/'), { status: 404 });
    mocks.fetchHtml.mockRejectedValueOnce(error);
    mocks.fetchHtmlViaJinaWithRetry.mockResolvedValueOnce(
      '<html><body><h1>Offene Stellen Reha Andeer</h1><a href="/wp-content/uploads/2026/07/Stelleninserat-Pflegehelferin.pdf">PDF</a></body></html>',
    );

    await expect(fetchRehaAndeerListingHtml({ timeoutMs: 1234 })).resolves.toContain('Offene Stellen');
    expect(mocks.fetchHtmlViaJinaWithRetry).toHaveBeenCalledWith(
      'https://reha-andeer.ch/offene-stellen/',
      { timeoutMs: 1234 },
    );
  });

  it('preserves the original 404 when clean-egress rescue cannot verify the page', async () => {
    const error = Object.assign(new Error('HTTP 404 from https://reha-andeer.ch/offene-stellen/'), { status: 404 });
    mocks.fetchHtml.mockRejectedValueOnce(error);
    mocks.fetchHtmlViaJinaWithRetry.mockResolvedValueOnce(null);

    await expect(fetchRehaAndeerListingHtml()).rejects.toThrow(/HTTP 404/);
  });
});
