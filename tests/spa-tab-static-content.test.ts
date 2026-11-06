/**
 * The SPA-tab static pages (support, community, gamification, profile,
 * newsletter confirmation, consulting) carry their own copy in EN/DE/FR, and
 * the family stops being one body repeated N times.
 *
 * audit:information-gain, full corpus 2026-10-24: cohort `fr:/fr/~83248f`
 * (14 pages, median 0 %, floor 5 %) and its DE twin `de:/de/~5b78c1`
 * (17 pages, median 0 %). Two causes: the 21 EN/DE/FR section pages
 * overwritten by the generic fallback (tests/static-pages-section-locale-
 * ownership.test.ts) and, for the SPA tabs that remain, a body made of the
 * homepage editorial (the '/' SECTION_EDITORIAL key, matched as a PREFIX of
 * every path) padded with LOCALE_EDITORIAL — twelve segments identical on all
 * of them.
 *
 * `buildPage()` in staticPagesPlugin.ts is not callable on its own, so — as in
 * tests/information-gain-remainder-families.test.ts — the page is composed
 * from the same ingredients buildPage() puts in the body (title, h1, lede,
 * editorial blocks) and scored with the gate's own engine. The family is
 * scored as ONE cohort (every page compared with all its siblings), which is
 * stricter than the gate, whose masked-h1 cohorts can only be subsets of it.
 *
 * Two rules, as in the model test: with the new copy the family median sits
 * above a pinned threshold (measured minus one point) with no zero-gain page;
 * the pre-fix composition stays below the 5 % floor. Empty the copy and the
 * first rule goes red.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fingerprintPage, scoreCohorts } from '@/scripts/lib/informationGain.mjs';
import { LOCALE_EDITORIAL, SECTION_EDITORIAL, findSectionEditorialKey } from '@/build-plugins/editorialContent';
import {
  SPA_TAB_LINKED_PATHS,
  renderSpaTabEditorial,
  resolveSpaTabStaticPage,
  spaTabLocaleSeo,
  type SpaTabForeignLocale,
  type SpaTabStaticId,
} from '@/build-plugins/shared/spaTabStaticContent';
import { buildTitleWithBrand } from '@/build-plugins/shared/titleSuffix';

type Locale = 'it' | 'en' | 'de' | 'fr';
const FOREIGN: readonly SpaTabForeignLocale[] = ['en', 'de', 'fr'];
const FLOOR = 5;

/** IT source path and the locale variant the hreflang loop emits (public/sitemap-pages.xml). */
const TABS: Record<SpaTabStaticId, Record<Locale, string>> = {
  feedback: { it: '/supporto/', en: '/en/support/', de: '/de/hilfe/', fr: '/fr/assistance/' },
  forum: { it: '/community/', en: '/en/community/', de: '/de/gemeinschaft/', fr: '/fr/communaute/' },
  gamification: { it: '/gamificazione/', en: '/en/gamification/', de: '/de/gamification/', fr: '/fr/gamification/' },
  dashboard: { it: '/profilo/', en: '/en/profile/', de: '/de/profil/', fr: '/fr/profil/' },
  emailConfirmed: { it: '/benvenuto-frontaliere/', en: '/en/welcome/', de: '/de/willkommen/', fr: '/fr/bienvenue/' },
  consulting: { it: '/consulenza/', en: '/en/consulting/', de: '/de/beratung/', fr: '/fr/consultation/' },
};
const TAB_IDS = Object.keys(TABS) as SpaTabStaticId[];
const PRE_FIX_SUFFIX: Record<SpaTabForeignLocale, string> = { en: 'cross-border guide', de: 'Grenzgänger-Leitfaden', fr: 'guide frontalier' };

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Same raw-vs-escaped rule as the `editorialHtml` mapper in staticPagesPlugin.ts. */
const editorialBlock = (b: string) =>
  /^<(h[1-6]|p|nav|div|details|section|ul|ol|table|figure|aside|blockquote)\b/.test(b)
    ? b
    : /<[a-zA-Z][^>]*>/.test(b)
      ? `<p>${b}</p>`
      : `<p>${escHtml(b)}</p>`;
const composeSsgPage = (p: { title: string; h1: string; lede: string; blocks: string[] }) =>
  `<!doctype html><html><head><title>${escHtml(p.title)}</title></head><body><main><article>` +
  `<h1>${escHtml(p.h1)}</h1><p>${escHtml(p.lede)}</p><div>${p.blocks.map(editorialBlock).join('')}</div>` +
  `</article></main></body></html>`;

