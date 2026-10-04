import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCoopersJobs } from '../scripts/lib/coopers-job-parser.mjs';

const url = 'https://www.coopers.ch/en/jobs/detail.php?refCode=63IRD1';
const date = '2025-09-29T23:45:12+02:00';
const text = 'Engineering teams develop reliable systems through careful planning testing documentation and collaboration with colleagues. The successful applicant works with clients and maintains quality throughout every project. '.repeat(5);
const listing = '<h4><a href="/en/jobs/detail.php?refCode=63IRD1">Quality Engineer</a></h4>Location: Basel\nContracting\nFull Time\n29.09.2026';
const posting = (raw: unknown) => ({ '@type': 'JobPosting', title: 'Quality Engineer', url, datePosted: raw, validThrough: '2999-12-31', jobStartDate: '2020-01-01' });
function stub(value: unknown) {
  const detail = `<div class="sx-wysiwyg-style"><p>${text}</p></div>${value ? `<script type="application/ld+json">${JSON.stringify(value)}</script>` : ''}`;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input) === 'https://www.coopers.ch/en/jobs/index.php') return new Response(listing);
    if (String(input) === url) return new Response(detail);
    throw new Error(`Unexpected request ${input}`);
  }));
}
afterEach(() => vi.unstubAllGlobals());
async function expectDate(expected = '') {
  const jobs = await fetchAllCoopersJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ url, location: 'Basel', companyKey: 'coopers', datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
}
describe('Coopers source date through listing, fetched detail and final builder', () => {
  for (const [label, raw] of [['timestamp', date], ['missing', undefined], ['invalid', '2025-02-30T12:00:00Z'], ['future', '2999-01-01T12:00:00Z']]) {
    it(`${label}: ignores unlabelled listing date, expiry and employment start`, async () => {
      stub(posting(raw));
      await expectDate(label === 'timestamp' ? date : '');
    });
  }
  it('does not borrow a date from another refCode on the same endpoint', async () => {
    stub({ ...posting(date), url: 'https://www.coopers.ch/en/jobs/detail.php?refCode=OTHER' });
    await expectDate();
  });
  it('does not attest a posting without explicit identity', async () => {
    stub({ ...posting(date), url: undefined });
    await expectDate();
  });
  it('rejects conflicting sameAs identity', async () => {
    stub({ ...posting(date), sameAs: 'https://www.coopers.ch/en/jobs/detail.php?refCode=OTHER' });
    await expectDate();
  });
  it('keeps the real description but leaves date unknown when JSON-LD is absent', async () => {
    stub(null);
    await expectDate();
  });
});
