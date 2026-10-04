import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';
import { fetchAllGimArchitektenJobs } from '../scripts/lib/gim-architekten-job-parser.mjs';
import { fetchAllHofweissbadJobs } from '../scripts/lib/hofweissbad-job-parser.mjs';
import { fetchAllSaintGobainWeberIsoverJobs } from '../scripts/lib/saint-gobain-weber-isover-job-parser.mjs';
import { fetchAllRehabBaselJobs } from '../scripts/lib/rehab-basel-job-parser.mjs';
import { buildJob, parseListingPage } from '../scripts/lib/ferrovia-retica-job-parser.mjs';
import { mergeDiscoveredJobWithPrev } from '../scripts/update-ferrovia-retica-jobs.mjs';
import { buildHeinekenChJob } from '../scripts/lib/heineken-ch-job-parser.mjs';
import * as pictet from '../scripts/lib/pictet-job-parser.mjs';
import * as hirslanden from '../scripts/lib/hirslanden-job-parser.mjs';

const replay = vi.hoisted(() => ({ raw: '' }));
const description = 'This vacancy involves clinical and technical support for colleagues and customers in the Swiss office. '.repeat(12);
vi.mock('../scripts/lib/jobs-ch-company-pages.mjs', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  collectJobsChVacancyUrls: async () => ({ vacancyUrls: ['https://www.jobs.ch/de/stellenangebote/detail/abc/'] }),
  fetchJobsChVacancyInOriginalLanguage: async () => ({ url: 'https://www.jobs.ch/de/stellenangebote/detail/abc/', sourceLang: 'de',
    html: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Quality specialist', datePosted: replay.raw,
      description: 'Source vacancy duties and requirements at the Swiss workplace. '.repeat(20),
      jobLocation: { address: { addressLocality: 'Zurich', postalCode: '8001' } } })}</script>` }),
}));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00Z')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const unknown = { postedDate: '', datePosted: '', postingDateSource: 'unknown' };
const cases = ['2026-09-23T09:00:00+02:00', '', '2026-02-30', '2026-10-04'];

function realFunction(file: string, name: string, deps: Record<string, unknown>) {
  const source = readFileSync(`scripts/lib/${file}-job-parser.mjs`, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!declaration) throw new Error(`Missing ${name}`);
  return vm.runInNewContext(`(${declaration.getText(ast).replace(/^export\s+/, '')})`, {
    ...deps, Date, createHash, sourcePostingDateFields, mergeSourcePostingDates, console,
  });
}
describe.each([
  ['GIM', fetchAllGimArchitektenJobs], ['Hof Weissbad', fetchAllHofweissbadJobs], ['Saint Gobain', fetchAllSaintGobainWeberIsoverJobs],
] as const)('%s explicit JSON-LD publication', (_name, fetchJobs) => {
  it.each(cases)('validates complete date %j in the actual producer', async (raw) => {
    replay.raw = raw;
    const jobs = await fetchJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject(sourcePostingDateFields(raw));
  });
});
describe('remaining employer producer publication contracts', () => {
  it('Pictet preserves only verified publication from the shared SuccessFactors client', () => {
    const build = pictet.__testables.buildParsedJobFromSf;
    const input = { title: 'Engineer', location: 'Zurich', descriptionHtml: description,
      applyUrl: 'https://career012.successfactors.eu/career?company=banquepict&career_job_req_id=123' };
    const known = sourcePostingDateFields('2026-09-23T09:00:00+02:00');
    expect(build({ ...input, ...known })).toMatchObject(known);
    expect(build({ ...input, postedAt: '2026-09-23' })).toMatchObject(unknown);
    expect(build({ ...input, postingDateSource: 'reported', datePosted: '2026-02-30' })).toMatchObject(unknown);
    expect(build({ ...input, postingDateSource: 'reported', datePosted: '2026-10-04' })).toMatchObject(unknown);
  });
  it.each(cases)('RhB preserves only valid explicit input %j', (raw) => {
    expect(buildJob({ title: 'Engineer', url: 'https://www.rhb.ch/de/job/engineer/', location: 'Chur', datePosted: raw, description }))
      .toMatchObject(sourcePostingDateFields(raw));
  });
  it('RhB never promotes an adjacent employment-start date', () => {
    const jobs = parseListingPage('<p>Arbeitsbeginn 1. Oktober 2026</p><a href="/de/job/engineer">Engineer in Chur</a>');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].datePosted).toBe('');
  });
  it('RhB recrawl preserves verified history and clears unmarked legacy dates atomically', () => {
    const fresh = { title: 'Engineer', sourceLang: 'de', ...unknown };
    expect(mergeDiscoveredJobWithPrev(fresh, { ...sourcePostingDateFields('2026-09-23'), sourceLang: 'de' }))
      .toMatchObject(sourcePostingDateFields('2026-09-23'));
    expect(mergeDiscoveredJobWithPrev(fresh, { postedDate: '2026-09-23', sourceLang: 'de' })).toMatchObject(unknown);
  });
  it('Heineken Drupal detail without publication does not receive today', () => {
    const job = buildHeinekenChJob({ row: { title: 'Engineer', href: '/job/heineken-switzerland/switzerland/engineer' },
      detail: { title: 'Engineer', location: 'Chur', description }, detailUrl: 'https://careers.theheinekencompany.com/job/heineken-switzerland/switzerland/engineer' });
    expect(job).not.toBeNull();
    expect(job).toMatchObject(unknown);
  });
  it.each(['23.09.2026', '', '30.02.2026', '04.10.2026'])('REHAB validates the original listing date %j', async (raw) => {
    const listing = readFileSync('tests/fixtures/rehab-basel/listing-297.html', 'utf8').replace('23.09.2026', raw);
    const detail = readFileSync('tests/fixtures/rehab-basel/detail-297.html', 'utf8');
    const jobs = await fetchAllRehabBaselJobs({ fetchPage: async (url: string) => url.includes('liste-aller') ? listing : detail, delayMs: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject(raw === '23.09.2026' ? sourcePostingDateFields('2026-09-23') : unknown);
  });
  it.each(cases)('Hirslanden builder validates listing publication %j without today fallback', async (raw) => {
    const crawl = realFunction('hirslanden', 'fetchAllHirslandenJobs', {
      ...hirslanden, process: { env: {} }, SEARCH_URL: 'https://careers.mediclinic.com/Hirslanden/search', PAGE_SIZE: 25,
      fetchPage: async () => '', parseSearchResults: () => [{ title: 'Nurse', url: 'https://careers.mediclinic.com/Hirslanden/job/nurse/123/', location: 'Zurich', postedDate: raw }],
      extractTotalResults: () => 1, parseDetailPage: () => ({ title: 'Nurse', description, location: 'Zurich' }),
      normalizeSpace: (v: string) => v, resolveHirslandenLocation: () => 'Zurich', inferSwissTargetCanton: () => 'ZH',
      detectExperienceLevel: () => 'mid', hqPostalCodeForLocality: () => '8001', meetsSourceBodyFloor: () => true, slugify: () => 'nurse', sourceLangOfBody: () => 'en',
      dropSameSourceReference: (jobs: unknown[]) => ({ jobs, dropped: [] }), hirslandenReferenceNumber: () => '',
      setTimeout: (fn: () => void) => fn(),
    });
    const jobs = await crawl();
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject(sourcePostingDateFields(raw));
  });
});
