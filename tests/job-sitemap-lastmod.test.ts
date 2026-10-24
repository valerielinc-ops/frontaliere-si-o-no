import { describe, expect, it } from 'vitest';
import {
  jobSitemapLastmodDay,
  jobSitemapLastmodSource,
  renderJobSitemapLastmod,
} from '../build-plugins/shared/jobSitemapLastmod';

const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const day = (iso: string) => iso.slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

describe('job sitemap <lastmod>', () => {
  it('uses the most recent of reported publication date and first observation', () => {
    const firstSeenAt = daysAgoIso(24);
    const reposted = daysAgoIso(3);
    expect(jobSitemapLastmodDay({ postingDateSource: 'reported', datePosted: reposted, postedDate: reposted, firstSeenAt }))
      .toBe(day(reposted));
    const olderPosting = daysAgoIso(30);
    expect(jobSitemapLastmodDay({ postingDateSource: 'reported', datePosted: olderPosting, firstSeenAt }))
      .toBe(day(firstSeenAt));
  });

  it('falls back to firstSeenAt when the publication date has no provenance', () => {
    const firstSeenAt = daysAgoIso(9);
    // An unprovenanced datePosted may be a crawler-manufactured stand-in.
    expect(jobSitemapLastmodDay({ postingDateSource: 'unknown', datePosted: daysAgoIso(1), firstSeenAt }))
      .toBe(day(firstSeenAt));
  });

  it('never derives the value from the crawl heartbeat, the assembler stamp or the build clock', () => {
    const job = { postingDateSource: 'unknown', crawledAt: daysAgoIso(0), scrapedAt: daysAgoIso(0), updatedAt: daysAgoIso(0) };
    expect(jobSitemapLastmodSource(job as never)).toBeNull();
    expect(renderJobSitemapLastmod(job as never)).toBe('');
    expect(renderJobSitemapLastmod(null)).toBe('');
  });

  it('rejects future and malformed dates instead of clamping them to today', () => {
    expect(jobSitemapLastmodDay({ postingDateSource: 'reported', datePosted: daysAgoIso(-3) })).toBeUndefined();
    expect(jobSitemapLastmodDay({ postingDateSource: 'reported', datePosted: '30/05/26', firstSeenAt: 'not-a-date' })).toBeUndefined();
    const firstSeenAt = daysAgoIso(5);
    const out = jobSitemapLastmodDay({ postingDateSource: 'reported', datePosted: daysAgoIso(-3), firstSeenAt });
    expect(out).toBe(day(firstSeenAt));
    expect(out).not.toBe(today());
  });

  it('renders a W3C date element', () => {
    const firstSeenAt = daysAgoIso(4);
    expect(renderJobSitemapLastmod({ firstSeenAt })).toBe(`<lastmod>${day(firstSeenAt)}</lastmod>`);
  });
});