/** staticPagesPlugin pads a short SECTION_EDITORIAL entry to 7 blocks with LOCALE_EDITORIAL. */
const padded = (blocks: string[], locale: SpaTabForeignLocale) => {
  const out = [...blocks];
  for (const para of LOCALE_EDITORIAL[locale]) {
    if (out.length >= 7) break;
    out.push(para);
  }
  return out;
};

/** The body each page gets now. */
const afterBlocks = (id: SpaTabStaticId, locale: SpaTabForeignLocale): string[] => {
  const own = renderSpaTabEditorial(id, locale);
  if (own) return own;
  const key = findSectionEditorialKey(TABS[id].it.replace(/\/$/, ''));
  return padded(SECTION_EDITORIAL[key!][locale], locale);
};

const renderFamily = (locale: SpaTabForeignLocale, fixed: boolean) =>
  TAB_IDS.map((id) => {
    const urlPath = TABS[id][locale];
    let html: string;
    if (fixed) {
      const seo = spaTabLocaleSeo(id, locale);
      html = composeSsgPage({ title: buildTitleWithBrand(seo.title), h1: seo.h1, lede: seo.desc, blocks: afterBlocks(id, locale) });
    } else {
      // Pre-fix: slug title, «(guide frontalier)» h1, homepage editorial via the
      // '/' prefix (consulting kept its own key) padded with LOCALE_EDITORIAL.
      const label = urlPath.split('/').filter(Boolean).pop()!.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const sectionKey = id === 'consulting' ? '/consulenza' : '/';
      html = composeSsgPage({
        title: `${label} | Frontaliere Ticino`,
        h1: `${label} (${PRE_FIX_SUFFIX[locale]})`,
        lede: `${label} — Frontaliere Ticino`,
        blocks: padded(SECTION_EDITORIAL[sectionKey][locale], locale),
      });
    }
    return fingerprintPage(`${urlPath.replace(/^\//, '')}index.html`, html);
  });

/** The family as ONE cohort: every page against all its siblings. */
const scoreFamily = (locale: SpaTabForeignLocale, fixed: boolean) => {
  const fps = renderFamily(locale, fixed).map((fp) => ({ ...fp, skeletonHash: 'spa-tab-family' }));
  const [cohort] = scoreCohorts(fps as never, { minCohortPages: 2, includePageScores: true }).cohorts;
  return cohort;
};

describe('SPA-tab static family: information gain (EN/DE/FR)', () => {
  // Measured 2026-10-24 on this composition: median 100 % (en), 100 % (de),
  // 92,3 % (fr — the anchor «calculateur de salaire net» is long enough to be a
  // segment and four FR pages link it); lowest page 90,9 % (fr). Pre-fix: 0 %
  // median in all three. Thresholds = the lowest measured value minus ~1 point.
  const MIN_MEDIAN = 91;
  const MIN_PAGE = 89;

  for (const locale of FOREIGN) {
    it(`${locale}: family median ≥ ${MIN_MEDIAN} %, every page ≥ ${MIN_PAGE} %`, () => {
      const cohort = scoreFamily(locale, true);
      expect(cohort.pages).toBe(TAB_IDS.length);
      expect(cohort.medianIgs).toBeGreaterThanOrEqual(MIN_MEDIAN);
      const low = cohort.pageScores.filter((p: { igs: number }) => p.igs < MIN_PAGE)
        .map((p: { urlPath: string; igs: number }) => `${p.urlPath}: ${p.igs.toFixed(1)} %`);
      expect(low).toEqual([]);
    });
  }

  it('the pre-fix composition is below the floor (the new copy is the cause)', () => {
    for (const locale of FOREIGN) {
      expect(scoreFamily(locale, false).medianIgs, locale).toBeLessThan(FLOOR);
    }
  });
});

