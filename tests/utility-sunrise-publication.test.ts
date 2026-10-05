import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSunriseJobDetail } from '../scripts/lib/sunrise-job-parser.mjs';
const url = 'https://careers.sunrise.ch/job/REQ1/engineer';
const title = 'Engineer';
const validDate = '2026-10-02T10:00:00.123456+02:00';
const posting = { '@type': 'JobPosting', title, url, datePosted: validDate };

describe('Sunrise same-detail publication', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  it.each([
    { label: 'genuine detail wins invalid Phenom field', postings: [posting], expected: true },
    { label: 'missing', postings: [], expected: false },
    { label: 'foreign URL', postings: [{ ...posting, url: url + '-other' }], expected: false },
    { label: 'foreign sameAs', postings: [{ ...posting, sameAs: url + '-other' }], expected: false },
    { label: 'different title', postings: [{ ...posting, title: 'Other' }], expected: false },
    { label: 'ambiguous URL-less', postings: [{ ...posting, url: '' }, { ...posting, url: '' }], expected: false },
    { label: 'invalid calendar', postings: [{ ...posting, datePosted: '2026-02-30' }], expected: false },
    { label: 'future', postings: [{ ...posting, datePosted: '2026-10-05' }], expected: false },
    { label: 'emitted title mismatch', postings: [posting], emittedTitle: 'Other', expected: false },
  ])('$label', ({ postings, expected, emittedTitle }) => {
    const html = `<script>phApp.ddo = ${JSON.stringify({ jobDetail: { data: { job: { reqId: 'REQ1', title: emittedTitle || title, postedDate: 'invalid', description: '<p>Real source description</p>' } } } })}; phApp.experimentData = {};</script>` + postings.map(p => `<script type="application/ld+json">${JSON.stringify(p)}</script>`).join('');
    const job = parseSunriseJobDetail(html, url, title);
    expect(job.description).toContain('Real source description');
    expect(job).toMatchObject(expected ? { datePosted: validDate, postedDate: validDate.slice(0, 10), postingDateSource: 'reported' } : { datePosted: '', postedDate: '', postingDateSource: 'unknown' });
  });
});
