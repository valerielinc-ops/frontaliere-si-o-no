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
  buildSitemapAlternateBlock,
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

describe('search-landing emitters route every hreflang block through the shared builder', () => {
  // Source guard. Pre-fix, the three search-landing emit sites in
  // jobsSeoPagesPlugin each carried their own `localeList.map(...)` +
  // `<link rel="alternate" ...>` template — that is what made the defect
  // expressible, and three literal copies are exactly the drift AGENTS.md #6
  // forbids. These assertions FAIL on the pre-fix file (0 calls, and the
  // alternate set taken straight from `localeList`).
  //
  // Scoped to `buildLocaleAlternateBlock` call sites on purpose: this file
  // holds ~38 hreflang <link> literals belonging to OTHER page families
  // (city hubs, sector hubs, …) whose four locales are always emitted. Only
  // the search-landing family has a per-locale floor, so only it can promise
  // a page it never writes.
  const EMITTERS = [
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/relatedSearchClustersPlugin.ts',
  ];

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
    // GSC keyword landings + search-stats leaders + combo landings.
    expect(calls.length, 'expected all three search-landing emit sites').toBe(3);
    for (const call of calls) {
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
