import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';

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

import {
  fetchAllRehaAndeerJobs,
  fetchRehaAndeerListingHtml,
  parseRehaAndeerListing,
} from '../scripts/lib/reha-andeer-job-parser.mjs';

describe('Reha Andeer listing fetch', () => {
  afterEach(() => {
    mocks.fetchHtml.mockReset();
    mocks.fetchHtmlViaJinaWithRetry.mockReset();
    vi.restoreAllMocks();
  });

  it('rescues a source-specific HTTP 404 through verified clean-egress HTML', async () => {
    const error = Object.assign(new Error('HTTP 404 from https://reha-andeer.ch/de/reha-andeer/offene-stellen-reha-andeer'), { status: 404 });
    mocks.fetchHtml.mockRejectedValueOnce(error);
    mocks.fetchHtmlViaJinaWithRetry.mockResolvedValueOnce(
      '<html><body><h1>Offene Stellen Reha Andeer</h1><a href="/sites/default/files/2026-07/Stelleninserat-Pflegehelferin.pdf">PDF</a></body></html>',
    );

    await expect(fetchRehaAndeerListingHtml({ timeoutMs: 1234 })).resolves.toContain('Offene Stellen');
    expect(mocks.fetchHtmlViaJinaWithRetry).toHaveBeenCalledWith(
      'https://reha-andeer.ch/de/reha-andeer/offene-stellen-reha-andeer',
      { timeoutMs: 1234 },
    );
  });

  it('preserves the original 404 when clean-egress rescue cannot verify the page', async () => {
    const error = Object.assign(new Error('HTTP 404 from https://reha-andeer.ch/de/reha-andeer/offene-stellen-reha-andeer'), { status: 404 });
    mocks.fetchHtml.mockRejectedValueOnce(error);
    mocks.fetchHtmlViaJinaWithRetry.mockResolvedValueOnce(null);

    await expect(fetchRehaAndeerListingHtml()).rejects.toThrow(/HTTP 404/);
  });

  it('reads the Drupal career page that replaced the WordPress /offene-stellen/ page', async () => {
    // Shape of https://reha-andeer.ch/de/reha-andeer/offene-stellen-reha-andeer
    // (2026-10-01): the former /offene-stellen/ answers HTTP 404 and the
    // Stelleninserate moved from /wp-content/uploads/ to Drupal public files.
    const html = [
      '<main><h1>Offene Stellen Reha Andeer</h1>',
      '<a href="#offene-stellen">Offene Stellen &amp; mehr</a>',
      '<p>Pflegehelferin/Pflegehelfer SRK 40-60%, Initiativbewerbung willkommen</p>',
      '<a href="/sites/default/files/2026-07/Stelleninserat-Pflegehelferin.pdf" target="_blank">Zur Stellenausschreibung</a>',
      '<a href="/sites/default/files/2026-07/Datenschutzerklaerung.pdf">Datenschutz</a>',
      '</main>',
    ].join('');
    mocks.fetchHtml.mockResolvedValueOnce(html);

    await expect(fetchRehaAndeerListingHtml()).resolves.toBe(html);
    expect(mocks.fetchHtml).toHaveBeenCalledWith(
      'https://reha-andeer.ch/de/reha-andeer/offene-stellen-reha-andeer',
      { timeoutMs: undefined, includeStatus: true },
    );
    expect(parseRehaAndeerListing(html)).toEqual([
      expect.objectContaining({
        title: 'Pflegehelferin',
        pdfUrl: 'https://reha-andeer.ch/sites/default/files/2026-07/Stelleninserat-Pflegehelferin.pdf',
        filename: 'Stelleninserat-Pflegehelferin.pdf',
      }),
    ]);
  });

  it('does not throw on malformed percent-encoding in a PDF href', () => {
    expect(() => parseRehaAndeerListing(
      "<a href='/wp-content/uploads/%E0%A4.pdf'>PDF</a>",
    )).not.toThrow();
  });
});

describe('Reha Andeer — source-proofed discovery', () => {
  const emptyPage = [
    '<main>',
    '  <h2>Offene Stellen</h2>',
    '  <p>Initiativbewerbungen willkommen.</p>',
    '</main>',
  ].join('');

  it('stamps an empty page only when both structural anchors are present and no job PDF is linked', async () => {
    const jobs = await fetchAllRehaAndeerJobs({
      fetchListingHtmlImpl: async () => emptyPage,
    });

    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect(Reflect.get(jobs, 'authoritativeEmptyEvidence')).toEqual(
      expect.stringContaining('HTTP 200'),
    );
    expect(Reflect.get(jobs, 'authoritativeEmptyEvidence')).toEqual(
      expect.stringContaining('Initiativbewerbungen'),
    );
  });

  it('keeps a structurally changed 200 page as an unproven zero', async () => {
    const result = await fetchAllRehaAndeerJobs({
      fetchListingHtmlImpl: async () => '<main><h2>Karriere</h2><p>Initiativbewerbungen willkommen.</p></main>',
    });

    expect(result).toMatchObject({ jobs: [], fetchOutcome: 'selector_miss' });
    expect(isAuthoritativeEmptySnapshot(result.jobs)).toBe(false);
    expect(result.fetchFailureReason).toMatch(/Offene Stellen/i);
  });

  it('keeps an empty proof unverified when a live PDF is outside the parsed anchor selector', async () => {
    const result = await fetchAllRehaAndeerJobs({
      fetchListingHtmlImpl: async () => [
        '<main>',
        '  <h2>Offene Stellen</h2>',
        '  <p>Initiativbewerbungen willkommen.</p>',
        '  <div class="document-link" data-href="/sites/default/files/2026-10/Stelleninserat-Live.pdf">Stelleninserat</div>',
        '</main>',
      ].join(''),
    });

    expect(result).toMatchObject({ jobs: [], fetchOutcome: 'selector_miss' });
    expect(isAuthoritativeEmptySnapshot(result.jobs)).toBe(false);
    expect(result.fetchFailureReason).toContain('unparsed document or announcement link');
  });

  it('keeps a 403 page as an unproven zero with an anti-bot diagnosis', async () => {
    const error = Object.assign(new Error('HTTP 403 from Reha Andeer'), { status: 403 });
    const result = await fetchAllRehaAndeerJobs({
      fetchListingHtmlImpl: async () => { throw error; },
    });

    expect(result).toMatchObject({ jobs: [], fetchOutcome: 'anti_bot_block' });
    expect(isAuthoritativeEmptySnapshot(result.jobs)).toBe(false);
    expect(result.fetchFailureReason).toContain('403');
  });

  it('returns one job for one neutral Stelleninserat PDF', async () => {
    const page = [
      '<main>',
      '  <h2>Offene Stellen</h2>',
      '  <p>Initiativbewerbungen willkommen.</p>',
      '  <a href="/sites/default/files/2026-10/Stelleninserat-Archiv.pdf">Stelleninserat</a>',
      '</main>',
    ].join('');
    const pdfText = Array(70).fill('Neutrale Beschreibung der erfundenen Stelle und ihrer Aufgaben.').join(' ');

    const jobs = await fetchAllRehaAndeerJobs({
      fetchListingHtmlImpl: async () => page,
      extractPdfContentImpl: async () => ({ rawText: pdfText, text: pdfText, thin: false, error: '' }),
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Archiv', companyKey: 'reha-andeer' });
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });
});
