/**
 * Fleet guard: every editorial static SEO family must emit a hero image
 * (issue #5001 punto 2).
 *
 * WHY A GUARD AND NOT JUST THE FIX
 * ────────────────────────────────
 * The gap was invisible for as long as it existed. These families carry
 * `max-image-preview:large` (normalized site-wide in #5170) and declare an
 * `og:image` — the site-wide 1200×630 default — so every header-level audit
 * reads them as Discover-ready. They ship **zero** `<img>` tags, which is the
 * one thing Discover's large card actually needs. Measured 2026-08-06 across
 * the live sitemaps: 40 of 86 families emit no image at all.
 *
 * The same shape as `discover-robots-directive.test.ts` from #5170, and for
 * the same reason recorded there: a new family that writes the obvious thing
 * should be caught by CI rather than by someone re-measuring production
 * months later.
 *
 * NOT every family belongs here. Data landings (fuel stations, per-comune tax
 * pages, search clusters) legitimately have no image: a photograph for
 * "tasse frontalieri a Colico" would be invented, and inventing one is worse
 * than having none. This list is the editorial families only — the ones whose
 * page IS a piece of writing.
 */

import fs from 'node:fs';
import np from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = np.resolve(__dirname, '..', '..');

/**
 * family → the plugin that emits it. Kept as an explicit map rather than a
 * glob so adding a family here is a deliberate act with a reviewer attached.
 */
const EDITORIAL_FAMILIES: ReadonlyArray<{ family: string; plugin: string }> = [
  { family: 'holidays', plugin: 'build-plugins/holidaysLandingsPlugin.ts' },
  { family: 'minimum-wage', plugin: 'build-plugins/minimumWageLandingsPlugin.ts' },
  { family: 'annual-report', plugin: 'build-plugins/annualReportPlugin.ts' },
  { family: 'market-report', plugin: 'build-plugins/marketReportPlugin.ts' },
  { family: 'frontaliere-pillar', plugin: 'build-plugins/frontalierePillarPlugin.ts' },
  { family: 'guides', plugin: 'build-plugins/pdfWhitepapersPlugin.ts' },
  { family: 'faq-hub', plugin: 'build-plugins/faqHubPlugin.ts' },
  { family: 'glossario', plugin: 'build-plugins/staticPagesPlugin.ts' },
];

const read = (rel: string): string => fs.readFileSync(np.join(ROOT, rel), 'utf-8');

