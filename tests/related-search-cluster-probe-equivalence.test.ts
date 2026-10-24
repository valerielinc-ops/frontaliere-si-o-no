// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TokenIndex,
  buildClusterContext,
  buildClusterContextFromSummary,
  decideClusterEmission,
  hasSelfCanonicalClusterUrl,
  isClusterBelowFloor,
  renderClusterPage,
  type ClusterTrafficFilter,
} from '../build-plugins/relatedSearchClustersPlugin';
import type {
  CandidateEntry,
  EnrichedEntry,
  RelatedSearchClusterSummaryEntry,
  RawJob,
} from '../build-plugins/relatedSearchClustersData';
import { BASE_URL } from '../build-plugins/constants';
import { SPA_ENTRY_CSS_FILENAME, SPA_ENTRY_JS_FILENAME } from '../build-plugins/shared/spaEntryFilenames';

const tmpDirs: string[] = [];
const TEST_DATE_STAMP = new Date().toISOString().slice(0, 10);

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-probe-'));
  tmpDirs.push(dir);
  const assetsDir = join(dir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, SPA_ENTRY_JS_FILENAME), 'console.log(1)', 'utf8');
  writeFileSync(join(assetsDir, SPA_ENTRY_CSS_FILENAME), 'body{}', 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JOBS: RawJob[] = [
  { id: 'alpha-beta', title: 'Alpha Beta', company: 'A', location: 'Lugano', canton: 'TI' },
  { id: 'alpha-gamma', title: 'Alpha Gamma', company: 'B', location: 'Lugano', canton: 'TI' },
  { id: 'beta-gamma', title: 'Beta Gamma', company: 'C', location: 'Lugano', canton: 'TI' },
];

const CANDIDATES: CandidateEntry[] = [
  {
    slug: 'ricerca-alpha-beta-gamma-lugano',
    locale: 'it',
    jobCount: 3,
    sampleTerms: ['alpha beta gamma Lugano'],
    editorialCollision: null,
  },
  {
    slug: 'ricerca-alpha-beta-lugano',
    locale: 'it',
    jobCount: 2,
    sampleTerms: ['alpha beta Lugano'],
    editorialCollision: null,
  },
  {
    slug: 'ricerca-ghost-lugano',
    locale: 'it',
    jobCount: 1,
    sampleTerms: ['ghost Lugano'],
    editorialCollision: null,
  },
  {
    slug: 'ricerca-empty',
    locale: 'it',
    jobCount: 1,
    sampleTerms: [],
    editorialCollision: null,
  },
  {
    slug: 'ricerca-alpha-beta-delta-lugano',
    locale: 'it',
    jobCount: 1,
    sampleTerms: ['alpha beta delta Lugano'],
    editorialCollision: null,
  },
];

const ENRICHED: Record<string, EnrichedEntry> = {
  'it::ricerca-ghost-lugano': {
    slug: 'ricerca-ghost-lugano',
    locale: 'it',
    keyword: 'ghost',
    city: 'Lugano',
    intro: 'Questa descrizione reale della ricerca aiuta chi vuole confrontare ruoli, aziende e condizioni di lavoro nel territorio svizzero. Riassume il tipo di posizione, la sede, gli aspetti da verificare prima della candidatura, le domande da porre al datore di lavoro e i criteri utili per valutare un percorso professionale come frontaliere. Il testo offre contesto autonomo e non è un segnaposto generato dal prompt.',
    faqs: [],
  },
};

function fullContext(candidate: CandidateEntry): ReturnType<typeof buildClusterContext> {
  return buildClusterContext(candidate, new TokenIndex(JOBS), JOBS);
}

function probedContext(candidate: CandidateEntry): ReturnType<typeof buildClusterContext> {
  const index = new TokenIndex(JOBS);
  const probe = buildClusterContext(candidate, index, JOBS, {
    maxJobs: 3,
    stopWhenAtLeast: 3,
  });
  if (!probe) return null;

  const enriched = ENRICHED[`${candidate.locale}::${candidate.slug}`];
  // A probe that did not reach the cap has enumerated the complete result. If
  // it reached the cap, the shared floor predicate says this is not a bridge;
  // rebuild only that case to recover the exact n=30 ordering/content.
  if (probe.matchingJobs.length < 3 || isClusterBelowFloor(probe, enriched)) return probe;
  return buildClusterContext(candidate, index, JOBS);
}

function pageDigest(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}

function renderSet(
  contexts: ReadonlyArray<NonNullable<ReturnType<typeof fullContext>>>,
): Map<string, string> {
  const distDir = makeDist();
  return new Map(contexts.map((ctx) => {
    const enriched = ENRICHED[`${ctx.candidate.locale}::${ctx.candidate.slug}`];
    const page = renderClusterPage({
      distDir,
      dateStamp: TEST_DATE_STAMP,
      ctx,
      enriched,
      hreflang: [],
      related: [],
    });
    return [page.urlPath, pageDigest(page.html)];
  }));
}

describe('related-search cluster floor probe', () => {
  it('keeps the emitted URL set and rendered HTML byte-equivalent', () => {
    const baseline = CANDIDATES.map(fullContext).filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== null);
    const optimized = CANDIDATES.map(probedContext).filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== null);

    expect(optimized.map((ctx) => [ctx.candidate.slug, ctx.matchingJobs.map((job) => job.id)])).toEqual(
      baseline.map((ctx) => [ctx.candidate.slug, ctx.matchingJobs.map((job) => job.id)]),
    );

    const baselinePages = renderSet(baseline);
    const optimizedPages = renderSet(optimized);
    expect([...optimizedPages.keys()].sort()).toEqual([...baselinePages.keys()].sort());
    for (const [url, digest] of baselinePages) expect(optimizedPages.get(url)).toBe(digest);
    expect(baselinePages.size).toBeGreaterThan(0);
  });

  it('retains a zero-match enriched page and a below-floor bridge', () => {
    const enriched = probedContext(CANDIDATES[2]);
    const bridge = probedContext(CANDIDATES[1]);
    expect(enriched?.matchingJobs).toHaveLength(0);
    expect(bridge?.matchingJobs).toHaveLength(1);
    expect(isClusterBelowFloor(enriched!, ENRICHED['it::ricerca-ghost-lugano'])).toBe(false);
    expect(isClusterBelowFloor(bridge!, undefined)).toBe(true);
  });

  it('keeps exact shard metadata while releasing foreign-locale job rows', () => {
    const candidate = CANDIDATES[1];
    const full = buildClusterContext(candidate, new TokenIndex(JOBS), JOBS)!;
    const compact = buildClusterContext(candidate, new TokenIndex(JOBS), JOBS, {
      retainMatchingJobs: false,
    })!;

    expect(compact.matchingJobs).toEqual([]);
    expect(compact.matchingJobCount).toBe(full.matchingJobs.length);
    expect(compact.legacyCantonGroup).toBe(full.legacyCantonGroup);
    expect(compact.keyword).toBe(full.keyword);
    expect(isClusterBelowFloor(compact, undefined)).toBe(isClusterBelowFloor(full, undefined));
  });
});

