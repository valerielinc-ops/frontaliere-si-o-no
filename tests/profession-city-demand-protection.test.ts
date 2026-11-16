// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_INDEXABLE_WORDS } from '../build-plugins/constants';
import {
  emitProfessionCityPages,
  professionCityLandings,
  renderProfessionCityPage,
} from '../build-plugins/professionCityLandings';
import { buildProfessionCityPath } from '../build-plugins/professionCityData';
import { PROFESSION_LOCALES } from '../build-plugins/professionLandingsData';
import type { FeaturedJob, ProfessionJobsSnapshot } from '../build-plugins/professionJobsAggregate';
import { renderProfessionCityInsights } from '../build-plugins/professionCityInsights';
import {
  _resetForTests as resetTrafficEvidence,
  GSC_DEMAND_MIN_IMPRESSED_PATHS,
  GSC_DEMAND_WINDOW_DAYS,
} from '../build-plugins/shared/trafficEvidenceFilter';

const fixtures = vi.hoisted(() => ({
  byRoot: new Map<string, unknown>(),
  wordCount: undefined as number | undefined,
}));

vi.mock('../build-plugins/professionJobsAggregate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../build-plugins/professionJobsAggregate')>();
  return {
    ...actual,
    aggregateProfessionJobsByCity: (rootDir: string) => fixtures.byRoot.get(rootDir) ?? {},
  };
});

vi.mock('../build-plugins/professionCityData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../build-plugins/professionCityData')>();
  return { ...actual, PROFESSION_CITY_KEYS: ['lugano'] };
});

vi.mock('../build-plugins/professionLandingsData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../build-plugins/professionLandingsData')>();
  return { ...actual, PROFESSION_IDS: ['infermiere'] };
});

vi.mock('../build-plugins/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../build-plugins/constants')>();
  return {
    ...actual,
    countHtmlBodyWords: (html: string) => fixtures.wordCount ?? actual.countHtmlBodyWords(html),
  };
});

const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profession-city-demand-protection-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  return root;
};

