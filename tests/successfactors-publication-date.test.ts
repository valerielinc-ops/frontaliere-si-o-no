import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractSuccessFactorsJobIdentity, fetchSuccessFactorsJobs, parseSuccessFactorsPostedDate } from '../scripts/lib/ats-clients/successfactors-client.mjs';
import { createSuccessFactorsParser, parseCsbDetailPage, parseCsbSearchResults } from '../scripts/lib/successfactors-shared-job-parser-common.mjs';

const date = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
const timestamp = `${date}T23:15:00-02:00`;
afterEach(() => vi.unstubAllGlobals());

describe('SuccessFactors publication provenance', () => {
  it.each(['', '2025-02-30', '30.02.2025', 'February 30, 2025', 'invalid', new Date(Date.now() + 86400000).toISOString()])('rejects invalid or future source %s', value => {
    expect(parseSuccessFactorsPostedDate(value)).toBeNull();
  });

  it('preserves explicit ISO offset instead of truncating to a different UTC day', () => {
    expect(parseSuccessFactorsPostedDate(timestamp)).toBe(timestamp);
  });

  it('preserves the observed CSB Java timestamp format and rejects calendar rollover', () => {
    const instant = new Date(`${date}T00:00:00Z`);
    const month = instant.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    expect(parseSuccessFactorsPostedDate(`Tue ${month} ${instant.getUTCDate()} 00:00:00 UTC ${instant.getUTCFullYear()}`)).toBe(`${date}T00:00:00Z`);
    expect(parseSuccessFactorsPostedDate('Tue Feb 30 00:00:00 UTC 2025')).toBeNull();
  });

  it('normalizes an explicit English listing date without calendar rollover', () => {
    const human = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    expect(parseSuccessFactorsPostedDate(human)).toBe(date);
  });

  it('does not promote unmarked normalized or generic employment dates', () => {
    const value = extractSuccessFactorsJobIdentity({ title: 'Engineer', postedAt: date, start_date: date });
    expect(value).toMatchObject({ postedAt: null, postedDate: '', datePosted: '', postingDateSource: 'unknown' });
  });

  it('preserves an explicitly sourced date and its marker through identity normalization', () => {
    const value = extractSuccessFactorsJobIdentity({ title: 'Engineer', datePosted: timestamp });
    expect(value).toMatchObject({ postedAt: timestamp, postedDate: timestamp, datePosted: timestamp, postingDateSource: 'reported' });
  });

  it('propagates microdata publication evidence and leaves missing dates unknown', () => {
    expect(parseCsbDetailPage(`<meta itemprop="datePosted" content="${timestamp}">`)).toMatchObject({ postedDate: timestamp, datePosted: timestamp, postingDateSource: 'reported' });
    expect(parseCsbDetailPage('<p>No publication date</p>')).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
  });

  it('does not infer publication from an unrelated date cell', () => {
    const row = `<tr><td><a href="/job/Engineer/123/">Engineer</a></td><td class="deadline">${date}</td></tr>`;
    expect(parseCsbSearchResults(row)[0].postingDateSource).toBe('unknown');
    expect(parseCsbSearchResults(row.replace('deadline', 'colDate'))[0]).toMatchObject({ postedDate: date, postingDateSource: 'reported' });
  });

  it('carries the original JSON-LD date through the actual detail fetch and normalizer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Engineer', identifier: { value: '123' }, datePosted: timestamp, url: 'https://jobs.mobiliar.ch/job/Engineer/123/' })}</script>`)));
    const results = [];
    for await (const item of fetchSuccessFactorsJobs('https://jobs.mobiliar.ch/job/Engineer/123/', { minDelayMs: 0, maxPages: 1 })) results.push(item);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ datePosted: timestamp, postedDate: timestamp, postingDateSource: 'reported' });
  });

  it('preserves explicit OData postingStartDate at the source boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ d: { results: [{ jobReqId: 'odata-123', jobTitle: 'Engineer', postingStartDate: timestamp }] } }))));
    const results = [];
    for await (const item of fetchSuccessFactorsJobs('https://api4.successfactors.com/odata/v2/JobRequisitionLocale', { minDelayMs: 0, maxPages: 1 })) results.push(item);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ postedAt: timestamp, datePosted: timestamp, postedDate: timestamp, postingDateSource: 'reported' });
  });

  it.each([timestamp, ''])('preserves source provenance through the actual CSB factory: %s', async rawDate => {
    const body = 'Join our operations team and help us build reliable products for customers. Your responsibilities include planning, delivery, quality, documentation, stakeholder management, continuous improvement, teamwork, communication, analysis, reporting, compliance and customer support in Männedorf. You bring a completed technical education, several years of experience and good German and English skills, and you enjoy working in a small team.';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).includes('/search/')
      ? '<table><tr><td><a href="/job/Engineer/123/">Engineer</a></td><td class="colLocation hidden-phone">Männedorf, ZH, CH</td></tr></table>'
      : `<html lang="en"><div data-careersite-propertyid="description">${body}</div><span data-careersite-propertyid="city">Männedorf</span><meta itemprop="datePosted" content="${rawDate}"></html>`)));
    const parser = createSuccessFactorsParser({ companyKey: 'publication-test', companyName: 'Example AG', companyDomain: 'example.ch', sfCompanyId: 'example', publicCareerUrl: 'https://careers.example.ch', defaultCanton: 'ZH', defaultCity: 'Männedorf', defaultPostalCode: '8708', defaultSourceLang: 'en' });
    const jobs = await parser.fetchAllJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: rawDate, postedDate: rawDate, postingDateSource: rawDate ? 'reported' : 'unknown' });
    expect(jobs[0].crawledAt).toBeTruthy();
  });
});