describe('TokenIndex floor probe API', () => {
  it('can stop after the first three valid OR matches', () => {
    const index = new TokenIndex(JOBS);
    index.seedPostings('it', [
      { token: 'alpha', list: [0, 1] },
      { token: 'beta', list: [0, 2] },
      { token: 'gamma', list: [1, 2] },
    ]);
    expect(index.matchingOccupationJobs('it', ['alpha', 'beta', 'gamma'], 3, 2, [], {
      stopWhenAtLeast: 3,
    })).toHaveLength(3);
  });
});

describe('locale-shard shared matching summary', () => {
  const jobs: RawJob[] = [
    { id: 'zh-alpha-beta', title: 'Alpha Beta', company: 'A', location: 'Zurich', canton: 'ZH' },
    { id: 'zh-alpha-gamma', title: 'Alpha Gamma', company: 'B', location: 'Zurich', canton: 'ZH' },
    { id: 'zh-beta-gamma', title: 'Beta Gamma', company: 'C', location: 'Zurich', canton: 'ZH' },
    { id: 'ti-gamma', title: 'Gamma', company: 'D', location: 'Lugano', canton: 'TI' },
  ];
  const candidates: CandidateEntry[] = [
    { slug: 'ricerca-alpha-beta-zurich', locale: 'it', jobCount: 3, sampleTerms: ['alpha beta Zurich'], editorialCollision: null },
    { slug: 'search-alpha-beta-zurich', locale: 'en', jobCount: 3, sampleTerms: ['alpha beta Zurich'], editorialCollision: null },
    { slug: 'suche-alpha-beta-zurich', locale: 'de', jobCount: 3, sampleTerms: ['alpha beta Zurich'], editorialCollision: null },
    { slug: 'recherche-alpha-beta-zurich', locale: 'fr', jobCount: 3, sampleTerms: ['alpha beta Zurich'], editorialCollision: null },
    { slug: 'recherche-gamma-lugano', locale: 'fr', jobCount: 1, sampleTerms: ['gamma Lugano'], editorialCollision: null },
  ];

  type Context = NonNullable<ReturnType<typeof buildClusterContext>>;

  function fullContexts(): Context[] {
    const index = new TokenIndex(jobs);
    return candidates
      .map((candidate) => buildClusterContext(candidate, index, jobs))
      .filter((ctx): ctx is Context => ctx !== null);
  }

  function summaryFor(context: Context): RelatedSearchClusterSummaryEntry {
    return {
      key: `${context.candidate.locale}::${context.candidate.slug}`,
      keyword: context.keyword,
      city: context.city,
      matchingJobCount: context.matchingJobCount,
      legacyCantonGroup: context.legacyCantonGroup,
    };
  }

  const stableTrafficFilter: ClusterTrafficFilter = {
    decideMulti() {
      return { action: 'full', reason: 'equivalence-test' } as ReturnType<ClusterTrafficFilter['decideMulti']>;
    },
  };

  const indexedCantonMirrors = new Map<string, string[]>([
    ['fr::recherche-gamma-lugano', ['/fr/trouver-emploi-zurich/recherche-gamma-lugano/']],
  ]);

  it('keeps all-locale metadata and owned HTML byte-identical', () => {
    const full = fullContexts();
    const fullByKey = new Map(full.map((context) => [
      `${context.candidate.locale}::${context.candidate.slug}`,
      context,
    ]));
    const summaries = new Map(full.map((context) => [
      `${context.candidate.locale}::${context.candidate.slug}`,
      summaryFor(context),
    ]));

    for (const owner of ['it', 'en', 'de', 'fr'] as const) {
      const optimized = candidates
        .map((candidate) => {
          if (candidate.locale === owner) return fullByKey.get(`${candidate.locale}::${candidate.slug}`)!;
          const summary = summaries.get(`${candidate.locale}::${candidate.slug}`);
          return summary ? buildClusterContextFromSummary(candidate, summary) : null;
        })
        .filter((ctx): ctx is Context => ctx !== null);

      const signature = (contexts: ReadonlyArray<Context>) => contexts.map((context) => ({
        key: `${context.candidate.locale}::${context.candidate.slug}`,
        keyword: context.keyword,
        city: context.city,
        matchingJobCount: context.matchingJobCount,
        legacyCantonGroup: context.legacyCantonGroup,
        belowFloor: isClusterBelowFloor(context, undefined),
        selfCanonical: hasSelfCanonicalClusterUrl(context, undefined),
      }));
      expect(signature(optimized)).toEqual(signature(full));

      const fullOwned = full.filter((context) => context.candidate.locale === owner);
      const optimizedOwned = optimized.filter((context) => context.candidate.locale === owner);
      const fullDist = makeDist();
      const optimizedDist = makeDist();
      const fullUrlByKey = new Map(full.map((context) => {
        const page = renderClusterPage({
          distDir: fullDist,
          dateStamp: TEST_DATE_STAMP,
          ctx: context,
          enriched: undefined,
          hreflang: [],
          related: [],
        });
        return [`${context.candidate.locale}::${context.candidate.slug}`, `${BASE_URL}${page.urlPath}`];
      }));
      const optimizedUrlByKey = new Map(optimized.map((context) => {
        const page = renderClusterPage({
          distDir: optimizedDist,
          dateStamp: TEST_DATE_STAMP,
          ctx: context,
          enriched: undefined,
          hreflang: [],
          related: [],
        });
        return [`${context.candidate.locale}::${context.candidate.slug}`, `${BASE_URL}${page.urlPath}`];
      }));
      const fullHreflang = full.map((context) => ({
        locale: context.candidate.locale,
        url: fullUrlByKey.get(`${context.candidate.locale}::${context.candidate.slug}`)!,
      }));
      const optimizedHreflang = optimized.map((context) => ({
        locale: context.candidate.locale,
        url: optimizedUrlByKey.get(`${context.candidate.locale}::${context.candidate.slug}`)!,
      }));
      expect(optimizedHreflang).toEqual(fullHreflang);

      const emissionSignature = (contexts: ReadonlyArray<Context>) => contexts.map((context) => {
        const emission = decideClusterEmission({
          ctx: context,
          locale: context.candidate.locale,
          enriched: undefined,
          indexedClusterUrlsByKey: indexedCantonMirrors,
          trafficFilter: stableTrafficFilter,
          // Active and permissive: equivalence must hold for the demand gate's
          // job-count and stop-word branches too, not only while it is dormant.
          demand: { active: true, hasImpressions: () => true },
        });
        return {
          key: `${context.candidate.locale}::${context.candidate.slug}`,
          urlPath: emission.urlPath,
          mirrorPaths: [...emission.mirrorPaths].sort(),
          sitemapEligible: emission.sitemapEligible,
        };
      });
      expect(emissionSignature(optimized)).toEqual(emissionSignature(full));
      const fullPages = fullOwned.map((context) => renderClusterPage({
        distDir: fullDist,
        dateStamp: TEST_DATE_STAMP,
        ctx: context,
        enriched: undefined,
        hreflang: fullHreflang,
        related: [],
      }));
      const optimizedPages = optimizedOwned.map((context) => renderClusterPage({
        distDir: optimizedDist,
        dateStamp: TEST_DATE_STAMP,
        ctx: context,
        enriched: undefined,
        hreflang: optimizedHreflang,
        related: [],
      }));
      expect(optimizedPages.map((page) => page.urlPath)).toEqual(fullPages.map((page) => page.urlPath));
      expect(optimizedPages.map((page) => page.html)).toEqual(fullPages.map((page) => page.html));
    }
  });
});
