/**
 * Regression pin for issue #5114 — «nessun alternate hreflang punta a un
 * target non emesso».
 *
 * What broke
 * ----------
 * `audit:hreflang` failed `validate-dist-postbuild` with 22 `missingTarget`
 * offenders: IT search landings under `cerca-lavoro-ticino/ricerca-*` that
 * declared de/en/fr alternates whose HTML was never written. The tell was in
 * the URLs themselves — `/de/jobs-im-tessin/suche-addetto-alle-pulizie-ticino/`
 * keeps the Italian query verbatim, so the DE URL was produced by swapping the
 * locale prefix onto the IT slug, not by a real DE page.
 *
 * `jobsSeoPagesPlugin`'s three search-landing emitters templated the block
 * from the FULL locale list, unconditionally, while the decision to emit a
 * locale's page ran later and per-locale (a ≥3 matching-jobs floor evaluated
 * against that locale's own translations, #4715). `localeList` is walked
 * IT-first, so the IT page — carrying all four alternates — was already on
 * disk by the time DE was found ineligible.
 *
 * Why the existing safety nets did not catch it: `filterExistingAlternates`
 * (build-plugins/shared/hreflangGuard.ts) and the plan repair in
 * packages/articles/engine/hreflangPostprocess.ts are both deliberately blind
 * on a `BUILD_LOCALE` shard, where a sibling locale's absence is by design.
 * The audit runs on the REHYDRATED dist, where the absence is real.
 *
 * What this file pins
 * -------------------
 * 1. The shared builder's all-or-nothing contract.
 * 2. That the emitters cannot regress to hand-rolled, locale-list-driven
 *    blocks — a source guard that FAILS against the pre-fix file.
 *
 * `tests/hreflang-no-broken.test.ts` checks the same invariant against a real
 * dist/, but skips when dist/ is absent — which is every local run and every
 * CI job that is not a full build. This file needs no dist.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ALTERNATE_LOCALES,
  buildLocaleAlternateBlock,
  buildLocaleAlternateBlockForUnclaimedCluster,
  buildExpiredSitemapClusterEntries,
  buildSitemapAlternateBlock,
  hasUnclaimedLocaleCluster,
  localePathClaimKey,
  resolveLocaleClusterClaim,
} from '../build-plugins/shared/localeAlternateBlock';

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://frontaliereticino.ch';

/** The exact URL shapes from the issue, per locale. */
const HREF: Record<string, string> = {
  it: `${BASE}/cerca-lavoro-ticino/ricerca-addetto-alle-pulizie-ticino/`,
  en: `${BASE}/en/find-jobs-ticino/search-addetto-alle-pulizie-ticino/`,
  de: `${BASE}/de/jobs-im-tessin/suche-addetto-alle-pulizie-ticino/`,
  fr: `${BASE}/fr/trouver-emploi-tessin/recherche-addetto-alle-pulizie-ticino/`,
};

const hrefFor = (locale: string) => HREF[locale];

