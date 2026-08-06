/**
 * A cluster URL that ships `noindex` must never appear in a sitemap — and that
 * must stay true for BOTH producers of `sitemap-search-clusters-*.xml`.
 *
 * The two producers live in `relatedSearchClustersPlugin`'s `closeBundle`:
 *
 *   1. the owning-shard render path, which emits the HTML, and
 *   2. the locale-shard render-skip path (BUILD_LOCALE), which emits nothing
 *      for a locale this shard does not own but still contributes that
 *      locale's `<loc>`s so the it/main shard ships a complete sitemap.
 *
 * Producer 2 cannot be backstopped after the fact: `dropOverwrittenLocs` vets a
 * loc by re-reading its HTML in dist/, and for a non-owned locale there is no
 * HTML on this shard by design — its cross-shard branch keeps those locs
 * unconditionally (pinned in `tests/sitemap-clusters-shard-keep.test.ts`, and
 * that KEEP is correct: removing it truncates the merged sitemap to IT-only).
 * So whatever producer 2 pushes, ships.
 *
 * This has broken twice, the same way both times:
 *
 *   • run 29636707053 (CACHE_VERSION v8) — producer 2 didn't know about the
 *     MIN_JOBS_FOR_INDEXABLE_CLUSTER floor → 31,624 noindex bridges in the
 *     sitemap. Fixed by sharing the `isClusterBelowFloor` leaf predicate.
 *   • run 31077435060 (PR #5187) — the inert band added a SECOND reason to
 *     ship `noindex`, wired into producer 1 only, so producer 2 kept applying
 *     just the v8 floor check → 106,276 noindex URLs in the sitemap,
 *     `validate:content-quality` + `validate:sitemap-pages` blocking, `publish`
 *     skipped from 2026-08-05T23:14Z.
 *
 * Sharing a leaf predicate was not enough, because "is this page noindex" is a
 * growing disjunction and each new term has to be remembered twice. So the
 * COMPOSITION lives in `decideClusterEmission`, and both producers read its
 * derived `sitemapEligible` field.
 *
 * The behavioural block below pins the predicate. The structural block is the
 * one that would have caught #5187: it fails on any tree where a producer
 * decides sitemap membership without going through that field.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  decideClusterEmission,
  hasUsableEnrichedIntro,
  isClusterBelowFloor,
  type ClusterTrafficFilter,
} from '../build-plugins/relatedSearchClustersPlugin';

const PLUGIN_REL = 'build-plugins/relatedSearchClustersPlugin.ts';
const PLUGIN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  PLUGIN_REL,
);

// ── Fixtures ────────────────────────────────────────────────────────────────

const job = (n: string) => ({
  id: n,
  title: `Job ${n}`,
  company: 'Co',
  location: 'Lugano',
  canton: 'TI',
  slug: `job-${n}`,
});

/** Above the floor (3 matching jobs) so `belowFloor` isolates the inert band. */
function makeCtx(over: Record<string, unknown> = {}): any {
  return {
    candidate: {
      slug: 'ricerca-single-source',
      locale: 'it',
      jobCount: 3,
      sampleTerms: ['single source'],
      editorialCollision: null,
    },
    keyword: 'single source',
    city: null,
    matchingJobs: [job('a'), job('b'), job('c')],
    topCompanies: [],
    cantonGroup: '_AGGREGATE_',
    legacyCantonGroup: 'TI',
    ...over,
  };
}

/** Stub filter: records what it was asked, answers what the test dictates. */
function stubFilter(answer: Record<string, unknown>): ClusterTrafficFilter & {
  calls: { paths: readonly string[]; primaryPath?: string }[];
} {
  const calls: { paths: readonly string[]; primaryPath?: string }[] = [];
  return {
    calls,
    decideMulti(urlPaths, _urlClass, opts) {
      calls.push({ paths: urlPaths, primaryPath: opts?.primaryPath });
      return answer as any;
    },
  };
}

const NO_MIRRORS = new Map<string, string[]>();

function decide(
  over: Record<string, unknown>,
  answer: Record<string, unknown>,
  enriched?: unknown,
  locale: 'it' | 'en' | 'de' | 'fr' = 'it',
) {
  return decideClusterEmission({
    ctx: makeCtx(over),
    locale,
    enriched: enriched as any,
    indexedClusterUrlsByKey: NO_MIRRORS,
    trafficFilter: stubFilter(answer),
  });
}

// ── 1. The predicate ────────────────────────────────────────────────────────

