import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  expectedCtrForPosition,
  ctrGapRatio,
  aggregateFamilyRows,
  effectiveTargetCtr,
  discoverUnregisteredFamilies,
  familyPathPrefixes,
  classifyUnregisteredFamilyCandidate,
  SEO_CTR_FAMILIES,
  MIN_IMPRESSIONS_TO_MONITOR,
} from '../scripts/lib/seo-ctr-curve.mjs';
import { SLUG_TABLES } from '../services/routeSlugs.data';

describe('seo-ctr-curve (issue #4300)', () => {
  describe('expectedCtrForPosition', () => {
    it('returns the position-1 CTR for position 1', () => {
      expect(expectedCtrForPosition(1)).toBe(0.316);
    });

    it('returns the tail CTR beyond position 20', () => {
      expect(expectedCtrForPosition(25)).toBe(0.006);
    });

    it('rounds fractional positions to the nearest integer bucket', () => {
      expect(expectedCtrForPosition(7.4)).toBe(expectedCtrForPosition(7));
    });

    it('clamps non-finite / sub-1 positions to position 1', () => {
      expect(expectedCtrForPosition(0)).toBe(expectedCtrForPosition(1));
      expect(expectedCtrForPosition(NaN)).toBe(expectedCtrForPosition(1));
    });
  });

  describe('ctrGapRatio', () => {
    it('returns >1 when actual CTR beats the position curve', () => {
      const ratio = ctrGapRatio(0.5, 1); // expected @ pos1 = 0.316
      expect(ratio).toBeGreaterThan(1);
    });

    it('returns <1 when actual CTR underperforms the position curve', () => {
      const ratio = ctrGapRatio(0.01, 1);
      expect(ratio).toBeLessThan(1);
    });
  });

  describe('SEO_CTR_FAMILIES', () => {
    it('has the 3 monitored families from the issue with their target CTRs', () => {
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      expect(byId['articoli-frontaliere'].targetCtr).toBe(0.03);
      expect(byId['guida-frontaliere'].targetCtr).toBe(0.035);
      expect(byId['tasse-e-pensione'].targetCtr).toBe(0.03);
      expect(byId['articoli-frontaliere'].monitored).toBe(true);
      expect(byId['guida-frontaliere'].monitored).toBe(true);
      expect(byId['tasse-e-pensione'].monitored).toBe(true);
    });

    it('keeps the /de/ locale prefix report-only (unmonitored, no target)', () => {
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      expect(byId['de'].kind).toBe('locale');
      expect(byId['de'].monitored).toBe(false);
      expect(byId['de'].targetCtr).toBeNull();
    });

    it('monitors /cerca-lavoro-ticino/, the highest-volume family', () => {
      // Regression guard for the state this test itself used to pin: the
      // family was `monitored: false, targetCtr: null` while carrying
      // 911.138 impressioni / 90gg — 2,4× le tre famiglie sorvegliate insieme.
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      const fam = byId['cerca-lavoro-ticino'];
      expect(fam.kind).toBe('template');
      expect(fam.monitored).toBe(true);
      expect(fam.targetCtrCurveMultiple).toBeGreaterThan(1);
      expect(fam.targetCtr).toBeGreaterThan(0);
    });

    it('every family carries a measured 90-day impression volume', () => {
      // The invariant below is only as good as its input: a family with no
      // `impressions90d` would slip under any volume threshold for free.
      for (const family of SEO_CTR_FAMILIES) {
        expect(
          Number.isFinite(family.impressions90d),
          `${family.id}: manca impressions90d (misura GSC a 90 giorni)`,
        ).toBe(true);
        expect(family.impressions90d, `${family.id}: impressions90d non positivo`).toBeGreaterThan(0);
        expect(typeof family.measuredOn, `${family.id}: manca measuredOn`).toBe('string');
      }
    });

    it('THE INVARIANT: every template family above the volume threshold is monitored with a usable target', () => {
      // This is the test the missing `/cerca-lavoro-ticino/` entry needed and
      // did not have. Without it, dropping `monitored: true` is a silent
      // one-word edit that no gate notices.
      const offenders = SEO_CTR_FAMILIES.filter(
        (f) => f.kind === 'template' && f.impressions90d >= MIN_IMPRESSIONS_TO_MONITOR && !f.monitored,
      ).map((f) => `${f.id} (${f.impressions90d} impressioni/90gg)`);
      expect(
        offenders,
        `famiglie template sopra ${MIN_IMPRESSIONS_TO_MONITOR} impressioni/90gg lasciate fuori dal monitor: ${offenders.join(', ')}`,
      ).toEqual([]);

      for (const family of SEO_CTR_FAMILIES.filter((f) => f.monitored)) {
        // A monitored family whose target resolves to null (or to 0) would
        // make `ctr < target` always false — a monitor that can never fire.
        const target = effectiveTargetCtr(family, 8);
        expect(target, `${family.id}: target effettivo non risolvibile`).not.toBeNull();
        expect(target, `${family.id}: target effettivo non positivo`).toBeGreaterThan(0);
      }
    });

    it('the `locale` exemption cannot be used to hide a template family', () => {
      // `kind: 'locale'` is the only way out of the invariant above, so it is
      // pinned to an actual locale root. Relabelling e.g. /cerca-lavoro-ticino/
      // as `locale` to silence the invariant fails here.
      for (const family of SEO_CTR_FAMILIES.filter((f) => f.kind === 'locale')) {
        expect(
          family.pathContains,
          `${family.id}: kind 'locale' ammesso solo su una radice /xx/`,
        ).toMatch(/^\/(en|de|fr|it)\/$/);
      }
      for (const family of SEO_CTR_FAMILIES) {
        expect(['template', 'locale', 'listing'], `${family.id}: kind sconosciuto`).toContain(family.kind);
      }
    });

    it('the `listing` exemption requires a documented justification note (issue #6306)', () => {
      // Unlike `locale`, `listing` isn't pinned to a fixed path shape, so the
      // `note` field is the only thing keeping the exemption auditable instead
      // of a silent way to dodge THE INVARIANT above.
      for (const family of SEO_CTR_FAMILIES.filter((f) => f.kind === 'listing')) {
        expect(family.monitored, `${family.id}: kind 'listing' deve restare monitored:false`).toBe(false);
        expect(
          typeof family.note === 'string' && family.note.length > 0,
          `${family.id}: kind 'listing' richiede un 'note' che giustifichi l'esenzione`,
        ).toBe(true);
      }
    });

    it('registers /vita-in-ticino/ as a heterogeneous listing, not an uncensed template (issue #6306)', () => {
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      const fam = byId['vita-in-ticino'];
      expect(fam).toBeDefined();
      expect(fam.pathContains).toBe('/vita-in-ticino/');
      expect(fam.kind).toBe('listing');
      expect(fam.monitored).toBe(false);
      expect(fam.impressions90d).toBe(96180);
    });

    it('carries pathAliases for every locale slug of a top-level template family (issue #5964)', () => {
      // Automates the manual audit issue #5964 asked for: any registered
      // template family whose `pathContains` matches a top-level
      // `SLUG_TABLES.it` key (the shape (b) prefix-kept-translated-segment
      // families like `guida-frontaliere`/`tasse-e-pensione`, and the
      // shape (a) prefix-dropped families like `articoli-frontaliere`/
      // `cerca-lavoro-ticino`) must list the en/de/fr translated slug for
      // that same key in `pathAliases` — otherwise each locale variant rolls
      // up as its own "unregistered family" once it crosses the volume
      // threshold on its own (see field docs above, issue #5961). This test
      // turns the one-off audit into a permanent guard against re-drift.
      const itSlugToKey = Object.fromEntries(
        Object.entries(SLUG_TABLES.it).map(([key, slug]) => [slug, key]),
      );
      const offenders = [];
      for (const family of SEO_CTR_FAMILIES) {
        if (family.kind !== 'template') continue;
        const itSlug = family.pathContains.replace(/^\/|\/$/g, '');
        const key = itSlugToKey[itSlug];
        if (!key) continue; // not a simple top-level tab slug — nothing to cross-check
        const aliases = new Set(family.pathAliases || []);
        for (const locale of ['en', 'de', 'fr']) {
          const expectedAlias = `/${SLUG_TABLES[locale][key]}/`;
          if (!aliases.has(expectedAlias)) {
            offenders.push(`${family.id}: manca pathAliases '${expectedAlias}' (locale ${locale}, chiave routeSlugs '${key}')`);
          }
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  });

  describe('effectiveTargetCtr', () => {
    const curveFamily = { id: 'x', targetCtr: 0.053, targetCtrCurveMultiple: 1.9 };
    const staticFamily = { id: 'y', targetCtr: 0.03 };

    it('derives the target from the position curve when a multiple is declared', () => {
      // expectedCtrForPosition(8.61) → bucket 9 → 0.028; 1.9 × 0.028 = 0.0532
      expect(effectiveTargetCtr(curveFamily, 8.61)).toBeCloseTo(1.9 * 0.028, 10);
    });

    it('moves the target with the position instead of freezing it', () => {
      const atFour = effectiveTargetCtr(curveFamily, 4);
      const atFifteen = effectiveTargetCtr(curveFamily, 15);
      expect(atFour).toBeGreaterThan(atFifteen);
    });

    it('falls back to the static target when the position is unusable', () => {
      expect(effectiveTargetCtr(curveFamily, null)).toBe(0.053);
      expect(effectiveTargetCtr(curveFamily, NaN)).toBe(0.053);
      expect(effectiveTargetCtr(curveFamily, 0)).toBe(0.053);
    });

    it('leaves families without a curve multiple on their static target', () => {
      expect(effectiveTargetCtr(staticFamily, 8.61)).toBe(0.03);
    });

    it('returns null for a report-only family', () => {
      expect(effectiveTargetCtr({ id: 'z', targetCtr: null }, 8.61)).toBeNull();
    });

    it('would not fire on the /cerca-lavoro-ticino/ CTR measured on 2026-08-11', () => {
      // Sanity check that the chosen threshold is neither ornamental nor
      // trigger-happy: at the measured 6,63% / pos 8,61 the family is above
      // target, and a 25% CTR regression at the same position drops below it.
      const fam = SEO_CTR_FAMILIES.find((f) => f.id === 'cerca-lavoro-ticino')!;
      const target = effectiveTargetCtr(fam, 8.61)!;
      expect(0.0663).toBeGreaterThan(target);
      expect(0.0663 * 0.75).toBeLessThan(target);
    });
  });

  describe('familyPathPrefixes (issue #5961)', () => {
    it('returns just pathContains when the family has no aliases', () => {
      expect(familyPathPrefixes({ pathContains: '/de/' })).toEqual(['/de/']);
    });

    it('appends pathAliases after pathContains', () => {
      const fam = { pathContains: '/articoli-frontaliere/', pathAliases: ['/cross-border-articles/', '/grenzgaenger-artikel/'] };
      expect(familyPathPrefixes(fam)).toEqual(['/articoli-frontaliere/', '/cross-border-articles/', '/grenzgaenger-artikel/']);
    });

    it('the real registry entries expose their known locale-slug aliases (issue #5961)', () => {
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      expect(familyPathPrefixes(byId['articoli-frontaliere'])).toContain('/cross-border-articles/');
      expect(familyPathPrefixes(byId['articoli-frontaliere'])).toContain('/grenzgaenger-artikel/');
      expect(familyPathPrefixes(byId['cerca-lavoro-ticino'])).toContain('/find-jobs-ticino/');
      expect(familyPathPrefixes(byId['cerca-lavoro-ticino'])).toContain('/jobs-im-tessin/');
      // prefix-kept, translated-segment shape (services/routeSlugs.data.ts's
      // `guida`/`fisco` keys) — same blind spot, different URL shape.
      expect(familyPathPrefixes(byId['guida-frontaliere'])).toContain('/cross-border-guide/');
      expect(familyPathPrefixes(byId['guida-frontaliere'])).toContain('/grenzgaenger-ratgeber/');
      expect(familyPathPrefixes(byId['guida-frontaliere'])).toContain('/guide-frontalier/');
      expect(familyPathPrefixes(byId['tasse-e-pensione'])).toContain('/taxes-and-pension/');
      expect(familyPathPrefixes(byId['tasse-e-pensione'])).toContain('/steuern-und-vorsorge/');
      expect(familyPathPrefixes(byId['tasse-e-pensione'])).toContain('/impots-et-retraite/');
    });
  });

  describe('discoverUnregisteredFamilies (issue #5656)', () => {
    const families = [
      { id: 'articoli-frontaliere', pathContains: '/articoli-frontaliere/' },
      { id: 'de', pathContains: '/de/' },
    ];

    it('excludes a pathAliases-covered segment (issue #5961)', () => {
      const aliasedFamilies = [
        { id: 'articoli-frontaliere', pathContains: '/articoli-frontaliere/', pathAliases: ['/cross-border-articles/', '/grenzgaenger-artikel/'] },
      ];
      const rows = [
        { path: '/cross-border-articles/some-post/', impressions: 90_000 },
        { path: '/grenzgaenger-artikel/anderer-beitrag/', impressions: 90_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families: aliasedFamilies, minImpressions: 50_000 });
      expect(result).toEqual([]);
    });

    it('flags an unregistered segment above the threshold', () => {
      const rows = [
        { path: '/cerca-lavoro-ticino/qualche-annuncio/', impressions: 40_000 },
        { path: '/cerca-lavoro-ticino/altro-annuncio/', impressions: 20_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([{ pathContains: '/cerca-lavoro-ticino/', impressions90d: 60_000 }]);
    });

    it('excludes a prefix-kept-but-translated-segment alias (issue #5961, guida-frontaliere shape)', () => {
      const aliasedFamilies = [
        {
          id: 'guida-frontaliere',
          pathContains: '/guida-frontaliere/',
          pathAliases: ['/cross-border-guide/', '/grenzgaenger-ratgeber/'],
        },
      ];
      const rows = [
        { path: '/en/cross-border-guide/some-guide/', impressions: 90_000 },
        { path: '/de/grenzgaenger-ratgeber/anderer-leitfaden/', impressions: 90_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families: aliasedFamilies, minImpressions: 50_000 });
      expect(result).toEqual([]);
    });

    it('rolls up locale-prefixed pages into the same segment as the default locale', () => {
      const rows = [
        { path: '/cerca-lavoro-ticino/annuncio-it/', impressions: 30_000 },
        { path: '/en/cerca-lavoro-ticino/annuncio-en/', impressions: 25_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([{ pathContains: '/cerca-lavoro-ticino/', impressions90d: 55_000 }]);
    });

    it('excludes segments already covered by a registered pathContains', () => {
      const rows = [{ path: '/articoli-frontaliere/qualche-post/', impressions: 1_000_000 }];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([]);
    });

    it('drops segments below the impressions threshold', () => {
      const rows = [{ path: '/nuova-sezione/pagina/', impressions: 49_999 }];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([]);
    });

    it('sorts multiple candidates by descending impressions', () => {
      const rows = [
        { path: '/sezione-a/x/', impressions: 60_000 },
        { path: '/sezione-b/x/', impressions: 90_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result.map((r) => r.pathContains)).toEqual(['/sezione-b/', '/sezione-a/']);
    });

    it('ignores rows with no path or root-only paths', () => {
      const rows = [
        { path: '/', impressions: 1_000_000 },
        { path: '', impressions: 1_000_000 },
        { impressions: 1_000_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([]);
    });

    it('defaults to SEO_CTR_FAMILIES and MIN_IMPRESSIONS_TO_MONITOR when not overridden', () => {
      const result = discoverUnregisteredFamilies([]);
      expect(result).toEqual([]);
    });
  });

  describe('classifyUnregisteredFamilyCandidate (issue #7174)', () => {
    it('classifica il prefisso locale puro come kind locale', () => {
      const result = classifyUnregisteredFamilyCandidate({ pathContains: '/de/', impressions90d: 700_000 });
      expect(result.kind).toBe('locale');
      expect(result.family).toBeDefined();
      expect(result.family?.id).toBe('de');
      expect(result.family?.kind).toBe('locale');
      expect(result.family?.monitored).toBe(false);
      expect(result.family?.targetCtr).toBeNull();
    });

    it('classifica un job-board noto come template monitorabile', () => {
      const result = classifyUnregisteredFamilyCandidate({
        pathContains: '/find-jobs-ticino/',
        impressions90d: 70_000,
      });
      expect(result.kind).toBe('template');
      expect(result.family).toBeDefined();
      expect(result.family?.kind).toBe('template');
      expect(result.family?.pathContains).toBe('/find-jobs-ticino/');
      expect(result.family?.pathAliases).toEqual(
        expect.arrayContaining([
          '/cerca-lavoro-ticino/',
          '/jobs-im-tessin/',
          '/trouver-emploi-tessin/',
        ]),
      );
      expect(result.family?.monitored).toBe(true);
    });

    it('classifica una sezione fuel nota come template monitorabile', () => {
      const result = classifyUnregisteredFamilyCandidate({ pathContains: '/prezzi-diesel/', impressions90d: 55_000 });
      expect(result.kind).toBe('template');
      expect(result.family).toBeDefined();
      expect(result.family?.kind).toBe('template');
      expect(result.family?.pathContains).toBe('/prezzi-diesel/');
      expect(result.family?.pathAliases).toEqual(
        expect.arrayContaining([
          '/diesel-price-switzerland/',
          '/dieselpreis-schweiz/',
          '/prix-gasoil-suisse/',
        ]),
      );
      expect(result.family?.monitored).toBe(true);
    });

    it('lascia unknown per percorsi senza mapping noto', () => {
      const result = classifyUnregisteredFamilyCandidate({ pathContains: '/sezione-sconosciuta/', impressions90d: 60_000 });
      expect(result.kind).toBe('unknown');
      expect(result.family).toBeNull();
    });
  });

  describe('aggregateFamilyRows', () => {
    const rows = [
      { path: '/a', clicks: 10, impressions: 200, position: 3, ctr: 0.05 },
      { path: '/b', clicks: 1, impressions: 100, position: 5, ctr: 0.01 }, // well below curve
      { path: '/c', clicks: 2, impressions: 10, position: 2, ctr: 0.2 }, // below minImpressions, excluded
    ];

    it('filters rows below minImpressions and aggregates the rest', () => {
      const agg = aggregateFamilyRows(rows, { minImpressions: 20 });
      expect(agg.pageCount).toBe(2);
      expect(agg.totalClicks).toBe(11);
      expect(agg.totalImpressions).toBe(300);
      expect(agg.avgCtr).toBeCloseTo(11 / 300, 6);
    });

    it('computes an impressions-weighted average position', () => {
      const agg = aggregateFamilyRows(rows, { minImpressions: 20 });
      const expected = (3 * 200 + 5 * 100) / 300;
      expect(agg.avgPosition).toBeCloseTo(expected, 6);
    });

    it('flags pages whose CTR falls below underperformRatio × expected-for-position', () => {
      // Expected CTR @ position 3 ≈ 0.106: /healthy sits well above it,
      // /weak sits well below it (ratio < 0.6) and should be the only flag.
      const flagRows = [
        { path: '/healthy', clicks: 30, impressions: 200, position: 3, ctr: 0.15 },
        { path: '/weak', clicks: 1, impressions: 100, position: 3, ctr: 0.01 },
      ];
      const agg = aggregateFamilyRows(flagRows, { minImpressions: 20, underperformRatio: 0.6 });
      expect(agg.belowCurveCount).toBe(1);
      expect(agg.belowCurvePages[0].path).toBe('/weak');
    });

    it('returns null avgCtr/avgPosition and zero counts for an empty/all-filtered input', () => {
      const agg = aggregateFamilyRows([], { minImpressions: 20 });
      expect(agg.pageCount).toBe(0);
      expect(agg.totalClicks).toBe(0);
      expect(agg.totalImpressions).toBe(0);
      expect(agg.avgCtr).toBeNull();
      expect(agg.avgPosition).toBeNull();
      expect(agg.belowCurveCount).toBe(0);
    });
  });
});

describe('registro famiglie — il punto cieco degli alias di locale (follow-up #5964)', () => {
  // #5961: una famiglia `template` esiste in quattro URL, uno per locale. Se
  // il registro ne conosce solo lo slug italiano, gli altri tre rotolano su
  // come «famiglia non registrata» appena superano la soglia di volume, e la
  // misura CTR della famiglia e' fatta su un quarto del suo traffico.
  //
  // L'audit richiesto dal follow-up e' questo, e vale piu' di una risposta
  // scritta una volta: `guida-frontaliere`/`tasse-e-pensione` erano gli unici
  // due nominati, ma la domanda era se ALTRE entry avessero la stessa forma.
  // Qui la domanda si ripone da sola a ogni run.
  it('ogni famiglia `template` dichiara gli alias di locale', () => {
    const senzaAlias = SEO_CTR_FAMILIES
      .filter((f) => f.kind === 'template')
      .filter((f) => !(Array.isArray(f.pathAliases) && f.pathAliases.length > 0))
      .map((f) => f.id);
    expect(senzaAlias, 'famiglia template senza pathAliases: i locale non-IT rotoleranno su come famiglia nuova').toEqual([]);
  });

  it('le famiglie senza alias non sono template, e il motivo e nel registro', () => {
    // Il verso opposto dell'invariante sopra: cio' che NON ha alias deve avere
    // una ragione strutturale per non averne, non una dimenticanza.
    //  - `listing`: pagine editoriali indipendenti, nessun generator condiviso
    //    e nessuna variante di locale emessa;
    //  - `locale`: `/de/` e' un PREFISSO, non un template — un alias non
    //    vorrebbe dire niente.
    for (const f of SEO_CTR_FAMILIES) {
      if (Array.isArray(f.pathAliases) && f.pathAliases.length) continue;
      expect(['listing', 'locale'], `${f.id}: senza alias ma di kind ${f.kind}`).toContain(f.kind);
    }
  });

  it('nessun alias duplica il pathContains di un altra famiglia', () => {
    // Due famiglie che rivendicano lo stesso prefisso renderebbero
    // l'attribuzione delle impression dipendente dall'ordine dell'array.
    const visti = new Map();
    for (const f of SEO_CTR_FAMILIES) {
      for (const p of familyPathPrefixes(f)) {
        expect(visti.has(p), `prefisso ${p} rivendicato sia da ${visti.get(p)} sia da ${f.id}`).toBe(false);
        visti.set(p, f.id);
      }
    }
  });
});

describe('LOCALE_PATH_PREFIXES — la locale di default non ha prefisso (follow-up #5964)', () => {
  it('nessun prefisso `it` compare fra gli alias registrati', () => {
    // Il reviewer chiedeva se esista un URL con prefisso `it`.
    // `localePrefix()` in services/router.ts rende '' per 'it' e `/${locale}`
    // per gli altri tre: un `/it/…` non e' producibile by construction.
    // L'assunzione e' quindi corretta — e questo test e' cio' che se ne
    // accorgerebbe se il router cambiasse idea, perche' il primo sintomo
    // sarebbe un alias `/it/…` che entra nel registro.
    for (const f of SEO_CTR_FAMILIES) {
      for (const p of familyPathPrefixes(f)) {
        expect(p.startsWith('/it/'), `${f.id}: alias con prefisso it — LOCALE_PATH_PREFIXES non lo strippa`).toBe(false);
      }
    }
  });

  it('il router non emette prefisso per la locale di default', () => {
    const src = readFileSync(new URL('../services/router.ts', import.meta.url), 'utf-8');
    // Se questa riga cambia, `LOCALE_PATH_PREFIXES` va riaperta insieme.
    expect(src).toMatch(/function localePrefix\([^)]*\)[^{]*\{\s*return locale === 'it' \? '' : `\/\$\{locale\}`;/);
  });
});