afterEach(() => {
  fixtures.byRoot.clear();
  fixtures.wordCount = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  resetTrafficEvidence();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

function featuredJob(index: number): FeaturedJob {
  const title = `Infermiere specializzato in assistenza ${index}`;
  return {
    id: `fixture-nurse-${index}`,
    title,
    titleByLocale: { it: title, en: `Nurse specialist ${index}`, de: `Pflegefachperson ${index}`, fr: `Infirmier spécialisé ${index}` },
    company: `Clinica Lugano ${index}`,
    companyKey: null,
    companyDomain: null,
    city: 'Lugano',
    addressLocality: 'Lugano',
    canton: 'TI',
    contract: null,
    salaryMin: null,
    salaryMax: null,
    postedDate: daysAgo(index + 1),
    daysAgo: index + 1,
    slug: `fixture-nurse-${index}`,
    slugByLocale: {},
    employmentType: null,
    url: null,
  };
}

function snapshot(liveCount: number): ProfessionJobsSnapshot {
  const jobs = Array.from({ length: liveCount }, (_, index) => featuredJob(index));
  return {
    liveCount,
    fresh30Count: liveCount,
    medianSalaryChf: null,
    featured: jobs.slice(0, 3),
    jobs,
    topEmployers: jobs.map((job) => ({ name: job.company, count: 1 })),
  };
}

function byCity(value: ProfessionJobsSnapshot | undefined): unknown {
  return value ? { lugano: { infermiere: value } } : {};
}

function writeEvidence(root: string, impressedPaths: readonly string[], active = true): void {
  const pages: Record<string, number> = Object.fromEntries(impressedPaths.map((urlPath) => [urlPath, 1]));
  const targetSize = active ? GSC_DEMAND_MIN_IMPRESSED_PATHS : GSC_DEMAND_MIN_IMPRESSED_PATHS - 1;
  let filler = 0;
  while (Object.keys(pages).length < targetSize) pages[`/synthetic-city-gsc-path-${filler++}/`] = 1;
  fs.writeFileSync(
    path.join(root, 'data', 'evidence-index.json'),
    JSON.stringify({ windowDays: GSC_DEMAND_WINDOW_DAYS, gsc: { pages } }),
  );
}

const paths = (): string[] => PROFESSION_LOCALES.map((locale) => buildProfessionCityPath(locale, 'lugano', 'infermiere'));
const robotsOf = (html: string): string =>
  html.match(/<meta[^>]*\bname=["']?robots["']?[^>]*\bcontent=["']?([^"'>]+)/i)?.[1]?.replace(/\s+/g, '') ?? '';
const readPage = (root: string, urlPath: string): string =>
  fs.readFileSync(path.join(root, 'dist', urlPath.replace(/^\/+/, ''), 'index.html'), 'utf8');

describe('profession-city 90-day GSC demand protection', () => {
  it('protects the whole four-locale group from one impressed path and includes it in the sitemap', async () => {
    const root = temporaryRoot();
    const localePaths = paths();
    fixtures.byRoot.set(root, byCity(snapshot(2)));
    writeEvidence(root, [localePaths[2]]);

    const result = await emitProfessionCityPages({ rootDir: root, distDir: path.join(root, 'dist') });
    expect(result.pagesWritten).toBe(4);
    expect(result.pagesDemandProtected).toBe(1);
    expect(result.emittedPaths.sort()).toEqual([...localePaths].sort());
    const sitemap = fs.readFileSync(path.join(root, 'dist', 'sitemap-profession-cities.xml'), 'utf8');
    for (const urlPath of localePaths) {
      expect(robotsOf(readPage(root, urlPath)), urlPath).toMatch(/^index,follow(?:,|$)/);
      expect(sitemap).toContain(`<loc>https://frontaliereticino.ch${urlPath}</loc>`);
    }

    const page = renderProfessionCityPage({ locale: 'it', cityKey: 'lugano', id: 'infermiere', snapshot: snapshot(2), distDir: path.join(root, 'dist') });
    expect(page.html).toContain('Infermiere specializzato in assistenza 0');
    expect(page.html).toContain('Infermiere specializzato in assistenza 1');
    expect(page.html).not.toMatch(/(?:almeno|at least|mindestens|au moins)\s+3\s+(?:annunci|offerte|jobs|Stellen|offres)/i);
    const insights = renderProfessionCityInsights({ locale: 'it', cityKey: 'lugano', id: 'infermiere', snapshot: snapshot(2), minJobs: 3 });
    expect(insights).toContain('Le offerte per Infermiere a Lugano');
    expect(insights).not.toMatch(/(?:almeno|at least|mindestens|au moins)\s+3\s+(?:annunci|offerte|jobs|Stellen|offres)/i);

    // The plugin's reported counter is the same pair count exposed in the result.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const closeBundle = professionCityLandings(root).closeBundle;
    if (typeof closeBundle !== 'function') throw new Error('Expected profession-city closeBundle hook');
    await closeBundle.call({} as never);
    expect(log.mock.calls.flat().join('\n')).toContain('1 demand-protected pairs by GSC 90d');
  });

  it('bridges a 1–2-job group without impressions and leaves it outside the sitemap', async () => {
    const root = temporaryRoot();
    fixtures.byRoot.set(root, byCity(snapshot(2)));
    writeEvidence(root, []);

    const result = await emitProfessionCityPages({ rootDir: root, distDir: path.join(root, 'dist') });
    expect(result.pagesSkippedForJobs).toBe(1);
    expect(result.pagesDemandProtected).toBe(0);
    expect(result.bridgesWritten).toBe(4);
    expect(result.emittedPaths).toEqual([]);
    expect(fs.existsSync(path.join(root, 'dist', 'sitemap-profession-cities.xml'))).toBe(false);
    for (const urlPath of paths()) expect(robotsOf(readPage(root, urlPath))).toBe('noindex,follow');
  });

  it('keeps the current bridge behavior when an impression exists in dormant evidence', async () => {
    const root = temporaryRoot();
    const localePaths = paths();
    fixtures.byRoot.set(root, byCity(snapshot(1)));
    writeEvidence(root, [localePaths[0]], false);

    const result = await emitProfessionCityPages({ rootDir: root, distDir: path.join(root, 'dist') });
    expect(result.pagesSkippedForJobs).toBe(1);
    expect(result.bridgesWritten).toBe(4);
    expect(result.emittedPaths).toEqual([]);
    expect(fs.existsSync(path.join(root, 'dist', 'sitemap-profession-cities.xml'))).toBe(false);
  });

  it('keeps the all-locale word-count floor when a 1–2-job group has demand', async () => {
    const root = temporaryRoot();
    fixtures.byRoot.set(root, byCity(snapshot(2)));
    writeEvidence(root, [paths()[1]]);
    fixtures.wordCount = MIN_INDEXABLE_WORDS - 1;

    const result = await emitProfessionCityPages({ rootDir: root, distDir: path.join(root, 'dist') });
    expect(result.pagesSkippedForWordCount).toBe(4);
    expect(result.pagesDemandProtected).toBe(0);
    expect(result.bridgesWritten).toBe(4);
    expect(result.emittedPaths).toEqual([]);
    expect(fs.existsSync(path.join(root, 'dist', 'sitemap-profession-cities.xml'))).toBe(false);
  });

  it('bridges impressed groups with zero jobs or with no snapshot', async () => {
    const localePaths = paths();
    for (const [scenario, input] of [['zero count', byCity(snapshot(0))], ['missing snapshot', {}]] as const) {
      const root = temporaryRoot();
      fixtures.byRoot.set(root, input);
      writeEvidence(root, [localePaths[3]]);

      const result = await emitProfessionCityPages({ rootDir: root, distDir: path.join(root, 'dist') });
      expect(result.pagesSkippedForJobs, scenario).toBe(1);
      expect(result.pagesDemandProtected, scenario).toBe(0);
      expect(result.bridgesWritten, scenario).toBe(4);
      expect(result.emittedPaths, scenario).toEqual([]);
      expect(fs.existsSync(path.join(root, 'dist', 'sitemap-profession-cities.xml')), scenario).toBe(false);
      for (const urlPath of localePaths) expect(robotsOf(readPage(root, urlPath)), `${scenario} ${urlPath}`).toBe('noindex,follow');
    }
  });

  it('keeps the existing three-job result with and without impressions', async () => {
    const localePaths = paths();
    for (const [label, impressions] of [['with impression', [localePaths[0]]], ['without impression', []]] as const) {
      const root = temporaryRoot();
      fixtures.byRoot.set(root, byCity(snapshot(3)));
      writeEvidence(root, impressions);

      const result = await emitProfessionCityPages({ rootDir: root, distDir: path.join(root, 'dist') });
      expect(result.pagesWritten, label).toBe(4);
      expect(result.pagesDemandProtected, label).toBe(0);
      expect(result.emittedPaths.sort(), label).toEqual([...localePaths].sort());
      const sitemap = fs.readFileSync(path.join(root, 'dist', 'sitemap-profession-cities.xml'), 'utf8');
      for (const urlPath of localePaths) {
        expect(robotsOf(readPage(root, urlPath)), `${label} ${urlPath}`).toMatch(/^index,follow(?:,|$)/);
        expect(sitemap, `${label} ${urlPath}`).toContain(`<loc>https://frontaliereticino.ch${urlPath}</loc>`);
      }
    }
  });
});
