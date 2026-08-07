/**
 * Fleet guard: every editorial static SEO family must emit a hero image —
 * on the page, in its structured data, and as its og:image (issue #5001
 * punto 2).
 *
 * The three are asserted together, per family, on purpose. The `<img>` landed
 * first (#5274, #5281) and the JSON-LD did not, which left ~514 URLs carrying
 * a card the page showed and no machine-readable surface named: `Article.image`
 * still pointed at the site-wide `/og-image.png`, as a bare URL string — the
 * exact shape #5104 had already rejected once. Splitting the assertions across
 * two tests would let that state come back and read as green.
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

    it(`${family} puts the hero in its structured data`, () => {
      // The half of #5001 punto 2 that the hero PRs declared and did not ship.
      // It is asserted per family, in the same loop as the <img>, because the
      // failure being guarded is not "no family has it" — it is "some do".
      // Wiring six of eight leaves a structured-data surface that disagrees
      // with itself, which is harder to reason about than one uniformly
      // absent, and is why the helper's first revision shipped the `<img>`
      // alone rather than half the JSON-LD.
      const src = read(plugin);
      expect(
        src,
        `${plugin} emits a hero <img> but no ImageObject in its JSON-LD`,
      ).toMatch(/seoHeroImageObject(?:Document)?\s*\(/);
    });

    it(`${family} stops claiming the site-wide og-image.png is its picture`, () => {
      // Every one of these families shipped `image: "<origin>/og-image.png"` —
      // a bare URL string (the shape #5104 rejected for NewsArticle.image)
      // pointing at the one default PNG the whole site shares. A page that
      // now renders its own card must not still declare that one.
      const src = read(plugin);
      expect(
        src.match(/image:\s*`\$\{BASE_URL\}\/og-image\.png`/g) ?? [],
        `${plugin} still declares the generic /og-image.png as Article.image`,
      ).toEqual([]);
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

  it('describes each hero ONCE, so the <img> and the ImageObject cannot drift', () => {
    // The markup, the JSON-LD and og:image each derive their URL from a
    // (family, key, locale) triple. Passing three separate object literals
    // would compile, pass every other test here, and still let one call site
    // acquire a different `key` — the page would then advertise, in
    // structured data, a card that is not the one on the page. Requiring a
    // named binding at every call site makes that edit impossible to make
    // accidentally: there is one object to change.
    for (const { plugin } of EDITORIAL_FAMILIES) {
      const src = read(plugin);
      const inlineOpts =
        src.match(/(?:renderSeoHeroImage|seoHeroImageObject(?:Document)?|seoHeroImageUrl)\s*\(\s*\{/g) ??
        [];
      expect(
        inlineOpts.length,
        `${plugin} passes an inline object literal to a hero helper instead of one shared const`,
      ).toBe(0);
    }
  });

  it('makes the card the page image, not just an image on the page', () => {
    // These families inherited the site-wide og:image — the same 1200×630
    // default on ~514 URLs — so the card would have been the only thing on
    // the page representing it while every off-page surface still showed the
    // generic one. `pdfWhitepapersPlugin` was worse than generic: it declared
    // the 512×512 app icon, below the width any large card needs.
    for (const { plugin } of EDITORIAL_FAMILIES) {
      const src = read(plugin);
      expect(src, `${plugin} does not feed the hero card to og:image`).toMatch(
        /seoHeroImageUrl\s*\(/,
      );
      expect(
        src,
        `${plugin} still declares the 512×512 app icon as og:image`,
      ).not.toMatch(/og:image"\s+content="\$\{BASE_URL\}\/icons\/icon-512x512\.png/);
    }
  });

  it('keeps the hero origin identical to BASE_URL without importing it', () => {
    // `seoHeroImage.ts` holds its own origin literal rather than importing
    // BASE_URL, because `constants.ts` reads two CSS files out of `public/`
    // at module scope and this file must stay loadable in a sparse worktree
    // (CLAUDE.md: `public/` is 1.8 GB and is never checked out). The price of
    // that is a second literal, so it is pinned here — as TEXT, so this check
    // itself needs neither import nor `public/`.
    const heroOrigin = read('build-plugins/shared/seoHeroImage.ts').match(
      /const SEO_HERO_ORIGIN = '([^']+)'/,
    )?.[1];
    const baseUrl = read('build-plugins/constants.ts').match(
      /export const BASE_URL = '([^']+)'/,
    )?.[1];
    expect(heroOrigin, 'SEO_HERO_ORIGIN not found in seoHeroImage.ts').toBeTruthy();
    expect(baseUrl, 'BASE_URL not found in constants.ts').toBeTruthy();
    expect(heroOrigin, 'the hero card origin has drifted from BASE_URL').toBe(baseUrl);
  });

  it('builds the ImageObject through the licensable-image builder', async () => {
    // `tests/seo/image-object-license-fields.test.ts` fails the build on any
    // ImageObject in dist/ missing one of the five GSC fields. That gate is
    // dist-driven, so it only speaks after a full build; hand-rolling the
    // object here would go green locally and fail CI across ~514 URLs at once.
    const helper = read('build-plugins/shared/seoHeroImage.ts');
    expect(helper, 'the hero ImageObject must go through imageObjectLd()').toMatch(
      /import \{[^}]*imageObjectLd[^}]*\} from '\.\.\/\.\.\/services\/seo\/imageObjectLd'/s,
    );

    const mod = await import('../../build-plugins/shared/seoHeroImage');
    mod.resetSeoHeroCardRegistry();
    const ld = mod.seoHeroImageObject({
      family: 'glossario',
      key: 'permesso-g',
      locale: 'it',
      alt: 'Permesso G',
    });

    // The #5104 shape: dimensions declared, not a bare URL string.
    expect(ld['@type']).toBe('ImageObject');
    expect(ld.url).toBe('https://frontaliereticino.ch/og/seo/glossario/permesso-g-it.webp');
    expect(ld.contentUrl).toBe(ld.url);
    expect(ld.width).toBe(mod.SEO_HERO_WIDTH);
    expect(ld.height).toBe(mod.SEO_HERO_HEIGHT);
    expect(ld.caption).toBe('Permesso G');

    // The five fields the GSC gate requires.
    for (const field of ['acquireLicensePage', 'copyrightNotice', 'license', 'creator', 'creditText']) {
      expect(ld[field], `hero ImageObject is missing ${field}`).toBeTruthy();
    }

    // Same URL as the <img> and as og:image — one triple, three consumers.
    const opts = { family: 'glossario', key: 'permesso-g', locale: 'it', alt: 'Permesso G' } as const;
    expect(mod.seoHeroImageUrl(opts)).toBe(ld.url);
    expect(mod.renderSeoHeroImage(opts)).toContain(
      mod.seoHeroCardPath('glossario', 'permesso-g', 'it'),
    );
    expect(mod.seoHeroImageObjectDocument(opts)['@context']).toBe('https://schema.org');

    mod.resetSeoHeroCardRegistry();
  });

  it('registers the card when only the ImageObject references it', async () => {
    // A family could reasonably build its JSON-LD and its body in different
    // passes. If only the markup registered, an ImageObject-first page would
    // publish structured data pointing at a WebP the generator never renders
    // — the pdfWhitepapersPlugin 404-hero failure again, in a surface where
    // no browser would ever make it visible.
    const mod = await import('../../build-plugins/shared/seoHeroImage');
    mod.resetSeoHeroCardRegistry();
    mod.seoHeroImageObject({ family: 'faq-hub', key: 'only-ld', locale: 'de', alt: 'Q' });
    expect(mod.pendingSeoHeroCardCount()).toBe(1);

    // ...and calling both for one page still enqueues exactly one render.
    mod.renderSeoHeroImage({ family: 'faq-hub', key: 'only-ld', locale: 'de', alt: 'Q' });
    expect(mod.pendingSeoHeroCardCount()).toBe(1);
    mod.resetSeoHeroCardRegistry();
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
