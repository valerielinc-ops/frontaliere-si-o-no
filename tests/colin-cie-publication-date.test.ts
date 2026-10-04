import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';
import { extractJobPostingField } from '../scripts/lib/jobposting-jsonld.mjs';
import { decodeColinCieEntities, parseColinCieJobDescription } from '../scripts/lib/colin-cie-job-parser.mjs';

function runnerFunction(name: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL('../scripts/update-colin-cie-jobs.mjs', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('runner.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = tree.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Missing ${name}`);
  return new Function(...Object.keys(dependencies), `return (${node.getText(tree)});`)(...Object.values(dependencies));
}
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const constants = { COMPANY_KEY: 'colin-cie', COMPANY_NAME: 'Colin&Cie', COMPANY_DOMAIN: 'colin-cie.com', COMPANY_HOST: 'www.colin-cie.com', CAREERS_URL: 'https://www.colin-cie.com/de/karriere' };
const row = { title: 'Advisor', city: 'Lugano', category: 'Consulting', detailUrl: 'https://www.colin-cie.com/de/karriere/advisor' };
const build = runnerFunction('buildJob', {
  ...constants, normalize: (s: string) => s.toLowerCase(), CITY_MAP: {}, deriveSlug: () => 'advisor-lugano',
  inferCategory: () => 'consulting', mergeSourcePostingDates,
});

describe('Colin&Cie publication evidence through its real runner functions', () => {
  it('does not interpret an unlabelled listing newsDate as publication', () => {
    const listing = runnerFunction('parseListingPage', { BASE_URL: 'https://www.colin-cie.com/', decodeColinCieEntities, sourcePostingDateFields });
    const date = daysAgo(5).slice(0, 10).split('-').reverse().join('.');
    const [parsed] = listing(`<div id='jobspost123' class='grid-item'><span class='newsDate'>${date}</span><h3>Advisor</h3><a href='de/karriere/advisor'>Detail</a><span class='jobTag'>Consulting</span><span class='jobTag'>Schweiz</span><span class='jobTag'>Lugano</span></div>`);
    expect(parsed).toMatchObject({ ...unknown, sourceListingDate: date });
    expect(build(parsed, 'Source description')).toMatchObject(unknown);
    expect(build({ ...row, postedDate: daysAgo(3) }, 'Source description')).toMatchObject(unknown);
  });

  it('accepts only explicit valid detail datePosted while preserving timestamp precision', async () => {
    const published = daysAgo(4);
    for (const raw of [published, '', 'not-a-date', `${new Date().getUTCFullYear()}-02-30`, daysAgo(-1)]) {
      const fetchDetail = runnerFunction('fetchJobDetail', { fetchPage: async () => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: raw, dateCreated: published })}</script>`, parseColinCieJobDescription, extractJobPostingField, sourcePostingDateFields });
      const detail = await fetchDetail(row.detailUrl);
      const expected = raw === published ? { datePosted: published, postedDate: published, postingDateSource: 'reported' } : unknown;
      expect(build({ ...row, ...detail }, detail.description)).toMatchObject(expected);
    }
  });

  it('preserves the date pair and marker in adapter seeds', () => {
    let output: any;
    const adapter = runnerFunction('updateAdapterConfig', { ...constants, mergeSourcePostingDates, ADAPTER_PATH: 'scratch', writeJson: (_path: string, value: unknown) => { output = value; } });
    for (const fields of [unknown, sourcePostingDateFields(daysAgo(3))]) {
      const job = build({ ...row, ...fields }, 'Source description');
      adapter([job]);
      expect(output.seedMetaByUrl[job.url]).toMatchObject(fields);
    }
  });

  it('clears unmarked legacy dates and retains an earlier reported publication atomically', () => {
    let existing: any[] = [];
    let written: any[] = [];
    const merge = runnerFunction('mergeJobs', {
      ...constants, readExistingCrawlerJobs: () => existing, DATA_JOBS: 'scratch', PUBLIC_JOBS: 'scratch-public',
      isTargetJob: () => true, snapshotJobSlugs: () => ({}), jobMatchKey: (job: any) => job.url,
      mergeSourcePostingDates, mergeLocaleTextMap: (_old: unknown, fresh: unknown) => fresh,
      dropStaleLocaleDescriptions: () => {}, captureLostSlugs: () => {}, writeJson: (_path: string, jobs: any[]) => { written = jobs; },
      computeCrawlDiff: () => ({}), printCrawlChangeSummary: () => {}, writeCrawlChangeSummaryToGH: () => {}, writeJobsSummary: () => {}, printPublishedJobUrls: () => {},
    });
    const fresh = build({ ...row, ...unknown }, 'Source description');
    existing = [{ ...fresh, datePosted: daysAgo(5), postedDate: daysAgo(5), postingDateSource: undefined }];
    merge([fresh]);
    expect(written[0]).toMatchObject(unknown);
    const prior = sourcePostingDateFields(daysAgo(10));
    existing = [{ ...fresh, ...prior }];
    merge([build({ ...row, ...sourcePostingDateFields(daysAgo(2)) }, 'Source description')]);
    expect(written[0]).toMatchObject(prior);
  });
});
