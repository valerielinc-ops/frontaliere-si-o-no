import { beforeEach, describe, expect, it, vi } from 'vitest';
import { politeFetch } from '../scripts/lib/prospector/polite-fetch.mjs';
import { careerPagesOnIndexPage } from '../scripts/lib/prospector/sources/commoncrawl-careers.mjs';

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', () => ({
  politeFetch: vi.fn(),
}));

const mockPoliteFetch = vi.mocked(politeFetch);

describe('Common Crawl careers URL discovery', () => {
  beforeEach(() => vi.resetAllMocks());

  it('keeps the Locarno work-with-us page with its .html suffix', async () => {
    const locarnoUrl = 'https://www.locarnofestival.ch/it/about/organization/work-with-us.html';
    mockPoliteFetch.mockResolvedValue({
      ok: true,
      body: [
        { url: locarnoUrl },
        { url: 'https://example.ch/company/work-with-usful.html' },
      ].map((row) => JSON.stringify(row)).join('\n'),
    } as any);

    const result = await careerPagesOnIndexPage('CC-MAIN-2026-43', 0);

    expect(result.employers).toEqual([{ host: 'locarnofestival.ch', url: locarnoUrl }]);
  });
});
