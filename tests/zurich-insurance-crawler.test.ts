import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import {
  fetchZurichInsuranceListings,
  isTrustedZurichInsuranceUrl,
  parseZurichInsuranceJobUrl,
  parseZurichInsuranceListingPage,
  prepareZurichInsuranceCrawler,
  ZURICH_INSURANCE_KEY,
} from '../scripts/lib/zurich-insurance-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const pageOne = fixture('zurich-insurance-listing-page-1.html');
const pageTwo = fixture('zurich-insurance-listing-page-2.html');
const invalidPage = fixture('zurich-insurance-listing-invalid.html');
const detailPage = fixture('zurich-insurance-detail.html');
const pageOne44 = pageOne.replace('of <b>45</b>', 'of <b>44</b>');
const pageTwo44 = pageTwo
  .replace('of <b>45</b>', 'of <b>44</b>')
  .replace(/\s*<tr class="data-row"><td class="colTitle"><a href="\/job\/Swiss-Role-45\/[\s\S]*?<\/tr>/, '');

function rowForReqId(html: string, reqId: string) {
  const row = [...html.matchAll(/\s*<tr class="data-row">[\s\S]*?<\/tr>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes(`/${reqId}/`));
  if (!row) throw new Error(`Missing fixture row ${reqId}`);
  return row;
}

const rowOne = rowForReqId(pageOne, '1371000001');
const rowTwentySix = rowForReqId(pageTwo, '1371000026');
const rowFortyFive = rowForReqId(pageTwo, '1371000045');
const rowFortySix = rowFortyFive
  .replaceAll('Swiss-Role-45', 'Swiss-Role-46')
  .replaceAll('Swiss Role 45', 'Swiss Role 46')
  .replaceAll('1371000045', '1371000046');
const shiftedPageOne = pageOne
  .replace(rowOne, '')
  .replace('</tbody>', `${rowTwentySix}\n</tbody>`);
const shiftedPageTwo = pageTwo
  .replace(rowTwentySix, '')
  .replace('</tbody>', `${rowFortySix}\n</tbody>`);

function pageWithRows(html: string, rows: string[], total: number) {
  let out = html.replace('of <b>45</b>', `of <b>${total}</b>`);
  for (const row of [...out.matchAll(/\s*<tr class="data-row">[\s\S]*?<\/tr>/g)].map((m) => m[0])) {
    out = out.replace(row, '');
  }
  return out.replace('</tbody>', `${rows.join('\n')}\n</tbody>`);
}

function withListingLocation(row: string, location: string) {
  return row.replace(/(class="jobLocation">)[^<]*/, `$1${location}`);
}

const rowTwo = rowForReqId(pageOne, '1371000002');
const unresolvableRowTwo = withListingLocation(rowTwo, 'Neverland-am-See, CH');

function twoRowFetch(page: string) {
  return (url: string) => {
    const parsed = new URL(url);
    return Promise.resolve(parsed.pathname === '/search/' ? page : detailPage);
  };
}

function fixtureFetch(url: string) {
  const parsed = new URL(url);
  if (parsed.pathname === '/search/') {
    return Promise.resolve(parsed.searchParams.get('startrow') === '25' ? pageTwo : pageOne);
  }
  return Promise.resolve(detailPage);
}

describe('Zurich Insurance Switzerland crawler', () => {
  it('accepts only the exact canonical hostname and two-segment numeric requisition path', () => {
    expect(parseZurichInsuranceJobUrl('/job/Z%C3%BCrich-Risk-Analyst/1370195657/?tracking=ignored')).toEqual({
      reqId: '1370195657',
      pathSlug: 'Z%C3%BCrich-Risk-Analyst',
      url: 'https://www.careers.zurich.com/job/Z%C3%BCrich-Risk-Analyst/1370195657/',
    });
    expect(isTrustedZurichInsuranceUrl('https://www.careers.zurich.com/job/Role/1370195657/')).toBe(true);

    const rejected = [
      'https://careers.zurich.com/job/Role/1370195657/',
      'https://evil-zurich.com/job/Role/1370195657/',
      'https://www.careers.zurich.com/en/job/Role/1370195657/',
      'https://www.careers.zurich.com/job//1370195657/',
      'https://www.careers.zurich.com/job/Role/not-numeric/',
      'https://www.careers.zurich.com/job/Role%2FInjected/1370195657/',
      'https://tracker.example/redirect?url=https://www.careers.zurich.com/job/Role/1370195657/',
    ];
    for (const url of rejected) expect(parseZurichInsuranceJobUrl(url)).toBeNull();
  });

  it('parses the 25 + 20 fixture rows as 45 Swiss requisitions', () => {
    const first = parseZurichInsuranceListingPage(pageOne);
    const second = parseZurichInsuranceListingPage(pageTwo);

    expect(first.total).toBe(45);
    expect(first.rawRowCount).toBe(25);
    expect(first.rows).toHaveLength(25);
    expect(first.rejected).toEqual([]);
    expect(second.total).toBe(45);
    expect(second.rawRowCount).toBe(20);
    expect(second.rows).toHaveLength(20);
    expect(second.rejected).toEqual([]);

    const all = [...first.rows, ...second.rows];
    expect(new Set(all.map((row) => row.reqId))).toHaveLength(45);
    expect(all.every((row) => row.location.endsWith(', CH'))).toBe(true);
    expect(all.every((row) => row.url.startsWith('https://www.careers.zurich.com/job/'))).toBe(true);
  });

  it('keeps the visible office of a multi-location row instead of failing closed on it', () => {
    // Live regression (run 33694169583, group 17): a posting open in more than
    // one office renders the extras as a nested `<small>` inside the same
    // jobLocation span, so the cell text read "Zürich, CH +1 more&hellip;" —
    // no Swiss city resolves from that, and the crawler aborted the whole run.
    const multiLocationPage = pageOne.replace(
      '<span class="jobLocation">Zürich, CH</span>',
      '<span class="jobLocation">Zürich, CH <small class="nobr">+1 more&hellip;</small></span>',
    );
    const parsed = parseZurichInsuranceListingPage(multiLocationPage);

    expect(parsed.rejected).toEqual([]);
    expect(parsed.rows).toHaveLength(25);
    expect(parsed.rows[0].location).toBe('Zürich, CH');
    expect(parsed.rows.every((row) => row.location.endsWith(', CH'))).toBe(true);
  });

  it('paginates to the authoritative total and returns exactly 45 unique Swiss jobs', async () => {
    const calls: string[] = [];
    const listings = await fetchZurichInsuranceListings({
      fetchPage: async (url: string) => {
        calls.push(url);
        return fixtureFetch(url);
      },
    });

    expect(listings).toHaveLength(45);
    expect(new Set(listings.map((row) => row.reqId))).toHaveLength(45);
    expect(calls).toHaveLength(3);
    expect(new URL(calls[0]).searchParams.get('locationsearch')).toBe('Switzerland');
    expect(new URL(calls[1]).searchParams.get('startrow')).toBe('25');
    expect(new URL(calls[2]).searchParams.get('startrow')).toBeNull();
    expect(new URL(calls[2]).searchParams.get('_snapshot')).toContain('-verify');
  });

  it('emits zero foreign, wrapper, or malformed candidates and reports every rejection', () => {
    const parsed = parseZurichInsuranceListingPage(invalidPage);

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.rejected.map((row) => row.reason)).toEqual([
      'non_swiss_listing_location',
      'untrusted_or_malformed_job_url',
      'untrusted_or_malformed_job_url',
    ]);
  });

  it('fails closed when an authoritative page contains a rejected row', async () => {
    await expect(fetchZurichInsuranceListings({
      fetchPage: async () => invalidPage,
      snapshotRetryDelayMs: 0,
    })).rejects.toThrow('contained 3 rejected row(s)');
  });

  it('discards a 45-to-44 attempt and returns only the next coherent 44-job snapshot', async () => {
    let firstPageCalls = 0;
    const calls: string[] = [];
    const listings = await fetchZurichInsuranceListings({
      snapshotRetryDelayMs: 0,
      fetchPage: async (url: string) => {
        calls.push(url);
        const startRow = new URL(url).searchParams.get('startrow');
        if (!startRow) {
          firstPageCalls += 1;
          return firstPageCalls === 1 ? pageOne : pageOne44;
        }
        return pageTwo44;
      },
    });

    expect(calls).toHaveLength(5);
    expect(listings).toHaveLength(44);
    expect(new Set(listings.map((row) => row.reqId))).toHaveLength(44);
    expect(listings.some((row) => row.reqId === '1371000045')).toBe(false);
  });

  it('rejects a same-total boundary shift and retries without mixing generations', async () => {
    let generation = 0;
    const calls: string[] = [];
    const listings = await fetchZurichInsuranceListings({
      snapshotRetryDelayMs: 0,
      fetchPage: async (url: string) => {
        calls.push(url);
        const isSecondPage = new URL(url).searchParams.has('startrow');
        if (isSecondPage && generation === 0) generation = 1;
        if (isSecondPage) return shiftedPageTwo;
        return generation === 0 ? pageOne : shiftedPageOne;
      },
    });

    expect(calls).toHaveLength(6);
    expect(listings).toHaveLength(45);
    expect(new Set(listings.map((row) => row.reqId))).toHaveLength(45);
    expect(listings[0].reqId).toBe('1371000002');
    expect(listings.some((row) => row.reqId === '1371000001')).toBe(false);
    expect(listings.some((row) => row.reqId === '1371000046')).toBe(true);
  });

  it('fails loud after every full-snapshot attempt remains incoherent', async () => {
    const calls: string[] = [];
    await expect(fetchZurichInsuranceListings({
      snapshotAttempts: 3,
      snapshotRetryDelayMs: 0,
      fetchPage: async (url: string) => {
        calls.push(url);
        return new URL(url).searchParams.has('startrow') ? pageTwo44 : pageOne;
      },
    })).rejects.toThrow('remained incoherent after 3 snapshot attempt(s)');
    expect(calls).toHaveLength(6);
  });

  it('builds 45 source-locale jobs from official details with numeric identity and precise locations', async () => {
    const crawler = await prepareZurichInsuranceCrawler({
      fetchPage: fixtureFetch,
      detailDelayMs: 0,
      now: () => new Date('2026-08-31T12:00:00.000Z'),
    });
    const jobs = await crawler.fetchJobs();

    expect(jobs).toHaveLength(45);
    expect(jobs.discoveredCount).toBe(45);
    expect(new Set(jobs.map((job) => job.id))).toHaveLength(45);
    expect(jobs.every((job) => job.id === `${ZURICH_INSURANCE_KEY}-${job.slugDisambiguator}`)).toBe(true);
    expect(jobs.every((job) => /^https:\/\/www\.careers\.zurich\.com\/job\/[^/]+\/\d+\/$/.test(job.url))).toBe(true);
    expect(jobs.every((job) => job.country === 'CH' && job.addressCountry === 'CH')).toBe(true);
    expect(new Set(jobs.map((job) => job.canton))).toEqual(new Set(['ZH', 'VD', 'LU', 'GE']));
    expect(jobs.every((job) => !job.location.includes(', CH'))).toBe(true);
    expect(jobs.every((job) => Object.keys(job.slugByLocale).length === 1)).toBe(true);
  });

  it('migration matcher keeps only active legacy requisitions and all dedicated records', async () => {
    const crawler = await prepareZurichInsuranceCrawler({ fetchPage: fixtureFetch, detailDelayMs: 0 });
    const jobs = await crawler.fetchJobs();

    expect(crawler.isCompanyJob({
      companyKey: ZURICH_INSURANCE_KEY,
      source: 'Company Careers Crawler',
      url: 'https://careers.zurich.com/job/Swiss-Role-01/1371000001/',
    })).toBe(true);
    expect(crawler.isCompanyJob({
      companyKey: ZURICH_INSURANCE_KEY,
      source: 'Company Careers Crawler',
      url: 'https://www.careers.zurich.com/job/Ljubljana-Operations/1368131357/',
    })).toBe(false);
    expect(crawler.isCompanyJob({
      companyKey: ZURICH_INSURANCE_KEY,
      source: 'Company Careers Crawler',
      url: 'https://tracker.example/?url=https://www.careers.zurich.com/job/Swiss-Role-01/1371000001/',
    })).toBe(false);
    expect(crawler.isCompanyJob(jobs[0])).toBe(true);
  });

  it('preserves the existing id, slugs, translations, and previous-slug journal by requisition ID', async () => {
    const initialCrawler = await prepareZurichInsuranceCrawler({ fetchPage: fixtureFetch, detailDelayMs: 0 });
    const initialFresh = (await initialCrawler.fetchJobs())[0];
    const stableSlug = 'ruolo-svizzero-01-zurich-insurance-sede-ticino-lugano-oldstable';
    const existing = {
      ...initialFresh,
      id: 'company-existing-stable-id',
      slug: stableSlug,
      slugByLocale: {
        en: 'swiss-role-01-zurich-insurance-sede-ticino-lugano-oldstable',
        it: 'ruolo-svizzero-01-zurich-insurance-sede-ticino-zurigo',
        de: 'schweizer-stelle-01-zurich-insurance-zuerich',
        fr: 'poste-suisse-01-zurich-insurance-zurich',
      },
      previousSlugs: ['indexed-legacy-zurich-slug'],
      previousSlugsByLocale: { it: ['vecchio-slug-zurich'] },
      source: 'Company Careers Crawler',
      url: 'https://careers.zurich.com/job/Swiss-Role-01/1371000001/',
    };
    const crawler = await prepareZurichInsuranceCrawler({
      fetchPage: fixtureFetch,
      detailDelayMs: 0,
      existingJobs: [existing],
    });
    const fresh = (await crawler.fetchJobs())[0];

    const [merged] = mergePreserveLocaleData([existing], [fresh]);

    expect(merged.id).toBe(existing.id);
    expect(merged.slug).toBe(stableSlug);
    expect(merged.slugByLocale.en).toBe(existing.slugByLocale.en);
    expect(merged.slugByLocale.it).toBe(existing.slugByLocale.it);
    expect(merged.slugByLocale.de).toBe(existing.slugByLocale.de);
    expect(merged.slugByLocale.fr).toBe(existing.slugByLocale.fr);
    expect(merged.previousSlugs).toContain('indexed-legacy-zurich-slug');
    expect(merged.previousSlugsByLocale.it).toContain('vecchio-slug-zurich');
    expect(merged.url).toBe('https://www.careers.zurich.com/job/Swiss-Role-01/1371000001/');
  });
  it('counts an unresolvable Swiss location as a reject and keeps publishing the other rows', async () => {
    const page = pageWithRows(pageOne, [rowOne, unresolvableRowTwo], 2);
    const crawler = await prepareZurichInsuranceCrawler({
      fetchPage: twoRowFetch(page),
      detailDelayMs: 0,
    });
    const jobs = await crawler.fetchJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs.discoveredCount).toBe(2);
    expect(jobs.unresolvedLocationCount).toBe(1);
    expect(jobs[0].id).toBe(`${ZURICH_INSURANCE_KEY}-1371000001`);
  });

  it('fails loud on the aggregate when no discovered row resolves to a Swiss city', async () => {
    const page = pageWithRows(
      pageOne,
      [withListingLocation(rowOne, 'Neverland-am-See, CH'), unresolvableRowTwo],
      2,
    );
    const crawler = await prepareZurichInsuranceCrawler({
      fetchPage: twoRowFetch(page),
      detailDelayMs: 0,
    });

    await expect(crawler.fetchJobs()).rejects.toThrow(
      /unresolved Swiss locations: 2\/2 row\(s\).*Neverland-am-See, CH/,
    );
  });
});
