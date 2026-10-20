import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WOKIN_KEY,
  WOKIN_STELLEN_URL,
  buildWokinJob,
  fetchAllWokinJobs,
  isTrustedDomain,
  isWokinServiceTitle,
  parseWokinEmployerContext,
  parseWokinStellenPage,
} from '../scripts/lib/wokin-job-parser.mjs';
import { sourceBodyWordCount } from '../scripts/lib/source-body-floor.mjs';
import { evaluatePromotion } from '../scripts/lib/prospector/promotion-gate.mjs';
import { aggregateProfessionJobsByCanton } from '../build-plugins/professionJobsAggregate';
import {
  MIN_JOBS,
  meetsJobsFloor,
  renderProfessionBelowFloorBridge,
} from '../build-plugins/shared/professionJobsFloor';

const STELLEN_FIXTURE = readFileSync(
  new URL('./fixtures/wokin/stellen.html', import.meta.url),
  'utf8',
);
const HOMEPAGE_FIXTURE = readFileSync(
  new URL('./fixtures/wokin/homepage.html', import.meta.url),
  'utf8',
);

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureJob() {
  const parsed = parseWokinStellenPage(STELLEN_FIXTURE);
  const context = parseWokinEmployerContext(HOMEPAGE_FIXTURE);
  return buildWokinJob(
    parsed.vacancies[0],
    context,
    parsed.applicationText,
    new Date('2026-10-15T10:00:00.000Z'),
  );
}

describe('WOKIN cameriere:TG crawler', () => {
  it('pins the spec to the official Stellen page and current source title', () => {
    const spec = JSON.parse(readFileSync(
      new URL('../data/prospector/crawlers/wokin.json', import.meta.url),
      'utf8',
    ));
    expect(spec).toMatchObject({
      companyKey: WOKIN_KEY,
      companyHost: 'wokin.ch',
      seedUrls: [WOKIN_STELLEN_URL],
      sampleVacancyCount: 1,
      sampleTitles: ['Servicemitarbeiter/in 50 – 100 %'],
      canton: 'TG',
      sourceLang: 'de',
    });
    expect(JSON.stringify(spec)).not.toMatch(/jobborse|jobup|jobs\.ch/i);
  });

  it('extracts only the official service role, not the kitchen role', () => {
    const parsed = parseWokinStellenPage(STELLEN_FIXTURE);
    expect(parsed.vacancies).toEqual([{
      title: 'Servicemitarbeiter/in 50 – 100 %',
      location: 'Frauenfeld',
      locationLabel: 'Arbeitsort: Frauenfeld',
      availability: 'Ab sofort oder nach Vereinbarung',
      url: WOKIN_STELLEN_URL,
    }]);
    expect(parsed.applicationText).toBe('Haben wir dein Interesse geweckt? Dann melde dich doch bei uns.');
  });

  it('builds one source-backed TG waiter job without inventing a posting date', () => {
    const context = parseWokinEmployerContext(HOMEPAGE_FIXTURE);
    const job = fixtureJob();

    expect(context).toContain('Unser Restaurant bietet mehr als nur chinesisches Essen.');
    expect(job).toMatchObject({
      id: 'wokin-service-frauenfeld',
      company: 'WOKIN GmbH',
      companyKey: WOKIN_KEY,
      title: 'Servicemitarbeiter/in 50 – 100 %',
      location: 'Frauenfeld',
      canton: 'TG',
      addressLocality: 'Frauenfeld',
      addressRegion: 'TG',
      addressCountry: 'CH',
      url: WOKIN_STELLEN_URL,
      applyUrl: WOKIN_STELLEN_URL,
      category: 'Cameriere',
      postingDateSource: 'unknown',
      datePosted: '',
      postedDate: '',
    });
    expect(job?.description).toContain(context);
    expect(job?.description).toContain('Arbeitsort: Frauenfeld');
    expect(sourceBodyWordCount(job?.description)).toBeGreaterThanOrEqual(50);
    expect(isTrustedDomain(job?.url)).toBe(true);
    expect(isTrustedDomain('https://jobborse.ch/wokin')).toBe(false);
  });

  it('fetches both official pages and emits the fixture-backed job', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const body = url === WOKIN_STELLEN_URL ? STELLEN_FIXTURE : HOMEPAGE_FIXTURE;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    }));

    const jobs = await fetchAllWokinJobs();
    expect(jobs).toHaveLength(1);
    expect(requested.sort()).toEqual(['https://wokin.ch/', WOKIN_STELLEN_URL].sort());
  });

  it('passes the adaptive one-vacancy promotion gate with source evidence', () => {
    const observed = {
      verdict: 'good',
      score: 1,
      sampled: 1,
      vacancyCount: 1,
      reachableRate: 1,
      titleMatchRate: 1,
      contentfulRate: 1,
      locationSourceRate: 1,
      distinctRate: 1,
      detailDistinctRate: 1,
      jobLikeRate: 1,
      logoFound: true,
    };
    const gate = evaluatePromotion({
      status: 'promoted',
      crawlerKey: WOKIN_KEY,
      tenantHost: 'wokin.ch',
      aggregator: false,
      validationHistory: [
        { ...observed, at: '2026-10-14T10:00:00.000Z' },
        { ...observed, at: '2026-10-15T10:00:00.000Z' },
      ],
    }, { existingKeys: new Set(), hostOwners: new Map() });
    expect(gate.passed, gate.reasons.join('\n')).toBe(true);
  });

  it('classifies the German source title as cameriere in TG and keeps the landing noindex below three jobs', () => {
    expect(isWokinServiceTitle('Servicemitarbeiter Kundenservice')).toBe(false);
    expect(isWokinServiceTitle('Servicehilfskraft Reinigung')).toBe(false);
    expect(isWokinServiceTitle('Servicemitarbeiter/in 50 – 100 %')).toBe(true);
    expect(isWokinServiceTitle('Servicehilfskraft Restaurant 40-60%')).toBe(true);
    const job = fixtureJob();
    const root = mkdtempSync(path.join(os.tmpdir(), 'wokin-crawler-'));
    tempDirs.push(root);
    mkdirSync(path.join(root, 'data'));
    const unrelatedCustomerServiceJob = {
      ...job,
      id: 'unrelated-customer-service',
      slug: 'servicemitarbeiter-kundenservice',
      title: 'Servicemitarbeiter Kundenservice 100%',
    };
    writeFileSync(
      path.join(root, 'data', 'jobs.json'),
      `${JSON.stringify([job, unrelatedCustomerServiceJob])}\n`,
    );

    const snapshots = aggregateProfessionJobsByCanton(root, Date.parse('2026-10-15T10:00:00.000Z'));
    expect(snapshots.TG.cameriere.liveCount).toBe(1);
    expect(MIN_JOBS).toBe(3);
    expect(meetsJobsFloor({ liveCount: snapshots.TG.cameriere.liveCount }).meetsFloor).toBe(false);
    expect(renderProfessionBelowFloorBridge('it', 'TG', 'cameriere'))
      .toContain('<meta name="robots" content="noindex,follow">');
  });
});
