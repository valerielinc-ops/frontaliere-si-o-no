import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';

describe('Search Console 404 compatibility resolver', () => {
  it('maps malformed search URLs back to the localized job-board root', () => {
    expect(resolveSearchConsoleCompatTarget('/en/find-jobs-ticino/search-their')).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'search',
      locale: 'en',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/trouver-emploi-tessin/recherche-votre')).toEqual({
      canonicalPath: '/fr/trouver-emploi-tessin/',
      kind: 'search',
      locale: 'fr',
    });
  });

  // Canton-drift recovery: a job slug is globally unique, so an orphaned
  // canton-variant 404 (the canton was re-derived between crawls and the job
  // migrated sections) must resolve to the slug's CURRENT canonical job page —
  // not the bare section listing — when a slug index is supplied. This is the
  // dominant residual-404 cohort (≈94% of live Cloudflare job-detail 404s).
  it('redirects an orphaned canton-variant to the slug\'s real canonical page', () => {
    const idx = new Map<string, Partial<Record<'it' | 'en' | 'de' | 'fr', string>>>([
      ['capo-ottimizzazione-portafoglio-ffs-zollikofen', {
        it: '/cerca-lavoro-berna/capo-ottimizzazione-portafoglio-ffs-zollikofen',
        de: '/de/jobs-in-bern/capo-ottimizzazione-portafoglio-ffs-zollikofen',
      }],
    ]);
    // Requested under the legacy/orphan TI section → recovered to the real berna page.
    expect(
      resolveSearchConsoleCompatTarget('/cerca-lavoro-ticino/capo-ottimizzazione-portafoglio-ffs-zollikofen', idx),
    ).toEqual({
      canonicalPath: '/cerca-lavoro-berna/capo-ottimizzazione-portafoglio-ffs-zollikofen/',
      kind: 'canton-moved',
      locale: 'it',
    });
    // Prefers the request's own locale canonical.
    expect(
      resolveSearchConsoleCompatTarget('/de/jobs-im-tessin/capo-ottimizzazione-portafoglio-ffs-zollikofen', idx),
    ).toEqual({
      canonicalPath: '/de/jobs-in-bern/capo-ottimizzazione-portafoglio-ffs-zollikofen/',
      kind: 'canton-moved',
      locale: 'de',
    });
  });

  it('falls back to the URL-section listing when the slug is unknown or already canonical', () => {
    const idx = new Map<string, Partial<Record<'it' | 'en' | 'de' | 'fr', string>>>([
      ['data-engineer-acme-lugano', { it: '/cerca-lavoro-ticino/data-engineer-acme-lugano' }],
    ]);
    // Unknown slug → listing of the canton already in the URL (no drift onto TI).
    expect(
      resolveSearchConsoleCompatTarget('/cerca-lavoro-san-gallo/some-expired-slug-unknown', idx),
    ).toEqual({
      canonicalPath: '/cerca-lavoro-san-gallo/',
      kind: 'expired-job',
      locale: 'it',
    });
    // Slug maps to the SAME path requested → not a move; listing fallback.
    expect(
      resolveSearchConsoleCompatTarget('/cerca-lavoro-ticino/data-engineer-acme-lugano', idx),
    ).toEqual({
      canonicalPath: '/cerca-lavoro-ticino/',
      kind: 'expired-job',
      locale: 'it',
    });
    // No index supplied → unchanged legacy behavior (listing fallback).
    expect(
      resolveSearchConsoleCompatTarget('/cerca-lavoro-berna/whatever-expired-slug'),
    ).toEqual({
      canonicalPath: '/cerca-lavoro-berna/',
      kind: 'expired-job',
      locale: 'it',
    });
  });

  // Regression: a search-style slug under a NON-Ticino canton section must
  // canonicalize to that canton's listing, not drift onto Ticino. The search
  // branch runs before the expired-job branch, so without canton-awareness
  // every ricerca-/suche-/search-/recherche- job slug (≈29% of the coverage
  // cohort) would land on /cerca-lavoro-ticino/ (the #2041 wrong-canton bug).
  it('keeps the URL canton for search-style slugs under non-Ticino sections', () => {
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-berna/ricerca-offerte-lavoro-software-plc-ingegnere')).toEqual({
      canonicalPath: '/cerca-lavoro-berna/',
      kind: 'search',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/de/jobs-in-schweiz/suche-asset-ostermundigen')).toEqual({
      canonicalPath: '/de/jobs-in-schweiz/',
      kind: 'search',
      locale: 'de',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/trouver-emploi-suisse/recherche-ingenieur-metier-rolex')).toEqual({
      canonicalPath: '/fr/trouver-emploi-suisse/',
      kind: 'search',
      locale: 'fr',
    });
  });

  it('fixes non-Italian company URLs with the wrong azienda prefix', () => {
    expect(resolveSearchConsoleCompatTarget('/de/jobs-im-tessin/azienda-medacta-international-sa')).toEqual({
      canonicalPath: '/de/jobs-im-tessin/unternehmen-medacta-international-sa/',
      kind: 'company',
      locale: 'de',
    });
  });

  it('routes expired job-detail style URLs back to the localized listing', () => {
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-ticino/cuochi/')).toEqual({
      canonicalPath: '/cerca-lavoro-ticino/',
      kind: 'expired-job',
      locale: 'it',
    });
  });

  // #2041 — expired non-Ticino job paths must canonicalize to the canton in the
  // URL, NOT drift onto Ticino. The slug is gone from the slug→canton index, so
  // the old getCantonForSlug()-based inference fell back to TI; the canton is
  // already in the URL and is the authoritative signal.
  it('keeps the URL canton for expired non-Ticino job-detail URLs (no TI drift)', () => {
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-san-gallo/expired-vendita-slug/')).toEqual({
      canonicalPath: '/cerca-lavoro-san-gallo/',
      kind: 'expired-job',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/en/find-jobs-zurich/expired-developer-slug/')).toEqual({
      canonicalPath: '/en/find-jobs-zurich/',
      kind: 'expired-job',
      locale: 'en',
    });
  });

  // Full-coverage scan over the committed 404 export. This file is an unbounded
  // GSC-orphan accumulator (~306k paths, ~31MB at time of writing) so the loop
  // cost scales with data size; the default 15s vitest budget overflows under CI
  // load (observed ~20s). Explicit generous timeout preserves full coverage
  // without sampling/weakening.
  it('covers the committed live 404 export paths', () => {
    const compatPaths = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', 'data', 'seo-404-compat-paths.json'), 'utf-8')
    );
    expect(Array.isArray(compatPaths.paths)).toBe(true);
    // Realistic sanity floor (~half the current ~306k volume) so an organic
    // shrink doesn't false-fail but a catastrophic truncation (e.g. a write
    // failure during the sync-gsc-orphans append) is caught. The old floor of
    // 603 stayed green even if the export were truncated to a few hundred rows.
    expect(compatPaths.paths.length).toBeGreaterThanOrEqual(150000);
    for (const value of compatPaths.paths) {
      expect(resolveSearchConsoleCompatTarget(value), value).not.toBeNull();
    }
  }, 60000);

  it('resolves non-job section 404s to their landing pages', () => {
    expect(resolveSearchConsoleCompatTarget('/vivere-in-ticino/vivere-in-svizzera')).toEqual({
      canonicalPath: '/vivere-in-ticino/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/articoli-frontaliere/some-old-article')).toEqual({
      canonicalPath: '/articoli-frontaliere/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/en/cross-border-articles/some-old-article')).toEqual({
      canonicalPath: '/en/cross-border-articles/',
      kind: 'legacy',
      locale: 'en',
    });
    expect(resolveSearchConsoleCompatTarget('/de/grenzgaenger-artikel/some-old-article')).toEqual({
      canonicalPath: '/de/grenzgaenger-artikel/',
      kind: 'legacy',
      locale: 'de',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/articles-frontalier/some-old-article')).toEqual({
      canonicalPath: '/fr/articles-frontalier/',
      kind: 'legacy',
      locale: 'fr',
    });
    expect(resolveSearchConsoleCompatTarget('/compara-servizi/something')).toEqual({
      canonicalPath: '/compara-servizi/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/fisco-frontaliere/something')).toEqual({
      canonicalPath: '/tasse-e-pensione/',
      kind: 'legacy',
      locale: 'it',
    });
  });

  it('routes listing pagination leaves to the canton listing root', () => {
    expect(resolveSearchConsoleCompatTarget('/de/jobs-im-tessin/alle/page-1022')).toEqual({
      canonicalPath: '/de/jobs-im-tessin/',
      kind: 'legacy',
      locale: 'de',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/trouver-emploi-tessin/tous/page-454')).toEqual({
      canonicalPath: '/fr/trouver-emploi-tessin/',
      kind: 'legacy',
      locale: 'fr',
    });
    expect(resolveSearchConsoleCompatTarget('/en/find-jobs-ticino/all/page-510')).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'legacy',
      locale: 'en',
    });
  });

  it('routes expired job-detail leaves with a trailing numeric id to the listing', () => {
    expect(
      resolveSearchConsoleCompatTarget(
        '/de/jobs-im-tessin/arztsekretar-in-oder-mpa-80-frauenklinik-zuri-ost-spital-uster-ch/3594',
      ),
    ).toEqual({
      canonicalPath: '/de/jobs-im-tessin/',
      kind: 'expired-job',
      locale: 'de',
    });
  });

  it('routes expired fuel-station leaves to the matching fuel landing (diesel↔diesel, benzina↔benzina)', () => {
    // IT diesel → IT diesel today page.
    expect(resolveSearchConsoleCompatTarget('/prezzi-diesel/lugano/stazioni/eni-strada-per-gandria')).toEqual({
      canonicalPath: '/prezzi-diesel/oggi/',
      kind: 'legacy',
      locale: 'it',
    });
    // DE benzina (benzinpreis-schweiz) → DE benzina today page, NOT the diesel one.
    expect(resolveSearchConsoleCompatTarget('/de/benzinpreis-schweiz/lugano/tankstellen/socar-via-colombera')).toEqual({
      canonicalPath: '/de/benzinpreis-schweiz/heute/',
      kind: 'legacy',
      locale: 'de',
    });
    // FR diesel is `prix-gasoil-suisse` (the live section); `prix-diesel` is a
    // legacy alias that 301-redirects, so it must NOT be the canonical target.
    expect(resolveSearchConsoleCompatTarget('/fr/prix-gasoil-suisse/mendrisio/stations/eni-via-bernasconi')).toEqual({
      canonicalPath: '/fr/prix-gasoil-suisse/aujourd-hui/',
      kind: 'legacy',
      locale: 'fr',
    });
    // FR benzina (prix-essence-suisse) → FR benzina today page.
    expect(resolveSearchConsoleCompatTarget('/fr/prix-essence-suisse/lugano/stations/piccadilly-via-cantonale-2')).toEqual({
      canonicalPath: '/fr/prix-essence-suisse/aujourd-hui/',
      kind: 'legacy',
      locale: 'fr',
    });
  });

  it('routes expired company-hub week leaves to the hub root', () => {
    expect(
      resolveSearchConsoleCompatTarget('/aziende-che-assumono/locarno/amministrazione-cantonale-ticino/settimana-corrente'),
    ).toEqual({
      canonicalPath: '/aziende-che-assumono/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(
      resolveSearchConsoleCompatTarget('/en/companies-hiring/lugano/lis-lugano-istituti-sociali/current-week'),
    ).toEqual({
      canonicalPath: '/en/companies-hiring/',
      kind: 'legacy',
      locale: 'en',
    });
  });

  it('routes legacy flat /lavoro/ job URLs to the localized listing', () => {
    expect(resolveSearchConsoleCompatTarget('/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino')).toEqual({
      canonicalPath: '/cerca-lavoro-ticino/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/en/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino')).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'legacy',
      locale: 'en',
    });
  });

  it('covers every URL in the bounded GSC Coverage 404 export', () => {
    const coverage = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', 'data', 'gsc-coverage-404s.json'), 'utf-8')
    );
    expect(Array.isArray(coverage.paths)).toBe(true);
    expect(coverage.paths.length).toBeGreaterThan(0);
    for (const value of coverage.paths) {
      expect(resolveSearchConsoleCompatTarget(value), value).not.toBeNull();
    }

    // Section-preservation guard (not just non-null): every coverage URL under a
    // per-canton job-board section must canonicalize to the SAME section — no
    // wrong-canton drift. Excludes company-hub leaves (azienda-/company-/… →
    // canton-independent TI hub by design). Catches the search-branch shadowing
    // regression the plain non-null assertion above would miss.
    const SECTION_RE =
      /^(?:\/(?:en|de|fr))?\/((?:cerca-lavoro|find-jobs?|job-search|jobs-i[mn]|jobsuche|stellenangebote|trouver-emploi|recherche-emploi|emplois)-[a-z-]+)\//;
    const COMPANY_SLUG_RE = /\/(?:azienda|company|unternehmen|entreprise)-/;
    for (const value of coverage.paths) {
      const m = value.match(SECTION_RE);
      if (!m || COMPANY_SLUG_RE.test(value)) continue;
      const res = resolveSearchConsoleCompatTarget(value);
      expect(res?.canonicalPath, value).toContain(`/${m[1]}/`);
    }
  });

  it('still returns null for truly unknown paths', () => {
    expect(resolveSearchConsoleCompatTarget('/totally-unknown-path')).toBeNull();
    expect(resolveSearchConsoleCompatTarget('/en/unknown-section/something')).toBeNull();
  });
});
