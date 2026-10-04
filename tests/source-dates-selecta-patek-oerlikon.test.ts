import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';

import { successFactorsPostingDateFields } from '../scripts/lib/ats-clients/successfactors-client.mjs';
import { meetsSourceBodyFloor } from '../scripts/lib/source-body-floor.mjs';
import { extractJobPostingField } from '../scripts/lib/jobposting-jsonld.mjs';

function realFunction(company: string, name: string, deps: Record<string, unknown> = {}) {
  const source = readFileSync(`scripts/lib/${company}-job-parser.mjs`, 'utf8');
  const ast = ts.createSourceFile(company, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(name);
  return vm.runInNewContext(`(${node.getText(ast).replace(/^export\s+/, '')})`, {
    Date, process, createHash, meetsSourceBodyFloor, extractJobPostingField, successFactorsPostingDateFields, sourcePostingDateFields, mergeSourcePostingDates, console,
    normalizeSpace: (v: string) => v, stripHtml: (v: string) => v, detectLang: () => 'en', slugify: () => 'engineer',
    detectCategory: () => 'engineering', detectEmploymentType: () => 'FULL_TIME', detectExperienceLevel: () => 'mid',
    normalize: (v: string) => v.toLowerCase(),
    normalizeDescriptionBullets: (v: string) => v, sanitizeSuccessFactorsField: (v: string) => v,
    setTimeout: (fn: () => void) => fn(), ...deps,
  });
}
const detailUrl = 'https://jobs.example.test/engineer';
const description = 'Source vacancy duties, requirements and work location. '.repeat(20);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00Z')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });


async function selecta(raw: string) {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted: raw })}</script>`;
  const fetchJobDetail = realFunction('selecta', 'fetchJobDetail', {
    ATS_HOST: 'careers.selecta.ch', fetchHtml: async () => html, extractJobAdContent: () => description,
  });
  return realFunction('selecta', 'fetchAllSelectaJobs', {
    SELECTA_COMPANY_NAME: 'Selecta', SELECTA_KEY: 'selecta', SELECTA_COMPANY_DOMAIN: 'selecta.com',
    LISTING_URL: detailUrl, ATS_HOST: 'careers.selecta.ch', SECTOR: 'Services', HQ: { city: 'Zurich' },
    fetchJobListings: async () => [{ Id: 4614, Title: 'Engineer', Location: 'Zurich', OnlineDateCorrected: '/Date(1790899200000)/' }],
    resolveAddress: () => ({ city: 'Zurich', canton: 'ZH' }), fetchJobDetail,
  })();
}
async function patek(raw: string) {
  const enrichFromDetail = realFunction('patek-philippe', 'enrichFromDetail', {
    CRAWLER_UA: 'test', fetchHtml: async () => `<meta itemprop="datePosted" content="${raw}">`,
    microdata: realFunction('patek-philippe', 'microdata', { textOf: (v: string) => v, decodeEntities: (v: string) => v }),
  });
  return realFunction('patek-philippe', 'fetchAllPatekPhilippeJobs', {
    PATEK_PHILIPPE_COMPANY_NAME: 'Patek Philippe', PATEK_PHILIPPE_KEY: 'patek-philippe', PATEK_PHILIPPE_COMPANY_DOMAIN: 'patek.com',
    CAREER_URL: detailUrl, SECTOR: 'Watches', HQ: { city: 'Geneva', canton: 'GE' }, inferSwissTargetCanton: () => 'GE',
    fetchJobListings: async () => [{ title: 'Engineer', url: detailUrl, location: 'Geneva' }], enrichFromDetail,
  })();
}
async function oerlikon(raw: string) {
  const fetchJobDetail = realFunction('oerlikon', 'fetchJobDetail', {
    fetchHtml: async () => `<meta itemprop="datePosted" content="${raw}">`,
  });
  return realFunction('oerlikon', 'fetchAllOerlikonJobs', {
    OERLIKON_COMPANY_NAME: 'Oerlikon', OERLIKON_KEY: 'oerlikon', OERLIKON_COMPANY_DOMAIN: 'oerlikon.com',
    SEARCH_API_URL: detailUrl, CAREER_HOST: 'careers.oerlikon.com', LOCALE: 'en_US', HQ: { city: 'Zurich', canton: 'ZH' }, inferAnyCanton: () => 'ZH',
    listSwissJobs: async () => [{ unifiedStandardTitle: 'Engineer', urlTitle: 'engineer', id: 123, jobLocationShort: ['Zurich'], unifiedStandardStart: '10/2/26' }], fetchJobDetail,
  })();
}
describe.each([['Selecta', selecta], ['Patek', patek], ['Oerlikon', oerlikon]] as const)('%s explicit source publication', (_name, crawl) => {
  it.each(['2026-06-25', '2026-09-23T10:30:00+02:00', '', '2026-02-30', '2026-10-03T23:30:00+02:00'])(
    'preserves only valid original publication %j through detail and builder', async (raw) => {
      const jobs = await crawl(raw);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(sourcePostingDateFields(raw));
    },
  );
});
it.each([patek, oerlikon])('normalizes explicit SuccessFactors Java microdata without truncating time', async (crawl) => {
  const jobs = await crawl('Fri Jul 03 00:00:00 UTC 2026');
  expect(jobs[0]).toMatchObject({ datePosted: '2026-07-03T00:00:00Z', postedDate: '2026-07-03T00:00:00Z', postingDateSource: 'reported' });
});
