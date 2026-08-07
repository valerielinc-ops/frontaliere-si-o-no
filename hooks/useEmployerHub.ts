/**
 * useEmployerHub — "does this employer have a live `/aziende/<slug>/` page, and
 * where is it?", answered at RUNTIME without inventing a second source of truth.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * GSC, 28 days (9 Jul – 6 Aug 2026, `sc-domain:frontaliereticino.ch`):
 *
 *   · the 505 `/aziende/<slug>/` hubs in the sitemap took 571 impressions and
 *     29 clicks in total, and only 30 of the 505 got a single impression;
 *   · the brand demand that maps onto those very hubs is worth 28 826
 *     impressions and 1 257 clicks in the same window — a ~50:1 gap;
 *   · of the 200 strongest «lavorare in / da / presso X» query→page pairs
 *     (629 queries, CTR 10.05 % vs the site's 5.16 %), 115 land on a SINGLE
 *     JOB AD and ZERO on the employer hub. «lavorare in eoc» → an ad,
 *     position 9.5, 28 impressions, 0 clicks.
 *
 * An ad expires and takes the position it earned with it; the hub is the page
 * that answers the same query permanently. So every dead-end job surface has
 * to hand the reader over to it. The hubs are not broken, they are unlinked:
 * monthly impressions 0 / 0 / 47 / 44 / 1 098 / 470.
 *
 * ── THE HAZARD THIS MODULE REMOVES ─────────────────────────────────────────
 * Not every employer HAS a hub. `scripts/build-employer-profiles.mjs` splits
 * the corpus on the floors in `build-plugins/shared/employerProfileConfig.mjs`:
 *
 *   activeJobs >= MIN_ACTIVE_JOBS (5) → full, indexable profile page
 *   BRIDGE_FLOOR (2) .. 4            → `noindex,follow` bridge at the same URL
 *   0 .. 1                           → NOTHING is emitted at that URL
 *
 * Linking the third band is not a soft failure on this site, it is a blank
 * page: a full navigation to an un-emitted `/aziende/<slug>/` 404s → 404.html
 * stores the URL → `location.replace('/')` → SPA restore → the router matches
 * `^/aziende/<slug>/` and returns `staticOverlay: true` → the lite shell
 * renders header + footer over static HTML that does not exist. That is the
 * burkhalter-group incident JobExpiredView / JobOrphanView already carry a
 * comment about, and it is exactly why both of them route the company link
 * through a `<button>` today instead of an `<a href>`.
 *
 * ── THE ORACLE, AND WHY IT IS NOT A NEW SOURCE OF TRUTH ────────────────────
 * `build-plugins/employerProfilePagesPlugin.ts` already publishes
 * `dist/data/employer-job-counts.json` — slug → active postings — and its own
 * comment states the invariant we need verbatim: «Only slugs that GOT a page
 * are included: a count linking to a 404 is worse than no count.» Membership
 * in that map IS "the page exists", written by the only thing that can know:
 * the emitter. `components/pages/FollowedCompaniesPage.tsx` already reads it
 * from the same `dist/data/` prefix `scripts/lib/deploy-it-pages-prep.sh`
 * syncs to R2 (`max-age=600`), so the delivery path is proven in production.
 *
 * The value carried alongside — the count — then separates the two emitted
 * bands with the SHARED floor rather than a second guess: `>= MIN_ACTIVE_JOBS`
 * is the full hub, below it is the bridge. We link only the full hub. A bridge
 * would not 404, but it lists no jobs at all, so a CTA promising "all open
 * positions" would be a lie, and a `noindex` target is worth nothing to the
 * query the reader arrived on.
 *
 * Fail-closed on every unknown: map not loaded yet, fetch failed, slug absent,
 * count below the floor → `null` → the caller renders no link. The status quo
 * (an in-app company filter) is preserved in all of those cases.
 */

