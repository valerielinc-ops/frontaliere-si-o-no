import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ date: '', company: 'ikea' }));
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>();
  return { ...original, fetchHtml: vi.fn(async (url: string) => {
    const description = Array.from({ length: 80 }, () => 'source').join(' ');
    if (state.company === 'implenia') return `<span itemprop="description">${description}</span><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: state.date })}</script>`;
    if (url.includes('/location/')) return '<section><a href="/en/job/lugano/engineer/22908/123" data-job-id="123" class="job-list__anchor"><span class="job-list__title">Engineer</span><span class="job-list__location">Lugano, Switzerland</span></section>';
    return `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description, datePosted: state.date, jobLocation: { address: { addressCountry: 'CH', addressLocality: 'Lugano', addressRegion: 'TI', postalCode: '6900' } } })}</script>`;
  }) };
});
import { fetchAllIkeaJobs } from '../scripts/lib/ikea-job-parser.mjs';
import { fetchAllImpleniaJobs } from '../scripts/lib/implenia-job-parser.mjs';

const date = new Date(Date.now() - 10 * 86400000).toISOString();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const company of ['ikea', 'implenia']) {
  describe(`${company} source publication`, () => {
    it.each(['', 'not-a-date', '2025-02-30', `junk ${date}`, date])('validates the complete detail date %s', async (raw) => {
      state.company = company;
      state.date = raw;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
        callback(); return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).endsWith('/search-results')) return new Response('CSRFToken="12345678-1234-1234-1234-123456789abc"');
        return new Response(JSON.stringify({ totalJobs: 1, jobSearchResult: [{ response: {
          id: '123', unifiedStandardTitle: 'Engineer', unifiedUrlTitle: 'Engineer',
          jobLocationShort: ['Lugano, CHE, 6900'], unifiedStandardStart: '01.01.24',
        } }] }), { status: 200 });
      }));
      const jobs = company === 'ikea' ? await fetchAllIkeaJobs() : await fetchAllImpleniaJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(raw === date
        ? { datePosted: date, postedDate: date, postingDateSource: 'reported' }
        : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    });
  });
}