describe('Discover hero image — fleet guard', () => {
  for (const { family, plugin } of EDITORIAL_FAMILIES) {
    it(`${family} emits a hero image`, () => {
      const src = read(plugin);
      expect(src, `${plugin} must import the shared hero helper`).toMatch(
        /renderSeoHeroImage/,
      );
      expect(
        src,
        `${plugin} must request the '${family}' family so its cards are generated`,
      ).toContain(`family: '${family}'`);
    });
  }

  it('routes every hero through the one helper, so markup cannot diverge', () => {
    // A family hand-rolling its own <img> would get no generated card, no
    // declared dimensions and no ImageObject — the three things the helper
    // exists to keep together.
    for (const { plugin } of EDITORIAL_FAMILIES) {
      const src = read(plugin);
      const heroImgs = src.match(/<img\b[^>]*data-seo-hero/g) ?? [];
      expect(heroImgs.length, `${plugin} hand-rolls a hero <img>`).toBe(0);
    }
  });

  it('declares intrinsic dimensions on the hero, so it cannot cause layout shift', () => {
    const helper = read('build-plugins/shared/seoHeroImage.ts');
    expect(helper).toMatch(/width="\$\{SEO_HERO_WIDTH\}"/);
    expect(helper).toMatch(/height="\$\{SEO_HERO_HEIGHT\}"/);
    expect(helper).toMatch(/aspect-ratio/);
  });

  it('reports a card requested after the drain instead of shipping a 404 hero', async () => {
    const mod = await import('../../build-plugins/shared/seoHeroImage');
    mod.resetSeoHeroCardRegistry();

    // In tempo: registrata prima del drain.
    mod.renderSeoHeroImage({ family: 'holidays', key: 'a', locale: 'it', alt: 'A' });
    expect(mod.drainSeoHeroCardRequests()).toHaveLength(1);
    expect(mod.lateSeoHeroCardFamilies()).toEqual([]);

    // In ritardo: la pagina e' gia' scritta con un <img> che nessuno rendera'.
    // E' il caso reale di pdfWhitepapersPlugin (`await import` in testa a
    // closeBundle), che senza questa guardia era del tutto silenzioso.
    mod.renderSeoHeroImage({ family: 'guides', key: 'b', locale: 'it', alt: 'B' });
    expect(mod.lateSeoHeroCardFamilies()).toEqual(['guides/b/it']);

    mod.resetSeoHeroCardRegistry();
  });

  it('never derives a card key with String() on a non-string', () => {
    // `String(page)` su un oggetto vale "[object Object]": tutte le pagine
    // della famiglia collidono sulla stessa chiave di registro e sullo stesso
    // `src`, l'ultima renderizzata sovrascrive le altre, e ogni pagina mostra
    // la card di un'altra. E' successo su `minimum-wage` (7 pagine × locale)
    // perche' `String(...)` era stato usato per zittire un errore di tipo
    // invece di ricavare una chiave vera — il file aveva gia' `pageKey()`.
    for (const { plugin } of EDITORIAL_FAMILIES) {
      const src = read(plugin);
      const calls = src.match(/key:\s*String\(/g) ?? [];
      expect(calls.length, `${plugin} costruisce la chiave con String(...)`).toBe(0);
    }
  });

  it('keeps EVERY build plugin free of an await import() at the top of closeBundle', () => {
    // Guardia di FLOTTA, non solo sugli emettitori hero: la prima versione di
    // questo test guardava le sole famiglie editoriali e per questo non vide
    // `jobsSeoPagesPlugin`, `jobRecencyPagesPlugin`, `jobSectorPagesPlugin`,
    // `preloadLocalePlugin` e `webpPlugin` — cinque occorrenze della stessa
    // classe, trovate in review.
    //
    // Perche' e' una classe e non un dettaglio: `closeBundle` e' un hook
    // Rollup async/parallelo. Un `await` come prima istruzione sospende il
    // plugin, e un altro plugin `enforce:'post'` puo' girare per INTERO prima
    // che riprenda. E' gia' costato due bug silenziosi in questa stessa
    // settimana — hero card drenate prima di essere registrate, quindi pagine
    // con un <img> verso un file mai generato.
    const dir = np.join(ROOT, 'build-plugins');
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = fs.readFileSync(np.join(dir, f), 'utf-8');
      if (/async closeBundle\(\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*const\s+\w+\s*=\s*await\s+import\(/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders, 'await import() come prima istruzione di closeBundle').toEqual([]);
  });

  it('keeps every hero emitter free of an await before its render loop', () => {
    // L'invariante che la guardia sopra sorveglia a runtime, qui sul sorgente
    // per il caso che l'ha rotta: un `await import(...)` come prima istruzione
    // di closeBundle sospende il plugin oltre il drain.
    for (const { plugin } of EDITORIAL_FAMILIES) {
      const src = read(plugin);
      expect(src, `${plugin} usa un await import() dentro closeBundle`).not.toMatch(
        /async closeBundle\(\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*const\s+\w+\s*=\s*await\s+import\(/,
      );
    }
  });

  it('generates the cards from the same registry the markup fills', () => {
    // If the plugin ever stops draining the registry the pages would point at
    // images nobody renders — a 404 hero on every editorial page.
    const gen = read('build-plugins/seoHeroCardsPlugin.ts');
    expect(gen).toMatch(/drainSeoHeroCardRequests/);
    expect(gen).toMatch(/og-render-worker\.mjs/);
  });
});
