import { describe, expect, it } from 'vitest';

import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';
import {
  FRENCH_ABOVE_FLOOR,
  FRENCH_BELOW_FLOOR,
  frenchMunicipalityPathFor,
} from '@/build-plugins/frenchBorderMunicipalityData';

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

  it('canonicalizes flat employer-profile output back to its directory URL', () => {
    expect(resolveSearchConsoleCompatTarget('/aziende/fachkraft-ch-gmbh.html')).toEqual({
      canonicalPath: '/aziende/fachkraft-ch-gmbh/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/en/aziende/roche.html')).toEqual({
      canonicalPath: '/en/aziende/roche/',
      kind: 'legacy',
      locale: 'en',
    });
  });

  it('routes expired job-detail style URLs back to the localized listing', () => {
    // NB: the fixture must NOT be a sector-hub slug (e.g. the old `cuochi`
    // fixture) — those now self-map to their own live page (full hub or
    // below-floor bridge, issue #3747), covered by the dedicated test below.
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-ticino/aiuto-cuoco-ristorante-lugano/')).toEqual({
      canonicalPath: '/cerca-lavoro-ticino/',
      kind: 'expired-job',
      locale: 'it',
    });
  });

  // Issue #3747 — per-canton sector hubs emit every (canton section × sector ×
  // locale) combo unconditionally: the full hub page, or a below-floor
  // noindex bridge (canton-level MIN_JOBS_FOR_CANTON_PAGE floor AND the finer
  // per-sector MIN_JOBS_PER_CANTON_SECTOR floor both bridge). A URL matching
  // a locale's OWN sector slug under a non-aggregate canton section therefore
  // always has a live target at the SAME path and must self-map.
  it('self-maps sector-hub slugs under canton sections to their own live page (full page or below-floor bridge)', () => {
    // Non-TI canton section, IT slug (below-floor cantons get a bridge).
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-berna/infermieri')).toEqual({
      canonicalPath: '/cerca-lavoro-berna/infermieri/',
      kind: 'legacy',
      locale: 'it',
    });
    // Localized slug under a localized canton section.
    expect(resolveSearchConsoleCompatTarget('/de/jobs-in-bern/pflegepersonal/')).toEqual({
      canonicalPath: '/de/jobs-in-bern/pflegepersonal/',
      kind: 'legacy',
      locale: 'de',
    });
    // TI legacy section: jobSectorPagesPlugin emits ALL sector hubs
    // unconditionally, so the TI variant self-maps too.
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-ticino/cuochi/')).toEqual({
      canonicalPath: '/cerca-lavoro-ticino/cuochi/',
      kind: 'legacy',
      locale: 'it',
    });
    // National aggregate sections get NO sector pages from any plugin — a
    // sector slug there is NOT claimed live (falls back to the section root).
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-svizzera/infermieri/')).toEqual({
      canonicalPath: '/cerca-lavoro-svizzera/',
      kind: 'expired-job',
      locale: 'it',
    });
    // Cross-locale slug (EN word under an IT-locale path) is NOT claimed live:
    // only the locale's own slug table is emitted at that prefix.
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-berna/nurses/')).toEqual({
      canonicalPath: '/cerca-lavoro-berna/',
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
    expect(resolveSearchConsoleCompatTarget('/articoli-svizzera/some-old-article')).toEqual({
      canonicalPath: '/articoli-svizzera/',
      kind: 'legacy',
      locale: 'it',
    });
    expect(resolveSearchConsoleCompatTarget('/en/swiss-articles/some-old-article')).toEqual({
      canonicalPath: '/en/swiss-articles/',
      kind: 'legacy',
      locale: 'en',
    });
    expect(resolveSearchConsoleCompatTarget('/de/schweiz-artikel/some-old-article')).toEqual({
      canonicalPath: '/de/schweiz-artikel/',
      kind: 'legacy',
      locale: 'de',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/articles-suisse/some-old-article')).toEqual({
      canonicalPath: '/fr/articles-suisse/',
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

  // Issue #4263 item 3: half-canton codes (BL/BS -> BASILEA, AI/AR -> APPENZELLO)
  // are grouped under one merged URL-group hub by eventsSeoPagesPlugin (see
  // resolveCantonUrlKey in scripts/lib/events-utils.mjs), so a stale/expired
  // event-detail leaf under either half-canton's slug must canonicalize to
  // that SAME merged hub, with a fallbackPath to the Swiss-wide events index
  // for the case where the hub itself isn't live this build (no upcoming
  // event for that canton group).
  it('resolves half-canton event-detail leaves to their merged URL-group hub (BL/BS -> basilea, AI/AR -> appenzello)', () => {
    expect(resolveSearchConsoleCompatTarget('/eventi/basilea/lugano/concerto-passato')).toEqual({
      canonicalPath: '/eventi/basilea/',
      kind: 'legacy',
      locale: 'it',
      fallbackPath: '/eventi/',
    });
    expect(resolveSearchConsoleCompatTarget('/en/events/basel/some-comune/some-event')).toEqual({
      canonicalPath: '/en/events/basel/',
      kind: 'legacy',
      locale: 'en',
      fallbackPath: '/en/events/',
    });
    expect(resolveSearchConsoleCompatTarget('/de/veranstaltungen/basel/some-comune/some-event')).toEqual({
      canonicalPath: '/de/veranstaltungen/basel/',
      kind: 'legacy',
      locale: 'de',
      fallbackPath: '/de/veranstaltungen/',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/evenements/bale/some-comune/some-event')).toEqual({
      canonicalPath: '/fr/evenements/bale/',
      kind: 'legacy',
      locale: 'fr',
      fallbackPath: '/fr/evenements/',
    });
    expect(resolveSearchConsoleCompatTarget('/eventi/appenzello/some-comune/some-event')).toEqual({
      canonicalPath: '/eventi/appenzello/',
      kind: 'legacy',
      locale: 'it',
      fallbackPath: '/eventi/',
    });
    expect(resolveSearchConsoleCompatTarget('/en/events/appenzell/some-comune/some-event')).toEqual({
      canonicalPath: '/en/events/appenzell/',
      kind: 'legacy',
      locale: 'en',
      fallbackPath: '/en/events/',
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

  // Bare `page-N` (legacy English pagination word crawls, real GSC traffic) →
  // 301 to the section's real localized pagination-ladder twin, derived from
  // the canton already encoded in the URL. IT/DE use a different word
  // ("pagina"/"seite"); EN/FR already use "page" natively, so the canonical
  // target is the same word with a normalized trailing slash.
  it('redirects bare page-N leaves to their localized pagination-ladder twin, with a section-root fallback', () => {
    expect(resolveSearchConsoleCompatTarget('/cerca-lavoro-friburgo/page-12')).toEqual({
      canonicalPath: '/cerca-lavoro-friburgo/pagina-12/',
      kind: 'legacy',
      locale: 'it',
      fallbackPath: '/cerca-lavoro-friburgo/',
    });
    expect(resolveSearchConsoleCompatTarget('/de/jobs-in-freiburg/page-9')).toEqual({
      canonicalPath: '/de/jobs-in-freiburg/seite-9/',
      kind: 'legacy',
      locale: 'de',
      fallbackPath: '/de/jobs-in-freiburg/',
    });
    expect(resolveSearchConsoleCompatTarget('/en/find-jobs-vaud/page-21')).toEqual({
      canonicalPath: '/en/find-jobs-vaud/page-21/',
      kind: 'legacy',
      locale: 'en',
      fallbackPath: '/en/find-jobs-vaud/',
    });
    expect(resolveSearchConsoleCompatTarget('/fr/trouver-emploi-fribourg/page-9')).toEqual({
      canonicalPath: '/fr/trouver-emploi-fribourg/page-9/',
      kind: 'legacy',
      locale: 'fr',
      fallbackPath: '/fr/trouver-emploi-fribourg/',
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

  it('routes expired company-hub week leaves to the hub root, all 4 locales', () => {
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
    // DE/FR hub roots ARE emitted (weeklyEmployersPlugin's renderTopHubPage loop
    // runs over all WEEKLY_EMPLOYERS_LOCALES) — the fallback previously covered
    // only IT/EN, leaving these two unresolvable despite a live target existing.
    expect(
      resolveSearchConsoleCompatTarget('/de/unternehmen-einstellen/bellinzona/swiss-armed-forces-vtg/aktuelle-woche'),
    ).toEqual({
      canonicalPath: '/de/unternehmen-einstellen/',
      kind: 'legacy',
      locale: 'de',
    });
    expect(
      resolveSearchConsoleCompatTarget('/fr/entreprises-recrutent/geneve/some-employer/semaine-en-cours'),
    ).toEqual({
      canonicalPath: '/fr/entreprises-recrutent/',
      kind: 'legacy',
      locale: 'fr',
    });
  });

  it('self-maps a profession-canton URL to its own live page (below-floor bridge or full page)', () => {
    // professionCantonLandings.ts emits every (canton × profession) combo
    // unconditionally — a URL matching the exact enumerated shape always has
    // a live target at the SAME path today, even if GSC captured it as 404
    // from before that guarantee existed. No trailing slash in the GSC-
    // reported URL (as exported) must still resolve.
    expect(resolveSearchConsoleCompatTarget('/de/arbeit-aargau-kellner')).toEqual({
      canonicalPath: '/de/arbeit-aargau-kellner/',
      kind: 'legacy',
      locale: 'de',
    });
    expect(resolveSearchConsoleCompatTarget('/lavoro-zurigo-infermiere/')).toEqual({
      canonicalPath: '/lavoro-zurigo-infermiere/',
      kind: 'legacy',
      locale: 'it',
    });
    // The self-map is generic over the whole enumerated route set (driven by
    // isProfessionCantonPath), so the 5 canton-only professions added for
    // #3657 are covered automatically — no per-profession edit needed here.
    expect(resolveSearchConsoleCompatTarget('/de/arbeit-zurich-automatiker')).toEqual({
      canonicalPath: '/de/arbeit-zurich-automatiker/',
      kind: 'legacy',
      locale: 'de',
    });
    // A profession/canton slug NOT in the enumeration must not false-positive.
    expect(resolveSearchConsoleCompatTarget('/de/arbeit-aargau-not-a-real-profession')).not.toEqual(
      expect.objectContaining({ canonicalPath: '/de/arbeit-aargau-not-a-real-profession/' }),
    );
  });

  it('self-maps a FR border-municipality URL to its own live page (issue #4545, above-floor page or below-floor bridge)', () => {
    // frenchBorderMunicipalityPagesPlugin.ts emits EVERY commune in
    // data/french-border-municipalities.json unconditionally (above-floor as
    // a full page, below-floor as a noindex,follow bridge) at the SAME path
    // every build — same self-map rationale as the fiscal/profession-canton
    // branches above. Data-driven off the live dataset so this survives
    // dataset regeneration without hard-coding a commune slug.
    const above = FRENCH_ABOVE_FLOOR[0];
    const below = FRENCH_BELOW_FLOOR[0];
    expect(above, 'dataset must have at least one above-floor commune').toBeTruthy();
    expect(below, 'dataset must have at least one below-floor commune').toBeTruthy();

    const aboveItPath = frenchMunicipalityPathFor('it', above.slug);
    expect(resolveSearchConsoleCompatTarget(aboveItPath.slice(0, -1))).toEqual({
      canonicalPath: aboveItPath,
      kind: 'legacy',
      locale: 'it',
    });

    const belowFrPath = frenchMunicipalityPathFor('fr', below.slug);
    expect(resolveSearchConsoleCompatTarget(belowFrPath.slice(0, -1))).toEqual({
      canonicalPath: belowFrPath,
      kind: 'legacy',
      locale: 'fr',
    });

    // A slug NOT in the enumeration must not false-positive.
    expect(
      resolveSearchConsoleCompatTarget('/vivere-in-francia-lavorare-in-svizzera/not-a-real-commune'),
    ).not.toEqual(
      expect.objectContaining({
        canonicalPath: '/vivere-in-francia-lavorare-in-svizzera/not-a-real-commune/',
      }),
    );
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

  it('strips an accidental leading duplicate of the site hostname before resolving', () => {
    expect(
      resolveSearchConsoleCompatTarget(
        '/frontaliereticino.ch/en/find-jobs-ticino/some-expired-job-slug',
      ),
    ).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'expired-job',
      locale: 'en',
    });
  });

  it('strips a differently-cased leading duplicate hostname (GSC-indexed casing drift)', () => {
    expect(
      resolveSearchConsoleCompatTarget(
        '/Frontaliereticino.ch/en/find-jobs-ticino/some-expired-job-slug',
      ),
    ).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'expired-job',
      locale: 'en',
    });
  });

  it('strips a www.-prefixed leading duplicate hostname', () => {
    expect(
      resolveSearchConsoleCompatTarget(
        '/www.frontaliereticino.ch/en/find-jobs-ticino/some-expired-job-slug',
      ),
    ).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'expired-job',
      locale: 'en',
    });
  });

  it('strips a differently-cased www.-prefixed leading duplicate hostname', () => {
    expect(
      resolveSearchConsoleCompatTarget(
        '/WWW.FrontaliereTicino.CH/en/find-jobs-ticino/some-expired-job-slug',
      ),
    ).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'expired-job',
      locale: 'en',
    });
  });

  // Issue #3429 — follow-up to PR #3419. GSC may index a locale-prefix
  // segment with drifted casing (e.g. `/EN/...` instead of `/en/`). The
  // case-sensitive section-match regexes below still fail to recover the
  // SPECIFIC slug for a case-drifted path (that's a separate, harder
  // problem not in scope here), but inferLocale() must still detect the
  // correct locale so the generic search-fallback branch lands on the
  // right-locale listing instead of silently defaulting to 'it'.
  it('detects the correct locale from a case-drifted locale prefix (search fallback)', () => {
    expect(
      resolveSearchConsoleCompatTarget('/EN/find-jobs-ticino/ricerca-qualcosa'),
    ).toEqual({
      canonicalPath: '/en/find-jobs-ticino/',
      kind: 'search',
      locale: 'en',
    });
    expect(
      resolveSearchConsoleCompatTarget('/De/jobs-im-tessin/suche-qualcosa'),
    ).toEqual({
      canonicalPath: '/de/jobs-im-tessin/',
      kind: 'search',
      locale: 'de',
    });
    expect(
      resolveSearchConsoleCompatTarget('/FR/trouver-emploi-tessin/recherche-quelque-chose'),
    ).toEqual({
      canonicalPath: '/fr/trouver-emploi-tessin/',
      kind: 'search',
      locale: 'fr',
    });
  });

  it('recovers the wrong-locale-word DE TI section guess to the real jobs-im-tessin section', () => {
    expect(resolveSearchConsoleCompatTarget('/de/jobs-in-ticino')).toEqual({
      canonicalPath: '/de/jobs-im-tessin/',
      kind: 'legacy',
      locale: 'de',
    });
  });

  it('still returns null for truly unknown paths', () => {
    expect(resolveSearchConsoleCompatTarget('/totally-unknown-path')).toBeNull();
    expect(resolveSearchConsoleCompatTarget('/en/unknown-section/something')).toBeNull();
  });
});
