import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichWithDetails } from '../scripts/update-mtic-jobs.mjs';
import {
  isMticDetailPublishable,
  isMticTrustedUrl,
  parseMticDetailPage,
  parseMticListingPage,
} from '../scripts/lib/mtic-job-parser.mjs';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MTIC listing URL boundary', () => {
  it('keeps MTIC-owned detail links and drops external ATS redirects', () => {
    const html = `
      <section class="fce-2-col">
        <h3>SPS InterCert S.A. | Lugano Paradiso - Switzerland</h3>
        <ul>
          <li><a href="/it/opportunita-di-lavoro/open-position-quality-assurance-manager/">Official</a></li>
          <li><a href="https://spsintercertsa.mtic-group.org/it/opportunita-di-lavoro/open-position-a/">Subdomain</a></li>
          <li><a href="http://central.st12.consulting1x1.info/it/opportunita-di-lavoro/open-position-quality-assurance-manager/">External redirect</a></li>
        </ul>
      </section>`;

    expect(parseMticListingPage(html).map((item) => item.detailUrl)).toEqual([
      'https://www.mtic-group.org/it/opportunita-di-lavoro/open-position-quality-assurance-manager/',
      'https://spsintercertsa.mtic-group.org/it/opportunita-di-lavoro/open-position-a/',
    ]);
  });

  it('rejects invalid protocols and lookalike hosts', () => {
    expect(isMticTrustedUrl('https://www.mtic-group.org/it/opportunita-di-lavoro/open-position-a/')).toBe(true);
    expect(isMticTrustedUrl('https://spsintercertsa.mtic-group.org/it/opportunita-di-lavoro/open-position-a/')).toBe(true);
    expect(isMticTrustedUrl('http://central.st12.consulting1x1.info/it/opportunita-di-lavoro/open-position-a/')).toBe(false);
    expect(isMticTrustedUrl('https://not-mtic-group.org/it/opportunita-di-lavoro/open-position-a/')).toBe(false);
    expect(isMticTrustedUrl('javascript://www.mtic-group.org/it/opportunita-di-lavoro/open-position-a/')).toBe(false);
  });
});

describe('MTIC detail body boundary', () => {
  it('rejects an empty detail response instead of treating it as a parsed job', () => {
    const detail = parseMticDetailPage(
      '<main class="content_main"><h2>Stale posting</h2></main>',
      'Stale posting',
    );

    expect(detail.description).toBe('');
    expect(isMticDetailPublishable(detail)).toBe(false);
  });

  it('accepts a detail response with a source body at the shared floor', () => {
    const body = Array.from({ length: 50 }, (_, index) => `source-word-${index}`).join(' ');
    const detail = parseMticDetailPage(
      `<main class="content_main"><h2>Quality manager</h2><div class="frame-type-text">${body}</div></main>`,
      'Quality manager',
    );

    expect(isMticDetailPublishable(detail)).toBe(true);
  });
});

describe('MTIC detail fetch pacing', () => {
  it('waits between every detail fetch when skipped pages are below the floor', async () => {
    vi.useFakeTimers();
    const detailFetchStarts: number[] = [];
    const validBody = Array.from({ length: 50 }, (_, index) => `source-word-${index}`).join(' ');
    const listings = ['under-floor-a', 'under-floor-b', 'valid'].map((slug) => ({
      detailUrl: `https://www.mtic-group.org/it/opportunita-di-lavoro/${slug}/`,
      title: slug,
      subsidiaryCountry: 'CH',
      subsidiaryLocation: 'Lugano Paradiso',
    }));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      detailFetchStarts.push(Date.now());
      const url = String(input);
      const body = url.includes('/valid/')
        ? `<main class="content_main"><h2>Valid opening</h2><div class="frame-type-text">${validBody}</div></main>`
        : '<main class="content_main"><h2>Stale opening</h2></main>';
      return { ok: true, status: 200, text: async () => body } as Response;
    });

    const resultPromise = enrichWithDetails(listings);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toHaveLength(1);
    expect(detailFetchStarts).toHaveLength(3);
    expect(detailFetchStarts[1] - detailFetchStarts[0]).toBeGreaterThanOrEqual(800);
    expect(detailFetchStarts[2] - detailFetchStarts[1]).toBeGreaterThanOrEqual(800);
  });
});
