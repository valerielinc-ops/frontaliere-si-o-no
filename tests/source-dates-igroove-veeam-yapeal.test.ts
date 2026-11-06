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



const families = [['igroove', 'Igroove'], ['veeam', 'Veeam'], ['yapeal', 'Yapeal']] as const;
async function crawl(company: string, suffix: string, dates: Record<string, unknown>) {
  const prefix = company.toUpperCase();
  const job = { title: 'Engineer', applyUrl: detailUrl, location: 'Zurich', descriptionHtml: description,
    jobReqId: '123', rawPosition: { createdAt: '2026-09-23T10:30:00Z' }, ...dates };
  const deps = {
    [`${prefix}_COMPANY_NAME`]: suffix, [`${prefix}_KEY`]: company, [`${prefix}_COMPANY_DOMAIN`]: `${company}.test`,
    CAREER_URL: detailUrl, PERSONIO_SUBDOMAIN: company, GREENHOUSE_BOARD: company, SECTOR: 'Services', HQ: { city: 'Zurich', canton: 'ZH' },
    inferSwissTargetCanton: () => 'ZH', decodeHtmlEntities: (v: string) => v,
    resolveAddress: () => ({ city: 'Zurich', canton: 'ZH', region: 'ZH', postalCode: '8000', streetAddress: 'Source address' }),
    resolveLocation: () => ({ location: 'Zurich', city: 'Zurich', canton: 'ZH', region: 'ZH', postalCode: '8000', streetAddress: 'Source address' }),
    isWorkModeLocationLabel: () => false, SWISS_LOCATION_RE: /Zurich/,
    fetchPersonioJobs: async () => [job], fetchGreenhouseJobs: async () => [job],
  };
  const fetchJobListings = company === 'veeam' ? realFunction(company, 'fetchJobListings', deps) : undefined;
  return realFunction(company, `fetchAll${suffix}Jobs`, { ...deps, fetchJobListings })();
}
describe.each(families)('%s publication provenance consumer', (company, suffix) => {
  it.each([
    { label: 'full verified timestamp', input: { datePosted: '2026-09-23T10:30:00+02:00', postedDate: '2026-09-23T10:30:00+02:00', postingDateSource: 'reported', postedAt: '2026-09-23' }, expected: '2026-09-23T10:30:00+02:00' },
    { label: 'explicit unknown', input: { datePosted: '', postedDate: '', postingDateSource: 'unknown', postedAt: '2026-09-23' }, expected: '' },
    { label: 'unmarked creation or update compatibility alias', input: { postedAt: '2026-09-23', postedDate: '2026-09-23', datePosted: '2026-09-23' }, expected: '' },
    { label: 'invalid marked calendar', input: { datePosted: '2026-02-30', postedDate: '2026-02-30', postingDateSource: 'reported' }, expected: '' },
    { label: 'future intraday', input: { datePosted: '2026-10-03T23:30:00+02:00', postedDate: '2026-10-03T23:30:00+02:00', postingDateSource: 'reported' }, expected: '' },
  ])('preserves source provenance through the producer: $label', async ({ input, expected }) => {
    const jobs = await crawl(company, suffix, input);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown' });
  });
});