describe('decideClusterEmission — sitemap membership derives from noindex', () => {
  it('an inert-band page is noindex and NOT sitemap-eligible', () => {
    const em = decide({}, { action: 'thin', reason: 'p', noindex: true });
    expect(em.inertBand).toBe(true);
    expect(em.noindex).toBe(true);
    expect(em.sitemapEligible).toBe(false);
  });

  it('a below-floor page is noindex and NOT sitemap-eligible', () => {
    const em = decide({ matchingJobs: [] }, { action: 'full', reason: 'has-traffic' });
    expect(em.belowFloor).toBe(true);
    expect(em.noindex).toBe(true);
    expect(em.sitemapEligible).toBe(false);
  });

  it('an indexable page IS sitemap-eligible', () => {
    const em = decide({}, { action: 'thin', reason: 'p' });
    expect(em.noindex).toBe(false);
    expect(em.sitemapEligible).toBe(true);
    expect(em.loc).toBe(
      'https://frontaliereticino.ch/cerca-lavoro-svizzera/ricerca-single-source/',
    );
  });

  it('sitemapEligible is exactly the negation of noindex, for every combination', () => {
    for (const matchingJobs of [[], [job('a'), job('b'), job('c')]]) {
      for (const noindex of [true, false]) {
        const em = decide({ matchingJobs }, { action: 'thin', reason: 'p', noindex });
        expect(em.sitemapEligible).toBe(!em.noindex);
        expect(em.noindex).toBe(em.belowFloor || em.inertBand);
      }
    }
  });

  it('pins the inert-band age gate to the emitted URL, not to a mirror probe', () => {
    const filter = stubFilter({ action: 'thin', reason: 'p' });
    const em = decideClusterEmission({
      ctx: makeCtx(),
      locale: 'de',
      enriched: undefined,
      indexedClusterUrlsByKey: NO_MIRRORS,
      trafficFilter: filter,
    });
    expect(filter.calls).toHaveLength(1);
    expect(filter.calls[0].primaryPath).toBe(em.urlPath);
    // Cross-locale probes are decision-only and must never become emit targets.
    expect(filter.calls[0].paths.some((p) => p.startsWith('/fr/'))).toBe(true);
    expect([...em.mirrorPaths].some((p) => p.startsWith('/fr/'))).toBe(false);
  });

  /**
   * The property the skip path's cheap `<loc>` depends on: a non-owning shard
   * must reach the same verdict the owning shard reaches. Nothing in the inputs
   * is BUILD_LOCALE-dependent, so the same (ctx, locale) must decide the same
   * way no matter which shard is asking.
   */
  it('is deterministic per (ctx, locale) — every shard reaches the same verdict', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const answer = { action: 'thin', reason: 'p', noindex: true };
      const a = decide({}, answer, undefined, locale);
      const b = decide({}, answer, undefined, locale);
      expect(a.loc).toBe(b.loc);
      expect(a.sitemapEligible).toBe(b.sitemapEligible);
      expect(a.sitemapEligible).toBe(false);
    }
  });
});

// ── 2. The enriched-intro exemption (the thin-content offender) ─────────────

describe('hasUsableEnrichedIntro — a prompt echo is not editorial value', () => {
  const PLACEHOLDER = '<80-120 word prose paragraph, single paragraph, no line breaks>';

  it('rejects the literal prompt placeholder shipped by 76 corpus entries', () => {
    expect(hasUsableEnrichedIntro({ intro: PLACEHOLDER } as any)).toBe(false);
  });

  it('rejects a bare ellipsis and blank/absent intros', () => {
    expect(hasUsableEnrichedIntro({ intro: '...' } as any)).toBe(false);
    expect(hasUsableEnrichedIntro({ intro: '   ' } as any)).toBe(false);
    expect(hasUsableEnrichedIntro(undefined)).toBe(false);
  });

  it('accepts real prose, including short prose and prose containing "<"', () => {
    expect(hasUsableEnrichedIntro({ intro: 'Offerte reali a Lugano.' } as any)).toBe(true);
    expect(hasUsableEnrichedIntro({ intro: 'Stipendi < 60k in Ticino.' } as any)).toBe(true);
  });

  /**
   * `/en/find-jobs-switzerland/search-experiences-gossau/` — 31 words, live,
   * self-canonical, in sitemap-search-clusters-001.xml, and the single
   * `thin content (<50 words)` BLOCKING error on run 31077435060. Zero matching
   * jobs; the ONLY thing lifting it over the floor was the echoed template.
   */
  it('stops a prompt echo from buying a zero-job cluster an indexable page', () => {
    const echoed = { slug: 's', locale: 'en', intro: PLACEHOLDER, faqs: [] } as any;
    const ctx = makeCtx({ matchingJobs: [] });
    expect(isClusterBelowFloor(ctx, echoed)).toBe(true);
    const em = decide({ matchingJobs: [] }, { action: 'full', reason: 'has-traffic' }, echoed, 'en');
    expect(em.sitemapEligible).toBe(false);
  });

  it('still exempts a below-floor cluster that has a REAL enriched intro', () => {
    const real = { slug: 's', locale: 'en', intro: 'Una introduzione vera.', faqs: [] } as any;
    expect(isClusterBelowFloor(makeCtx({ matchingJobs: [] }), real)).toBe(false);
  });
});

