import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { normalizeGreenhouseJob } from '../scripts/lib/ats-clients/greenhouse-client.mjs';
import { normalizeLeverJob } from '../scripts/lib/ats-clients/lever-client.mjs';
import { constPrefix, pascalIdentifier } from '../scripts/lib/crawler-identifier.mjs';
import { mergeSourcePostingDates, sourcePostingDateFields } from '../scripts/lib/source-posting-date.mjs';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));
vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (original) => ({
  ...(await original<Record<string, unknown>>()), politeFetch,
}));
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';

const source = fs.readFileSync(path.resolve(__dirname, '../scripts/scaffold-crawler.mjs'), 'utf8');
const day = new Date(Date.now() - 3 * 86400000).toISOString();
const description = 'Develop reliable software applications, collaborate with colleagues, maintain production systems and support customers in the Swiss office.';
const stripImports = (text: string) => text.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '');

function generatedParser(tier: string) {
  // Execute the real template construction only; never run filesystem writers,
  // manifest registration, logo fetching or any generated cron in a test.
  const prefix = source.slice(source.indexOf('const args ='), source.indexOf('/* ── Template: Runner'));
  return vm.runInNewContext(`${prefix}\natsTier === 'workday' ? workdayParserContent : parserContent`, {
    process: { argv: ['node', 'scaffold', 'fixture-employer', '--ats', tier], exit: () => { throw new Error('unexpected scaffold exit'); } },
    fs: { existsSync: () => false }, path, ROOT: '/fixture-only', constPrefix, pascalIdentifier, console,
  }) as string;
}

async function generatedJobs(tier: string, input: Record<string, unknown>) {
  const listing = { title: 'Software Engineer', location: 'Lugano', applyUrl: 'https://fixtureemployer.ch/job/1/', url: 'https://fixtureemployer.ch/job/1/', descriptionHtml: description, description, ...input };
  const code = stripImports(generatedParser(tier)).replace(/^export\s+/gm, '');
  const context = {
    console: { log: () => {}, warn: () => {}, error: () => {} }, URL, createHash,
    mergeSourcePostingDates, detectLang: () => 'en', slugify: (value: string) => value.toLowerCase().replace(/\W+/g, '-'),
    stripHtml: (value: string) => value.replace(/<[^>]*>/g, ''), inferSwissTargetCanton: () => 'TI',
    fetchGreenhouseJobs: async () => [listing], extractGreenhouseBoardToken: () => 'fixture',
    fetchLeverJobs: async () => [listing], extractLeverCompanySlug: () => 'fixture',
    detectSuccessFactorsKind: () => 'html-career', SuccessFactorsAuthError: Error,
    fetchSuccessFactorsJobs: async function* () { yield listing; },
    loadSpec: () => ({}), runSpecInProduction: async () => [listing],
    resolveSourceBackedSwissGeography: () => ({ location: 'Lugano', canton: 'TI' }),
  };
  return await vm.runInNewContext(`${code}\nfetchAllFixtureEmployerJobs()`, context) as Array<Record<string, unknown>>;
}

describe('generated crawler publication provenance', () => {
  it.each(['greenhouse', 'lever', 'successfactors', 'prospected'])('%s preserves the complete verified tuple through fetch and builder', async (tier) => {
    const [job] = await generatedJobs(tier, sourcePostingDateFields(day));
    expect(job).toMatchObject({ datePosted: day, postedDate: day, postingDateSource: 'reported' });
  });
  it.each(['greenhouse', 'lever', 'successfactors', 'prospected'])('%s never promotes an unmarked observation/creation alias', async (tier) => {
    const [job] = await generatedJobs(tier, { postedAt: day, postedDate: day, createdAt: day });
    expect(job).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    expect(job.crawledAt).toBeTruthy();
  });
  it('does not invent a SuccessFactors description to emit a job', async () => {
    expect(await generatedJobs('successfactors', { ...sourcePostingDateFields(day), descriptionHtml: '' })).toEqual([]);
  });
  it('preserves real Greenhouse first_published through normalization and generated output', async () => {
    const normalized = normalizeGreenhouseJob({ id: 1, title: 'Software Engineer', location: { name: 'Lugano' }, absolute_url: 'https://fixtureemployer.ch/job/1/', content: description.repeat(4), first_published: day }, { includeContent: true });
    const [job] = await generatedJobs('greenhouse', normalized);
    expect(job).toMatchObject({ datePosted: day, postedDate: day, postingDateSource: 'reported' });
  });
  it('does not attest a real Greenhouse updated_at or Lever createdAt as publication', async () => {
    const greenhouse = normalizeGreenhouseJob({ id: 1, title: 'Software Engineer', location: { name: 'Lugano' }, absolute_url: 'https://fixtureemployer.ch/job/1/', content: description.repeat(4), updated_at: day }, { includeContent: true });
    const lever = normalizeLeverJob({ id: '1', text: 'Software Engineer', categories: { location: 'Lugano' }, hostedUrl: 'https://fixtureemployer.ch/job/1/', description, createdAt: Date.parse(day) });
    for (const [tier, normalized] of [['greenhouse', greenhouse], ['lever', lever]] as const) {
      const [job] = await generatedJobs(tier, normalized);
      expect(job).toMatchObject({ datePosted: '', postedDate: '', postingDateSource: 'unknown' });
    }
  });
  it('dispatches Workday to its source-aware factory instead of the unused generic fetch block', () => {
    expect(generatedParser('workday')).toContain('createWorkdaySwissParser');
    expect(generatedParser('workday')).not.toContain('parseWorkdayPostedDate');
  });
});

describe('Prospector runtime publication evidence', () => {
  const seed = 'https://careers.accor.com/jobs/';
  const detailUrl = 'https://careers.accor.com/jobs/software-engineer/';
  const jsonld = (datePosted?: string) => `<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Software Engineer', url: detailUrl, description,
    ...(datePosted ? { datePosted } : {}),
    jobLocation: { address: { addressLocality: 'Lugano', addressCountry: 'CH' } },
  })}</script>`;
  it.each([
    ['listing', day, undefined], ['detail', undefined, day], ['both unknown', undefined, undefined],
  ])('preserves %s evidence through actual extraction and detail enrichment', async (_name, listingDate, detailDate) => {
    politeFetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, body: jsonld(url === seed ? listingDate : detailDate), url, host: new URL(url).hostname }));
    const [row] = await runSpecInProduction({ companyKey: 'fixture', companyName: 'Fixture', mode: 'jsonld', seedUrls: [seed], detailTemplate: '/jobs/*', detailEnrichment: true } as any, { lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] });
    const expected = listingDate || detailDate;
    expect(row).toMatchObject({ postedDate: expected || '', datePosted: expected || '', postingDateSource: expected ? 'reported' : 'unknown', postedAt: expected || null });
  });
});
