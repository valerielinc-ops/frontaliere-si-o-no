import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';

function realFunction(company: string, name: string, deps: Record<string, unknown> = {}) {
  const source = readFileSync(`scripts/lib/${company}-job-parser.mjs`, 'utf8');
  const ast = ts.createSourceFile(company, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(name);
  return vm.runInNewContext(`(${node.getText(ast).replace(/^export\s+/, '')})`, {
    Date, process, createHash, sourcePostingDateFields, mergeSourcePostingDates, console,
    normalizeSpace: (v: string) => v, stripHtml: (v: string) => v, detectLang: () => 'en', slugify: () => 'engineer',
    detectCategory: () => 'engineering', detectEmploymentType: () => 'FULL_TIME', detectExperienceLevel: () => 'mid',
    setTimeout: (fn: () => void) => fn(), ...deps,
  });
}
const detailUrl = 'https://jobs.example.test/engineer';
const description = 'Source vacancy duties, requirements and work location. '.repeat(20);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00Z')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });


const families = [
  ['kiabi', 'Kiabi'], ['oetiker', 'Oetiker'], ['staubli', 'Staubli'], ['talan', 'Talan'],
] as const;
async function crawl(company: string, suffix: string, dates: Record<string, unknown>) {
  const prefix = company.toUpperCase();
  const deps = {
    [`${prefix}_COMPANY_NAME`]: suffix, [`${prefix}_KEY`]: company, [`${prefix}_COMPANY_DOMAIN`]: `${company}.test`,
    CAREER_URL: detailUrl, SR_TENANT: suffix, SECTOR: 'Services', HQ: { city: 'Zurich', canton: 'ZH' },
    inferSwissTargetCanton: () => 'ZH', inferAnyCanton: () => 'ZH', guessCategory: () => 'engineering', normalizeContract: () => 'full-time',
    resolveAddress: () => ({ city: 'Zurich', region: 'ZH', postalCode: '8000', streetAddress: 'Source address' }),
    isCompleteSmartRecruitersSourceRead: () => true, provesSmartRecruitersFilteredEmpty: () => false,
    fetchSmartRecruitersJobs: async function* (_tenant: string, options: { onComplete?: (proof: unknown) => void }) {
      yield { title: 'Engineer', applyUrl: detailUrl, location: 'Zurich', descriptionHtml: description,
        jobReqId: '123', rawPosting: { id: '123', location: { city: 'Zurich' } }, ...dates };
      options.onComplete?.({ complete: true });
    },
  };
  const fetchJobListings = realFunction(company, 'fetchJobListings', deps);
  return realFunction(company, `fetchAll${suffix}Jobs`, { ...deps, fetchJobListings })();
}
describe.each(families)('%s normalized source provenance', (company, suffix) => {
  it.each([
    { label: 'full source offset', input: { ...sourcePostingDateFields('2026-09-23T10:30:00+02:00', new Date('2026-10-03T12:00:00Z')), postedAt: '2026-09-23' }, expected: '2026-09-23T10:30:00+02:00' },
    { label: 'unknown despite compatibility alias', input: { datePosted: '', postedDate: '', postingDateSource: 'unknown', postedAt: '2026-09-23' }, expected: '' },
    { label: 'unmarked legacy', input: { postedAt: '2026-09-23', postedDate: '2026-09-23', datePosted: '2026-09-23' }, expected: '' },
    { label: 'invalid marked calendar', input: { datePosted: '2026-02-30', postedDate: '2026-02-30', postingDateSource: 'reported' }, expected: '' },
    { label: 'future intraday', input: { datePosted: '2026-10-03T23:30:00+02:00', postedDate: '2026-10-03T23:30:00+02:00', postingDateSource: 'reported' }, expected: '' },
  ])('preserves the contract through discovery and builder: $label', async ({ input, expected }) => {
    const jobs = await crawl(company, suffix, input);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  });
});