import { useEffect, useState } from 'react';
import { cdnDataUrl } from '@/services/cdnDataBase';
import type { Locale } from '@/services/i18n';
import { canonicalCompanyProfileSlug } from '@/build-plugins/shared/companyProfileSlug.mjs';
import { MIN_ACTIVE_JOBS } from '@/build-plugins/shared/employerProfileConfig.mjs';

/** Published by employerProfilePagesPlugin into `dist/data/`. */
export const EMPLOYER_JOB_COUNTS_PATH = '/data/employer-job-counts.json';

export interface EmployerHub {
  /** Canonical employer slug — `canonicalCompanyProfileSlug`, nothing else. */
  slug: string;
  /** Locale-prefixed path of the emitted hub page. */
  href: string;
  /** Active postings the last build counted for this employer. */
  activeJobs: number;
}

/**
 * `/aziende/<slug>/` — ONE literal segment in every locale, IT unprefixed.
 *
 * Mirrors `profilePath()` in build-plugins/employerProfilePagesPlugin.ts, which
 * is the authority (it writes the files). The runtime cannot import that plugin,
 * so the shape is pinned against it — and against the two other constructions
 * that predate this module (`companyHubPath` in FollowedCompaniesPage.tsx,
 * `companyHubUrl` in services/companyAlertEmail.mjs) — by
 * tests/employer-hub-internal-links.test.ts.
 */