describe('SPA-tab static copy', () => {
  const sitemap = readFileSync('public/sitemap-pages.xml', 'utf-8');
  const words = (blocks: string[]) => blocks.join(' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

  it('resolves the tab from the Italian source path in any slash form, and nothing else', () => {
    for (const id of TAB_IDS) {
      expect(resolveSpaTabStaticPage(TABS[id].it), id).toBe(id);
      expect(resolveSpaTabStaticPage(TABS[id].it.replace(/\/$/, '')), id).toBe(id);
    }
    for (const p of ['/', '/supporto/extra', '/fisco', '/en/support/']) expect(resolveSpaTabStaticPage(p), p).toBeNull();
  });

  it('every tab except consulting has page-specific editorial in all four locales, ≥ 80 words', () => {
    for (const id of TAB_IDS.filter((t) => t !== 'consulting')) {
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        const blocks = renderSpaTabEditorial(id, locale);
        expect(blocks, `${id}/${locale}`).not.toBeNull();
        // AGENTS.md #4 floor is 50 words; the shortest (newsletter confirmation, de) measures 87.
        expect(words(blocks!), `${id}/${locale}`).toBeGreaterThanOrEqual(80);
      }
    }
    expect(renderSpaTabEditorial('consulting', 'fr')).toBeNull();
  });

  it('no paragraph is shared between two tabs', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const seen = new Map<string, string>();
      for (const id of TAB_IDS) {
        for (const block of renderSpaTabEditorial(id, locale) ?? []) {
          if (/^<h2/.test(block)) continue;
          expect(seen.get(block), `${locale}: «${block.slice(0, 50)}…» in ${seen.get(block)} and ${id}`).toBeUndefined();
          seen.set(block, id);
        }
      }
    }
  });

  it('EN/DE/FR titles, H1s and descriptions are unique, translated and free of the fallback suffix', () => {
    for (const locale of FOREIGN) {
      const seos = TAB_IDS.map((id) => spaTabLocaleSeo(id, locale));
      expect(new Set(seos.map((s) => s.title)).size).toBe(TAB_IDS.length);
      expect(new Set(seos.map((s) => s.h1)).size).toBe(TAB_IDS.length);
      expect(new Set(seos.map((s) => s.desc)).size).toBe(TAB_IDS.length);
      for (const s of seos) {
        expect(s.h1).not.toMatch(/\((cross-border guide|Grenzgänger-Leitfaden|guide frontalier)\)/);
        expect(s.h1.toLowerCase()).not.toBe(s.title.toLowerCase());
        expect(s.desc.length, s.desc).toBeGreaterThanOrEqual(70);
        expect(s.desc.length, s.desc).toBeLessThanOrEqual(160);
      }
    }
  });

  it('every linked path is a seeded sitemap URL, with a trailing slash', () => {
    for (const p of SPA_TAB_LINKED_PATHS) {
      expect(p.endsWith('/'), p).toBe(true);
      expect(sitemap.includes(`href="https://frontaliereticino.ch${p}"`) || sitemap.includes(`<loc>https://frontaliereticino.ch${p}</loc>`), p).toBe(true);
    }
  });
});

describe('homepage editorial key', () => {
  it("'/' matches the homepage only, never as a prefix", () => {
    expect(findSectionEditorialKey('/')).toBe('/');
    for (const p of ['/supporto', '/community', '/gamificazione', '/profilo', '/benvenuto-frontaliere', '/cerca-lavoro-ticino-x']) {
      expect(findSectionEditorialKey(p), p).not.toBe('/');
    }
  });

  it('longest-prefix matching is unchanged for the other keys', () => {
    expect(findSectionEditorialKey('/calcola-stipendio/simula-busta-paga/')).toBe('/calcola-stipendio/simula-busta-paga');
    expect(findSectionEditorialKey('/calcola-stipendio/altro')).toBe('/calcola-stipendio/');
    expect(findSectionEditorialKey('/consulenza')).toBe('/consulenza');
  });

  it('a section index (no trailing slash) gets its section copy in EN/DE/FR, Italian unchanged', () => {
    for (const [path, key] of [
      ['/statistiche', '/statistiche/'],
      ['/guida-frontaliere', '/guida-frontaliere/'],
      ['/calcola-stipendio', '/calcola-stipendio/'],
      ['/vivere-in-ticino', '/vivere-in-ticino/'],
    ] as const) {
      for (const locale of FOREIGN) expect(findSectionEditorialKey(path, locale), `${path}/${locale}`).toBe(key);
      expect(findSectionEditorialKey(path, 'it'), path).toBeUndefined();
      expect(findSectionEditorialKey(path), path).toBeUndefined();
    }
    // Pages with no key at all fall to the generic locale fallback, not the homepage.
    expect(findSectionEditorialKey('/digest-settimanale', 'fr')).toBeUndefined();
  });
});
