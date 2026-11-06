/**
 * The 28 topic section pages (/fisco/, /dogana/, … × 4 locales) have ONE HTML
 * owner: sectionPagesPlugin.
 *
 * Until 2026-10-24 staticPagesPlugin's hreflang-variant loop regenerated
 * every EN/DE/FR variant of every sitemap URL it met, skipping only the
 * ogPages articles and the FAQ hubs. The section pages are in the seeded
 * sitemap with their hreflang alternates, so the loop rewrote the 21 EN/DE/FR
 * section pages AFTER sectionPagesPlugin had written them, through its
 * WriteCollector: /fr/douane/ lost «Douane et règles de frontière pour
 * frontaliers», its lede and its article list, and shipped «Douane (guide
 * frontalier)» + the homepage editorial — the identical body that sank the
 * information-gain cohorts fr:/fr/~83248f and de:/de/~5b78c1 to a 0 % median.
 * The Italian path survived only thanks to a `fs.existsSync` probe.
 *
 * Observers here:
 *  1. the ownership predicate covers exactly the 28 paths, in every slash
 *     form, and lets go of them when the section plugin is switched off;
 *  2. every EN/DE/FR alternate the seeded sitemap pairs with an Italian
 *     section path is one the predicate owns — i.e. the skip fires on the
 *     very paths the hreflang loop meets;
 *  3. the hreflang loop consults the predicate (and keeps the #5110 ledger
 *     entry) before it can reach its write, and the Italian branch no longer
 *     depends on the file being on disk;
 *  4. the pages sectionPagesPlugin renders carry a unique H1 per locale, never
 *     the «(guide frontalier)» fallback differentiator;
 *  5. a second writer of a claimed section path is a collision on the shared
 *     write registry (fatal under WRITE_COLLISION_MODE=throw).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SECTION_IDS,
  SECTION_PAGE_LOCALES,
  SECTION_PATHS,
} from '@/build-plugins/sectionPagesPathsData';
import { isSectionPageOwnedPath, sectionPagesEnabled } from '@/build-plugins/shared/sectionPageOwnership';
import { renderAllSectionPages } from '@/build-plugins/sectionPagesPlugin';
import { claim, reset, setModeForTest } from '@/build-plugins/sharedWriteRegistry';

const ALL_SECTION_PATHS = SECTION_IDS.flatMap((id) => SECTION_PAGE_LOCALES.map((l) => SECTION_PATHS[id][l]));
const FOREIGN_SECTION_PATHS = SECTION_IDS.flatMap((id) => (['en', 'de', 'fr'] as const).map((l) => SECTION_PATHS[id][l]));
const FALLBACK_SUFFIX = /\((guida frontaliere|cross-border guide|Grenzgänger-Leitfaden|guide frontalier)\)/i;

describe('section page ownership predicate', () => {
  it('owns all 28 section paths in every slash form', () => {
    expect(ALL_SECTION_PATHS).toHaveLength(28);
    for (const p of ALL_SECTION_PATHS) {
      expect(isSectionPageOwnedPath(p, {}), p).toBe(true);
      expect(isSectionPageOwnedPath(p.replace(/\/$/, ''), {}), p).toBe(true);
    }
  });

  it('does not claim the SPA tabs, locale roots or near-miss slugs', () => {
    for (const p of ['/fr/assistance/', '/de/hilfe/', '/en/', '/fr', '/fiscale/', '/fr/douane/extra/', '/dogana-ticino/']) {
      expect(isSectionPageOwnedPath(p, {}), p).toBe(false);
    }
  });

  it('lets go when the section plugin is not registered (SKIP_SECTION_PAGES=1)', () => {
    const env = { SKIP_SECTION_PAGES: '1' };
    expect(sectionPagesEnabled(env)).toBe(false);
    for (const p of ALL_SECTION_PATHS) expect(isSectionPageOwnedPath(p, env), p).toBe(false);
  });
});

describe('seeded sitemap ↔ section path table', () => {
  // The hreflang loop iterates the alternates of the seeded sitemap: the skip
  // only protects a page if the sitemap's alternate is spelled exactly as the
  // section table spells it.
  const xml = readFileSync('public/sitemap-pages.xml', 'utf-8');
  const blocks = xml.split('<url>').slice(1);

  for (const id of SECTION_IDS) {
    it(`${id}: every EN/DE/FR alternate of ${SECTION_PATHS[id].it} is section-owned`, () => {
      const block = blocks.find((b) => b.includes(`<loc>https://frontaliereticino.ch${SECTION_PATHS[id].it}</loc>`));
      expect(block, `${SECTION_PATHS[id].it} missing from public/sitemap-pages.xml`).toBeTruthy();
      const alternates = [...block!.matchAll(/hreflang="(en|de|fr)" href="https:\/\/frontaliereticino\.ch([^"]+)"/g)]
        .map((m) => ({ lang: m[1], path: m[2] }));
      expect(alternates.map((a) => a.lang).sort()).toEqual(['de', 'en', 'fr']);
      for (const a of alternates) {
        expect(a.path, `${id}/${a.lang}`).toBe(SECTION_PATHS[id][a.lang as 'en' | 'de' | 'fr']);
        expect(isSectionPageOwnedPath(a.path, {}), a.path).toBe(true);
      }
    });
  }
});

describe('staticPagesPlugin consults the predicate before writing', () => {
  const src = readFileSync('build-plugins/staticPagesPlugin.ts', 'utf-8');

  it('the hreflang-variant loop skips section paths before its write, keeping the #5110 ledger entry', () => {
    const loopStart = src.indexOf('for (const hl of url.hreflangs)');
    expect(loopStart).toBeGreaterThan(0);
    const writeAt = src.indexOf('_qw(locFile, locPageHtml)', loopStart);
    expect(writeAt).toBeGreaterThan(loopStart);
    const loop = src.slice(loopStart, writeAt);
    const skip = /if \(isSectionPageOwnedPath\(locNormalized\)\) \{([\s\S]*?)\n \}/.exec(loop);
    expect(skip, 'section-ownership skip missing from the hreflang loop').toBeTruthy();
    const branch = skip![1];
    expect(branch).toContain('emittedLocaleVariants.add(locNormalized)');
    expect(branch.indexOf('emittedLocaleVariants.add(locNormalized)')).toBeLessThan(branch.indexOf('continue'));
    // No render or write of our own inside the skip.
    expect(branch).not.toMatch(/buildPage\(|_qw\(locFile/);
  });

  it('the Italian branch treats a section path as existing without probing the disk', () => {
    expect(src).toMatch(/const italianPageExists = ogPagesPaths\.has\(normalizedPath\)\s*\|\| isSectionPageOwnedPath\(url\.path\)/);
  });
});

describe('sectionPagesPlugin output', () => {
  const dist = mkdtempSync(join(tmpdir(), 'section-pages-'));
  const pages = renderAllSectionPages(dist, '2026-10-24');
  rmSync(dist, { recursive: true, force: true });
  const h1Of = (html: string) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1].replace(/<[^>]+>/g, '').trim() ?? '';

  it('renders exactly the 28 paths of the section table', () => {
    expect(pages.map((p) => p.urlPath).sort()).toEqual([...ALL_SECTION_PATHS].sort());
  });

  it('each locale page has its own H1, unique across all 28, without the fallback suffix', () => {
    const h1s = pages.map((p) => ({ path: p.urlPath, h1: h1Of(p.html) }));
    for (const { path, h1 } of h1s) {
      expect(h1.length, path).toBeGreaterThan(10);
      expect(h1, path).not.toMatch(FALLBACK_SUFFIX);
    }
    expect(new Set(h1s.map((x) => x.h1)).size).toBe(28);
    // Spot check the page the incident was diagnosed on.
    expect(h1s.find((x) => x.path === '/fr/douane/')?.h1).toBe('Douane et règles de frontière pour frontaliers');
  });

  it('EN/DE/FR pages are not the homepage-editorial fallback', () => {
    for (const p of pages.filter((x) => FOREIGN_SECTION_PATHS.includes(x.urlPath))) {
      expect(p.html, p.urlPath).not.toContain('vous trouverez un résumé rapide');
      expect(p.html, p.urlPath).not.toContain('you will find a quick summary');
      expect(p.html, p.urlPath).not.toContain('finden Sie eine schnelle Zusammenfassung');
    }
  });
});

describe('a second writer of a section path collides on the shared registry', () => {
  afterEach(() => {
    setModeForTest(null);
    reset();
  });

  it('throws under WRITE_COLLISION_MODE=throw once sectionPagesPlugin has claimed the path', () => {
    reset();
    setModeForTest('throw');
    const file = join(tmpdir(), 'section-claim', 'fr', 'douane', 'index.html');
    expect(claim(file, 'sectionPagesPlugin', '<h1>Douane et règles de frontière pour frontaliers</h1>')).toBe('allow-write');
    expect(() => claim(file, 'staticPagesPlugin', '<h1>Douane (guide frontalier)</h1>')).toThrow();
  });
});