export function employerHubPath(slug: string, locale: Locale): string {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/aziende/${encodeURIComponent(slug)}/`;
}

/**
 * Anchor text for a link INTO the hub — the ONE phrasing every runtime surface
 * uses (JobExpiredView, JobOrphanView, and whatever dead-end view comes next).
 *
 * It mirrors the destination's own <title>: `employerTitleCandidates` in
 * build-plugins/employerProfilePagesPlugin.ts composes
 * `{name}: {INTENT_PHRASE} {AND_WORD} {PAY_PHRASE}`. Mirrored and not imported
 * because that module exports only the Vite plugin factory — and the SSG job
 * page (jobsSeoPagesPlugin.ts) carries its own copy for the opposite reason: a
 * build plugin must not pull a React hook into the build graph. Two copies,
 * pinned equal by tests/employer-hub-internal-links.test.ts.
 *
 * Anchor text is a ranking signal for the DESTINATION, so it has to be the
 * phrase the destination is trying to win, and that phrase was re-derived from
 * evidence on 2026-08-07: brand-first, because queries open with the company
 * name; «offerte di lavoro» because it is the head phrase (46 341 impressions
 * / 7 227 clicks in 90 days) while the editorial «lavorare in …» has no
 * brand-attached instance in that same corpus; «e stipendi» because it is the
 * one token separating this page from the canton company hub
 * `/cerca-lavoro-<canton>/azienda-<slug>/` — the sibling that HOLDS this brand
 * demand today ("eoc offerte di lavoro": 3 550 impr / 228 click at pos 4.78,
 * landing there), which every one of these surfaces also links. Two links, two
 * pages, two phrases — never one phrase aimed at both.
 *
 * (The 28-day GSC pull that motivated this whole change measures 629 live
 * «lavorare in / da / presso X» queries at 10,05 % CTR against the site's
 * 5,16 %, 115 of whose top-200 landings are single ads exactly like these.
 * That family is long tail and sits below the 23 111-query cut of
 * data/evidence-index.json, which is why the two readings disagree. It is not
 * a reason to spend the anchor on it: a hub that ranks for the brand at all
 * answers those queries too.)
 */
export function employerHubAnchor(company: string, locale: Locale): string {
  switch (locale) {
    case 'en': return `${company}: jobs and salaries`;
    case 'de': return `${company}: offene Stellen und Gehalt`;
    case 'fr': return `${company}: offres d’emploi et salaires`;
    default: return `${company}: offerte di lavoro e stipendi`;
  }
}

/**
 * "N annunci attivi" — the one phrasing of a hub's open-role count.
 *
 * Same wording as `STRINGS[locale].openRoles` in FollowedCompaniesPage.tsx,
 * which reads the same map for the same purpose; that copy predates this module
 * and lives inside its page-local `STRINGS` record (see the report — folding it
 * in is a one-line-per-locale change in a file owned elsewhere).
 */
export function employerOpenRolesLabel(n: number, locale: Locale): string {
  switch (locale) {
    case 'en': return n === 1 ? '1 open role' : `${n} open roles`;
    case 'de': return n === 1 ? '1 offene Stelle' : `${n} offene Stellen`;
    case 'fr': return n === 1 ? '1 offre active' : `${n} offres actives`;
    default: return n === 1 ? '1 annuncio attivo' : `${n} annunci attivi`;
  }
}

// Module-level cache — one fetch per session, shared by every surface that
// asks (an expired ad, an orphan slug, and whatever comes next). Mirrors
// hooks/useExpiredJob.ts's index cache, including the "null the in-flight
// promise on failure so a later mount can retry" detail.
let cachedCounts: Record<string, number> | null = null;
let countsFetchPromise: Promise<Record<string, number> | null> | null = null;

export function fetchEmployerHubCounts(): Promise<Record<string, number> | null> {
  if (cachedCounts) return Promise.resolve(cachedCounts);
  if (!countsFetchPromise) {
    countsFetchPromise = fetch(cdnDataUrl(EMPLOYER_JOB_COUNTS_PATH))
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, number>>) : null))
      .then((data) => {
        if (data && typeof data === 'object') {
          cachedCounts = data;
          return data;
        }
        countsFetchPromise = null;
        return null;
      })
      .catch(() => {
        countsFetchPromise = null;
        return null;
      });
  }
  return countsFetchPromise;
}

/** Test seam — resets the module cache between cases. */
export function __resetEmployerHubCounts(): void {
  cachedCounts = null;
  countsFetchPromise = null;
}

/**
 * The whole decision, as a pure function of the published map — so the rule
 * that keeps a reader off a blank page is unit-testable without a renderer.
 *
 * Returns `null` for every case we cannot PROVE:
 *   · no company name, or a name that slugifies to nothing;
 *   · map not loaded (in flight, or the fetch failed);
 *   · slug absent from the map → NO page was emitted at that URL;
 *   · count under MIN_ACTIVE_JOBS → a `noindex` bridge with no job list.
 */
export function resolveEmployerHub(
  counts: Record<string, number> | null,
  company: string | null | undefined,
  companyKey: string | null | undefined,
  locale: Locale,
): EmployerHub | null {
  // The slug comes from the ONE normalisation the hub URL, the CompanyAlert key
  // and the dataset all share — re-slugifying here would be the drift #5151
  // spent its review deleting four copies of.
  const slug: string = company ? canonicalCompanyProfileSlug(company, companyKey || undefined) : '';
  if (!slug || !counts) return null;
  const activeJobs = counts[slug];
  if (typeof activeJobs !== 'number' || activeJobs < MIN_ACTIVE_JOBS) return null;
  return { slug, href: employerHubPath(slug, locale), activeJobs };
}

/**
 * The employer's live hub, or `null` when we cannot PROVE one was emitted.
 *
 * Never throws and never blocks a render: the first pass returns `null` while
 * the map is in flight, and the caller simply has no link for one paint.
 */
export function useEmployerHub(
  company: string | null | undefined,
  companyKey: string | null | undefined,
  locale: Locale,
): EmployerHub | null {
  const [counts, setCounts] = useState<Record<string, number> | null>(cachedCounts);

  useEffect(() => {
    if (!company || counts) return undefined;
    let cancelled = false;
    fetchEmployerHubCounts().then((c) => {
      if (!cancelled && c) setCounts(c);
    });
    return () => { cancelled = true; };
  }, [company, counts]);

  return resolveEmployerHub(counts, company, companyKey, locale);
}
