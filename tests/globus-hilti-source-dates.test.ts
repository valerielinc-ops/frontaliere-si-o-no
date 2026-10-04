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
    Date, createHash, sourcePostingDateFields, mergeSourcePostingDates, console,
    normalizeSpace: (v: string) => v, stripHtml: (v: string) => v, detectLang: () => 'en', slugify: () => 'engineer',
    detectCategory: () => 'engineering', detectEmploymentType: () => 'FULL_TIME', detectExperienceLevel: () => 'mid',
    setTimeout: (fn: () => void) => fn(), ...deps,
  });
}
const detailUrl = 'https://jobs.example.test/engineer';
const description = 'Source vacancy duties, requirements and work location. '.repeat(20);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T12:00:00Z')); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function globus(raw: string) {
  const posting = { '@type': 'JobPosting', title: 'Engineer', description, datePosted: raw, jobLocation: { address: { addressLocality: 'Zurich' } } };
  const fetchJobListings = realFunction('globus', 'fetchJobListings', {
    CAREER_URL: detailUrl, UA: 'test', HQ: { city: 'Zurich' }, extractDetailUrls: () => [detailUrl],
    fetchHtml: async () => `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
    extractJobPosting: realFunction('globus', 'extractJobPosting'),
  });
  return realFunction('globus', 'fetchAllGlobusJobs', {
    CAREER_URL: detailUrl, fetchJobListings, HQ: { city: 'Zurich', canton: 'ZH' }, inferSwissTargetCanton: () => 'ZH',
    GLOBUS_KEY: 'globus', GLOBUS_COMPANY_NAME: 'Globus', GLOBUS_COMPANY_DOMAIN: 'globus.ch', SECTOR: 'Retail',
  })();
}
async function hilti(raw: string) {
  const posting = { '@type': 'JobPosting', title: 'Engineer', description, datePosted: raw };
  const fetchDetailPage = realFunction('hilti', 'fetchDetailPage', {
    PER_DETAIL_DELAY_MS: 0, DETAIL_WAIT_SELECTOR_MS: 1,
    fetchWithRateLimit: async () => ({ waitForSelector: async () => {}, $$eval: async () => [JSON.stringify(posting)] }),
    safeClose: async () => {}, pickJobPosting: realFunction('hilti', 'pickJobPosting'),
    schemaJobLocationCandidates: () => [{ addressLocality: 'Zurich', addressCountry: 'CH' }],
    normalizeDescriptionBullets: (v: string) => v, AntiBotBlockError: Error, NavigationTimeout: Error,
  });
  const fetchJobListings = realFunction('hilti', 'fetchJobListings', {
    CAREER_URL: detailUrl, BROWSER_UA: 'test', createBrowser: async () => ({}), createPoliteContext: async () => ({}), closeAll: async () => {},
    fetchListingRows: async () => [{ title: 'Engineer', url: detailUrl, location: 'Zurich', jobReqId: '123' }], fetchDetailPage,
  });
  return realFunction('hilti', 'fetchAllHiltiJobs', {
    CAREER_URL: detailUrl, fetchJobListings, HQ: { addressLocality: 'Zurich' },
    resolveHiltiListingGeography: () => ({ geography: { location: 'Zurich', canton: 'ZH' }, candidate: { addressLocality: 'Zurich' } }),
    meetsSourceBodyFloor: () => true, HILTI_KEY: 'hilti', HILTI_COMPANY_NAME: 'Hilti', HILTI_COMPANY_DOMAIN: 'hilti.com', HILTI_SECTOR: 'Engineering',
  })();
}
describe.each([['Globus rexx', globus], ['Hilti Umbraco', hilti]] as const)('%s source publication chain', (_name, crawl) => {
  it.each(['2026-09-23T10:30:00+02:00', '', '2026-02-30', '2026-10-03T23:30:00+02:00', '2026-09-23T99:30:00+02:00'])(
    'keeps the full JobPosting publication %j and marker through all projections', async (raw) => {
      const jobs = await crawl(raw);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject(sourcePostingDateFields(raw));
    },
  );
});
