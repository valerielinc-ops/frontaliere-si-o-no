import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';
import { buildAxaJob } from '../scripts/update-axa-jobs.mjs';
import { parseConvitDetailPage } from '../scripts/lib/convit-job-parser.mjs';

// Execute the real private runner functions without starting network crawls or writes.
function runnerFunction(file: string, name: string, dependencies: Record<string, unknown> = {}) {
  const source = readFileSync(path.resolve('scripts', file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing ${name} in ${file}`);
  return vm.runInNewContext(`(${declaration.getText(ast).replace(/^export\s+/, '')})`, {
    sourcePostingDateFields, mergeSourcePostingDates, console, ...dependencies,
  });
}
const unknown = { postedDate: '', datePosted: '', postingDateSource: 'unknown' };
afterEach(() => vi.useRealTimers());

describe('source publication date conversion across crawler families', () => {
  it.each(['alten', 'ariston', 'board', 'bosch', 'corner', 'damiani', 'debiopharm'])(
    '%s rejects absent, impossible and future source dates', (company) => {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
      const convert = runnerFunction(`update-${company}-jobs.mjs`, 'toIsoDate');
      for (const value of ['', 'not-a-date', '2026-02-30', '2027-01-01']) expect(convert(value)).toBe('');
      expect(convert('2026-02-18')).toBe('2026-02-18');
    },
  );
  it('keeps the documented DD/MM and MM/DD source formats distinct', () => {
    const alten = runnerFunction('update-alten-jobs.mjs', 'toIsoDate');
    const bosch = runnerFunction('update-bosch-jobs.mjs', 'toIsoDate');
    expect(sourcePostingDateFields(alten('18/02/2026')).postedDate).toBe('2026-02-18');
    expect(sourcePostingDateFields(bosch('02/18/2026')).postedDate).toBe('2026-02-18');
    expect(sourcePostingDateFields(alten('30/02/2026'))).toEqual(unknown);
  });
  it('Axpo normalizes the RSS source timestamp without losing its timezone', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const convert = runnerFunction('update-axpo-jobs.mjs', 'rssPostingDateFields');
    expect(convert('Wed, 18 Feb 2026 00:30:00 +0100')).toEqual(sourcePostingDateFields('2026-02-18T00:30:00+01:00'));
    expect(convert('Mon, 30 Feb 2026 00:30:00 GMT')).toEqual(unknown);
    expect(convert('Sat, 03 Oct 2026 23:30:00 GMT')).toEqual(unknown);
    expect(convert('')).toEqual(unknown);
    vi.setSystemTime(new Date('2026-10-03T23:30:00Z'));
    expect(convert('Sun, 04 Oct 2026 00:15:00 +0100')).toEqual(sourcePostingDateFields('2026-10-04T00:15:00+01:00'));
  });
  it('AXA carries the source listing publication instead of the crawl clock', () => {
    const row = { title: 'Consulente assicurativo', detailUrl: 'https://careers.axa.com/jobs/123',
      url: 'https://careers.axa.com/jobs/123', description: 'Consulenza assicurativa a Lugano.',
      listingCity: 'Lugano', location: 'Lugano', canton: 'TI', postedDate: '2026-02-18' };
    expect(buildAxaJob(row)).toMatchObject(sourcePostingDateFields('2026-02-18'));
    expect(buildAxaJob({ ...row, postedDate: '' })).toMatchObject(unknown);
  });
  it('Convit preserves absence and passes the complete source timestamp to validation', () => {
    expect(parseConvitDetailPage('<h1>Consultant</h1>', '').datePosted).toBe('');
    const raw = '2026-02-18T10:00:00+01:00';
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Consultant', datePosted: raw })}</script>`;
    expect(parseConvitDetailPage(html, '').datePosted).toBe(raw);
  });
  it('Ariston does not interpret a real expiry as a publication date', async () => {
    const detail = { title: 'Engineer', location: 'Lugano', description: 'Source description', postedDate: '', validThrough: '2027-01-01' };
    const build = runnerFunction('update-ariston-jobs.mjs', 'buildAristonJob', {
      absoluteUrl: (value: string) => value, fetchHtml: async () => '', parseAristonJobDetail: () => detail,
      inferAristonRegion: () => ({ canton: 'TI', country: 'CH' }), inferAristonCategory: () => 'engineering',
      buildAristonLocalizedContent: () => ({ sourceLang: 'it', titleByLocale: { it: 'Engineer' }, slugByLocale: { it: 'engineer' }, descriptionByLocale: { it: 'Source description' } }),
      toIsoDate: runnerFunction('update-ariston-jobs.mjs', 'toIsoDate'), COMPANY_NAME: 'Ariston', COMPANY_KEY: 'ariston', COMPANY_DOMAIN: 'ariston.com',
    });
    const job = await build({ url: 'https://careers.aristongroup.com/job/123', validThrough: '2027-01-01' });
    expect(job).toMatchObject({ ...unknown, validThrough: '2027-01-01' });
  });
});