// ── 3. The structural guard — the one that catches divergence #3 ────────────

describe('every sitemap producer reads the shared predicate', () => {
  /**
   * Walks the plugin's AST and collects each `sitemapLocs.push(...)` together
   * with whether it is control-dependent on a `sitemapEligible` access.
   *
   * "Control-dependent" is deliberately shallow — an enclosing `if` (or `&&`/
   * ternary) whose condition mentions `sitemapEligible`. That is enough to
   * distinguish "the predicate decided this" from "this pushes unconditionally"
   * or "this re-derives its own subset of the rule", which are exactly the two
   * shapes that shipped the v8 and #5187 incidents.
   */
  function collectPushSites(): { line: number; guarded: boolean; hubLoop: boolean }[] {
    const source = fs.readFileSync(PLUGIN_PATH, 'utf-8');
    const sf = ts.createSourceFile(PLUGIN_PATH, source, ts.ScriptTarget.Latest, true);
    const sites: { line: number; guarded: boolean; hubLoop: boolean }[] = [];

    const mentionsEligible = (n: ts.Node) => /\bsitemapEligible\b/.test(n.getText(sf));

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'push' &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'sitemapLocs'
      ) {
        let guarded = false;
        let hubLoop = false;
        let sawNearestLoop = false;
        for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
          if (ts.isIfStatement(p) && mentionsEligible(p.expression)) guarded = true;
          if (ts.isConditionalExpression(p) && mentionsEligible(p.condition)) guarded = true;
          if (ts.isBinaryExpression(p) && mentionsEligible(p.left)) guarded = true;
          // Hub pages are a different family: they are the consolidation target
          // the below-floor bridges canonicalize TO, so they are indexable by
          // construction and never carry a traffic-evidence decision.
          //
          // Only the NEAREST enclosing loop is inspected. Testing every
          // ancestor instead would match `closeBundle`'s own body — which of
          // course contains the hub loop — and silently exempt BOTH cluster
          // producers, turning the assertion below into a vacuous pass.
          if (!sawNearestLoop && (ts.isForStatement(p) || ts.isForOfStatement(p))) {
            sawNearestLoop = true;
            hubLoop = /\brenderHubPage\s*\(/.test(p.getText(sf));
          }
        }
        sites.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          guarded,
          hubLoop,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return sites;
  }

  it('finds both cluster producers plus the hub loop', () => {
    const sites = collectPushSites();
    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(sites.filter((s) => s.hubLoop)).toHaveLength(1);
  });

  it('no cluster loc enters a sitemap without passing sitemapEligible', () => {
    const unguarded = collectPushSites().filter((s) => !s.hubLoop && !s.guarded);
    expect(
      unguarded.map((s) => `${PLUGIN_REL}:${s.line}`),
      'A sitemapLocs.push() that is not control-dependent on ' +
        'decideClusterEmission().sitemapEligible. This is how run 29636707053 ' +
        '(31,624 URLs) and run 31077435060 (106,276 URLs) shipped noindex pages ' +
        'in sitemap-search-clusters-*.xml. Route the decision through ' +
        'decideClusterEmission instead of re-deriving it here.',
    ).toEqual([]);
  });

  it('the skip path does not re-derive indexability from a leaf predicate', () => {
    // v8 fixed the skip path by calling `isClusterBelowFloor` there directly.
    // That is precisely the shape that could not absorb #5187's second reason,
    // so the composed decision must now be the only caller inside closeBundle.
    const source = fs.readFileSync(PLUGIN_PATH, 'utf-8');
    const closeBundle = source.slice(source.indexOf('async closeBundle'));
    expect(closeBundle).not.toMatch(/\bisClusterBelowFloor\s*\(/);
    expect(closeBundle).toMatch(/\bdecideClusterEmission\s*\(/);
  });
});