/** Every `hreflang="x"` → `href` pair in a rendered block. */
function parseBlock(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const rx = /hreflang="([^"]+)"\s+href="([^"]+)"/g;
  for (const m of html.matchAll(rx)) out.set(m[1], m[2]);
  return out;
}

describe('search-landing hreflang: alternates never outrun emitted pages (#5114)', () => {
  it('emits nothing when a locale misses the floor — the exact #5114 case', () => {
    // IT cleared the ≥3-jobs floor; de/en/fr did not. Pre-fix this produced
    // 4 links + x-default, three of which 404'd.
    const block = buildLocaleAlternateBlock({
      eligibleLocales: ['it'],
      hrefFor,
    });
    expect(block).toBe('');
  });

  it.each([
    [['it', 'en', 'de']],
    [['it', 'en']],
    [['it', 'fr']],
    [[]],
  ])('emits nothing for any incomplete set: %j', (eligible) => {
    expect(buildLocaleAlternateBlock({ eligibleLocales: eligible, hrefFor })).toBe('');
  });

  it('never advertises a locale outside the eligible set', () => {
    // Property: whatever the set, every advertised href belongs to a locale
    // the build declared eligible. This is the invariant the audit checks.
    const subsets: string[][] = [
      ['it'],
      ['it', 'en'],
      ['it', 'en', 'de'],
      ['it', 'en', 'de', 'fr'],
      ['en', 'de', 'fr'],
    ];
    for (const eligible of subsets) {
      const parsed = parseBlock(buildLocaleAlternateBlock({ eligibleLocales: eligible, hrefFor }));
      for (const [lang, href] of parsed) {
        if (lang === 'x-default') continue;
        expect(eligible, `advertised ${lang} but it was not eligible`).toContain(lang);
        expect(href).toBe(HREF[lang]);
      }
    }
  });

  it('emits the full 5-entry block when all four locales are eligible', () => {
    const parsed = parseBlock(
      buildLocaleAlternateBlock({ eligibleLocales: ALTERNATE_LOCALES, hrefFor }),
    );
    // audit-hreflang fails any page with <5 entries as [tooFew].
    expect(parsed.size).toBe(5);
    for (const locale of ALTERNATE_LOCALES) expect(parsed.get(locale)).toBe(HREF[locale]);
    // audit-hreflang [xDefaultMismatch]: x-default must equal the IT href.
    expect(parsed.get('x-default')).toBe(HREF.it);
  });

  it('sitemap alternates filter to the eligible set instead of voiding', () => {
    // Sitemaps have no [tooFew] rule; reciprocity only requires each
    // advertised alternate to be a published <loc>.
    const xml = buildSitemapAlternateBlock({ eligibleLocales: ['it', 'en'], hrefFor });
    expect(xml).toContain(`hreflang="it"`);
    expect(xml).toContain(`hreflang="en"`);
    expect(xml).not.toContain(`hreflang="de"`);
    expect(xml).not.toContain(`hreflang="fr"`);
  });
});

describe('expired soft-landing cluster claims stay shard-invariant', () => {
  const paths = {
    it: '/cerca-lavoro-appenzello/job-it/',
    en: '/en/find-jobs-appenzell/job-en/',
    de: '/de/jobs-in-appenzell/job-de/',
    fr: '/fr/trouver-emploi-appenzell/job-fr/',
  } as const;

  it('accepts a complete cluster when none of its paths is claimed', () => {
    expect(hasUnclaimedLocaleCluster(paths, new Set())).toBe(true);
  });

  it('voids the whole cluster when one locale path already belongs to an earlier slug', () => {
    const claimed = new Set([localePathClaimKey(paths.en)]);
    expect(hasUnclaimedLocaleCluster(paths, claimed)).toBe(false);
  });

  it('emits no hreflang block when a localized path belongs to an active job', () => {
    const claimedByActiveJob = new Set([localePathClaimKey(paths.de)]);
    const block = buildLocaleAlternateBlockForUnclaimedCluster(paths, claimedByActiveJob, {
      hrefFor: (locale) => `${BASE}${paths[locale]}`,
    });
    expect(block).toBe('');
  });

  it('preserves an empty indent byte-for-byte in the guarded wrapper', () => {
    const block = buildLocaleAlternateBlockForUnclaimedCluster(paths, new Set(), {
      indent: '',
      hrefFor: (locale) => `${BASE}${paths[locale]}`,
    });
    expect(block.split('\n').every((line) => line.startsWith('<link '))).toBe(true);
  });

  it('reuses claimedPaths without mutating it or changing the second result', () => {
    const claimedPaths = new Set([localePathClaimKey('/unrelated/path/')]);
    const before = [...claimedPaths];
    const first = buildLocaleAlternateBlockForUnclaimedCluster(paths, claimedPaths, {
      hrefFor: (locale) => `${BASE}${paths[locale]}`,
    });
    const second = buildLocaleAlternateBlockForUnclaimedCluster(paths, claimedPaths, {
      hrefFor: (locale) => `${BASE}${paths[locale]}`,
    });
    expect(second).toBe(first);
    expect([...claimedPaths]).toEqual(before);
  });

  it('keeps the wrapper newline and default-indent contract', () => {
    const block = buildLocaleAlternateBlockForUnclaimedCluster(paths, new Set(), {
      hrefFor: (locale) => `${BASE}${paths[locale]}`,
    });
    expect(block).toBe([
      ...ALTERNATE_LOCALES.map(
        (locale) => ` <link rel="alternate" hreflang="${locale}" href="${BASE}${paths[locale]}">`,
      ),
      ` <link rel="alternate" hreflang="x-default" href="${BASE}${paths.it}">`,
    ].join('\n'));
  });

  it('normalises URL-shaped and registry-shaped path keys identically', () => {
    const claimed = new Set(['en/find-jobs-appenzell/job-en']);
    expect(hasUnclaimedLocaleCluster({ ...paths, en: '//en/find-jobs-appenzell/job-en///' }, claimed)).toBe(false);
  });

  it('rejects duplicate normalized locale paths before claiming the cluster', () => {
    expect(
      hasUnclaimedLocaleCluster(
        { it: '/it/x/', en: '/it/x/', de: '/de/x/', fr: '/fr/x/' },
        new Set(),
      ),
    ).toBe(false);
  });
});

describe('search-landing emitters route every hreflang block through the shared builder', () => {
  // Source guard. Pre-fix, the search-landing emit sites in
  // jobsSeoPagesPlugin carried their own `localeList.map(...)` +
  // `<link rel="alternate" ...>` template; the active-job emitter had the
  // same unsafe shape even though its missing-locale condition came from
  // slug deduplication. These assertions fail on the pre-fix file (only
  // three calls, and the active-job set taken straight from `localeList`).
  //
  // Scoped to `buildLocaleAlternateBlock` call sites on purpose: this file
  // holds ~38 hreflang <link> literals belonging to OTHER page families
  // (city hubs, sector hubs, …) whose four locales are always emitted. Only
  // the search-landing family has a per-locale floor, so only it can promise
  // a page it never writes.
  // Every emitter whose page family has a PER-LOCALE emission floor — the
  // only shape that can promise a sibling it never writes.
  //
  // The search landings (#5114) were the reported instance; the rest are the
  // same template, surfaced by `scripts/ci/check-sibling-patterns.mjs` and
  // fixed in the same PR per AGENTS.md #6. Each pairs a
  // `wordCount < MIN_INDEXABLE_WORDS` per-locale `continue` with what used to
  // be a full-locale-list hreflang block.
  //
  // NOT in this list, deliberately: `frontalierePillarPlugin.ts` shares the
  // construct but emits a thin locale as `noindex,follow` instead of skipping
  // it, so all four pages always exist and no alternate can dangle.
  const EMITTERS = [
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/relatedSearchClustersPlugin.ts',
    'build-plugins/faqHubPlugin.ts',
    'build-plugins/careerLandingsPlugin.ts',
    'build-plugins/comparisonsHubPlugin.ts',
    'build-plugins/costOfLivingLandingsPlugin.ts',
    'build-plugins/holidaysLandingsPlugin.ts',
    'build-plugins/minimumWageLandingsPlugin.ts',
    'build-plugins/nursingLandingsPlugin.ts',
    'build-plugins/professionLandingsPlugin.ts',
    'build-plugins/bfsSalaryLandingsPlugin.ts',
  ];

  /** Emitters that gate on a per-locale word-count floor (all but the first two). */
  const FLOOR_EMITTERS = EMITTERS.slice(2);

  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

  /** Text of each `buildLocaleAlternateBlock({ ... })` call, brace-matched. */
  function callSites(src: string): string[] {
    const out: string[] = [];
    const marker = 'buildLocaleAlternateBlock({';
    let from = 0;
    for (;;) {
      const start = src.indexOf(marker, from);
      if (start === -1) break;
      let depth = 0;
      let i = start + marker.length - 1;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
      }
      out.push(src.slice(start, i + 1));
      from = i + 1;
    }
    return out;
  }

  it.each(EMITTERS)('%s imports the shared builder', (rel) => {
    expect(read(rel)).toMatch(/from '\.\/shared\/localeAlternateBlock'/);
  });

  it('jobsSeoPagesPlugin derives the alternate set from eligibility, not the locale list', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    const calls = callSites(src);
    // Five sites are floor/dedup-gated: GSC keyword landings + search-stats
    // leaders + combo landings + active job detail pages + expired job
    // clusters. The canton hub is the one full-locale site in this file: its
    // four locale pages are always emitted, so its localeList eligibility is
    // safe by construction.
    expect(calls.length, 'expected every hreflang emit site').toBe(6);
    const gatedCalls = calls.filter((call) => !/eligibleLocales:\s*localeList/.test(call));
    expect(gatedCalls.length, 'expected every floor/dedup-gated hreflang site').toBe(5);
    const alwaysCompleteCalls = calls.filter((call) => /eligibleLocales:\s*localeList/.test(call));
    expect(alwaysCompleteCalls.length, 'expected only the always-emitted canton hub to use localeList').toBe(1);
    expect(alwaysCompleteCalls[0]).toMatch(/buildCantonAwareSection/);
    for (const call of gatedCalls) {
      expect(call).toMatch(/eligibleLocales:/);
      // The regression: the alternate set taken straight from the locale
      // list, decoupled from whether that locale's page is written.
      expect(
        call,
        'eligibleLocales must be a derived set, never the unconditional locale list (#5114)',
      ).not.toMatch(/eligibleLocales:\s*localeList/);
      expect(call).toMatch(/hrefFor:/);
    }
  });

  it('active job detail pages derive eligibility from the dedup winner set', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    expect(src).toContain('const activeJobEligibleLocales = new Set(');
    expect(src).toContain('emittedActiveJobPaths.has(`${jobCanton}:${candidateLocale}:${perLocaleSlug[candidateLocale]}`)');
    expect(src).toContain('eligibleLocales: activeJobEligibleLocales');
  });

  it('expired job alternates share the active localized-path claim set', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    expect(src).toContain('const claimedJobPaths = new Set<string>();');
    expect(src).toContain('claimedJobPaths.add(localePathClaimKey(relPath));');
    expect(src).toContain('const expiredClusterClaim = resolveLocaleClusterClaim(paths, claimedJobPaths);');
    expect(src).toContain('expiredClusterClaim.hasUnclaimedCluster');
    expect(src).toContain('expiredClusterClaim.unclaimedLocales.has(l)');
    expect(src).toContain('emitAlternates: expiredClusterHasHreflang');
  });

  it('expired sitemap omits an active collision and all alternates for that cluster', () => {
    const paths = {
      it: '/cerca-lavoro-ticino/expired-acceptance-it/',
      en: '/en/find-jobs-ticino/active-collision-en/',
      de: '/de/jobs-im-tessin/expired-acceptance-de/',
      fr: '/fr/trouver-emploi-tessin/expired-acceptance-fr/',
    } as const;
    const claimedByActiveJob = new Set([localePathClaimKey(paths.en)]);
    const claim = resolveLocaleClusterClaim(paths, claimedByActiveJob);
    const entries = buildExpiredSitemapClusterEntries(paths, claim, {
      eligibleLocales: ALTERNATE_LOCALES,
      emitAlternates: claim.hasUnclaimedCluster,
      hrefFor: (locale) => `${BASE}${paths[locale]}`,
      locFor: (locale) => `${BASE}${paths[locale]}`,
      lastmod: '2026-10-18',
    });
    const sitemap = `<urlset>${entries.join('\n')}</urlset>`;

    expect(sitemap).not.toContain(`<loc>${BASE}${paths.en}</loc>`);
    expect(sitemap).not.toContain(`href="${BASE}${paths.en}"`);
    expect(sitemap).not.toContain('<xhtml:link');
    for (const locale of ['it', 'de', 'fr'] as const) {
      expect(sitemap).toContain(`<loc>${BASE}${paths[locale]}</loc>`);
    }
  });

  it('keeps reciprocal alternates for a complete unclaimed expired cluster', () => {
    const paths = {
      it: '/cerca-lavoro-appenzello/job-it/',
      en: '/en/find-jobs-appenzell/job-en/',
      de: '/de/jobs-in-appenzell/job-de/',
      fr: '/fr/trouver-emploi-appenzell/job-fr/',
    } as const;
    const claim = resolveLocaleClusterClaim(paths, new Set());
    const [entry] = buildExpiredSitemapClusterEntries(paths, claim, {
      eligibleLocales: ALTERNATE_LOCALES,
      emitAlternates: claim.hasUnclaimedCluster,
      hrefFor: (locale) => `${BASE}${paths[locale]}`,
      locFor: (locale) => `${BASE}${paths[locale]}`,
      lastmod: '2026-10-18',
    });

    expect(entry).toContain(`\n <xhtml:link rel="alternate" hreflang="it" href="${BASE}${paths.it}" />\n`);
    expect(entry).toContain(`\n <xhtml:link rel="alternate" hreflang="x-default" href="${BASE}${paths.it}" />\n`);
  });

  it.each(FLOOR_EMITTERS)('%s settles its eligible set before rendering for real', (rel) => {
    const src = read(rel);
    // Two-pass render: the MIN_INDEXABLE_WORDS floor is a per-locale skip, so
    // the set has to be settled before any page is written for real.
    expect(src, 'expected a pass-1 eligibility set').toMatch(
      /const eligibleLocales = new Set<string>\(/,
    );
    // …and the floor that drives the skip must be the one feeding that set.
    expect(src).toMatch(/MIN_INDEXABLE_WORDS/);
    // The render must actually receive it, otherwise pass 2 renders the
    // default (empty) set and every page silently loses its hreflang.
    expect(src, 'pass 2 must pass eligibleLocales into the render').toMatch(
      /eligibleLocales[,\s}]/,
    );
  });

  it.each(FLOOR_EMITTERS)('%s no longer hand-rolls the alternate block', (rel) => {
    const src = read(rel);
    // The pre-fix construct, shared verbatim across this whole template
    // family. Its absence is what the sibling-pattern gate was pointing at.
    expect(
      src,
      'build the block with buildLocaleAlternateBlock, not by joining hreflangLines (#5114)',
    ).not.toMatch(/const alternates = hreflangLines\.join\('\\n'\)/);
  });

  it('the keyword-landing floor drives both emission and the alternate set', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    // One named floor, consumed by the eligibility set that gates the
    // `continue` AND feeds the hreflang block. A bare `< 3` reintroduces the
    // split-brain the issue was about.
    expect(src).toMatch(/const KEYWORD_LANDING_MIN_JOBS = 3;/);
    expect(src).toMatch(/kwEligibleLocales/);
    expect(
      src,
      'the emit loop must consult the same eligibility set the alternates use',
    ).toMatch(/if \(!kwEligibleLocales\.has\(locale\)\) continue;/);
  });
});