describe('custom crawler recrawl merges keep publication evidence atomic', () => {
  it('AXA adapter projection carries both date aliases and the evidence marker', () => {
    let adapter: { seedMetaByUrl: Record<string, Record<string, unknown>> } | undefined;
    const write = runnerFunction('update-axa-jobs.mjs', 'updateAdapterConfig', {
      writeJson: (_file: string, value: typeof adapter) => { adapter = value; },
      ADAPTER_PATH: 'adapter', COMPANY_KEY: 'axa', COMPANY_NAME: 'AXA', COMPANY_HOST: 'careers.axa.com', CAREERS_URL: 'https://careers.axa.com',
    });
    write([{ url: 'https://careers.axa.com/jobs/known', ...sourcePostingDateFields('2026-02-18') },
      { url: 'https://careers.axa.com/jobs/unknown', ...unknown }]);
    expect(adapter?.seedMetaByUrl['https://careers.axa.com/jobs/known']).toMatchObject(sourcePostingDateFields('2026-02-18'));
    expect(adapter?.seedMetaByUrl['https://careers.axa.com/jobs/unknown']).toMatchObject(unknown);
  });
  it.each(['amag', 'axa'])('%s retains verified history and clears unmarked legacy dates', (company) => {
    let existing: Record<string, unknown>[] = [];
    let written: Record<string, unknown>[] = [];
    const merge = runnerFunction(`update-${company}-jobs.mjs`, 'mergeJobs', {
      readExistingCrawlerJobs: () => existing, isTargetJob: () => true, jobMatchKey: (job: { id: string }) => job.id,
      snapshotJobSlugs: () => [], computeCrawlDiff: () => ({}), printCrawlChangeSummary: () => {}, writeCrawlChangeSummaryToGH: () => {},
      writeJobsSummary: () => {}, printPublishedJobUrls: () => {}, captureLostSlugs: () => {},
      mergeLocaleTextMap: (previous: unknown, fresh: unknown) => fresh || previous,
      writeJson: (_file: string, jobs: Record<string, unknown>[]) => { written = jobs; },
      fs: { existsSync: () => true }, path: { dirname: () => '.' }, COMPANY_KEY: company, DATA_JOBS: 'scratch', PUBLIC_JOBS: 'public',
    });
    const fresh = { id: 'same-job', title: 'Role', ...unknown };
    existing = [{ id: 'same-job', ...sourcePostingDateFields('2026-02-18') }];
    merge([fresh]); expect(written[0]).toMatchObject(sourcePostingDateFields('2026-02-18'));
    existing = [{ id: 'same-job', postedDate: '2026-10-03' }];
    merge([fresh]); expect(written[0]).toMatchObject(unknown);
    existing = [{ id: 'same-job', ...sourcePostingDateFields('2026-02-18') }];
    merge([{ ...fresh, ...sourcePostingDateFields('2026-02-20') }]);
    expect(written[0]).toMatchObject(sourcePostingDateFields('2026-02-18'));
  });
});
