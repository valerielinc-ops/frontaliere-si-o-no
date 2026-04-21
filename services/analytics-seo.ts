/**
 * SEO Page Type Tracking
 *
 * Classifies the current URL pathname into one of the tagged SEO page types
 * shipped in the Apr 2026 SEO roadmap, then emits a `seo_page_view` event to
 * both PostHog and GA4 (gtag) so dashboards can segment RPM / traffic by
 * feature (F2 health-premiums, F3a jobs, F3b orphan landings, F4 job-market
 * snapshot, F5 weekly-employers, F6 fuel-daily, plus existing hubs).
 *
 * Silent activation — no consent gate. Per product memory
 * `feedback_silent_consent.md`, all analytics fire unconditionally.
 *
 * Design:
 * - Pure string classification. Does NOT import build-plugin route tables
 *   (keeps client bundle slim — no need to ship `listFuelTodayPaths`, etc.
 *   just to tag a page view).
 * - All 4 locale URL prefixes are covered (IT root, /en/, /de/, /fr/).
 * - Returns `null` for any path that isn't a tagged SEO page, so unrelated
 *   events do not receive a spurious `seo_page_type`.
 */

import { captureEvent as posthogCapture } from './posthog';

// ─── Locale detection ──────────────────────────────────────────────────

type SupportedLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * Detect the locale from the URL pathname prefix.
 * IT (default) has no prefix; EN/DE/FR use `/en/`, `/de/`, `/fr/`.
 */
function detectLocale(pathname: string): SupportedLocale {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (normalized.startsWith('/en/') || normalized === '/en') return 'en';
  if (normalized.startsWith('/de/') || normalized === '/de') return 'de';
  if (normalized.startsWith('/fr/') || normalized === '/fr') return 'fr';
  return 'it';
}

/**
 * Strip the locale prefix (if any) and any leading slash, returning the
 * first path segment. Used as the basis for prefix classification.
 */
function stripLocalePrefix(pathname: string): string {
  const normalized = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts[0] === 'en' || parts[0] === 'de' || parts[0] === 'fr') {
    return parts.slice(1).join('/');
  }
  return parts.join('/');
}

// ─── Slug tables (one per feature × locale) ────────────────────────────
//
// Kept as `readonly` arrays so the classifier can iterate without concern
// for mutation. When a new feature ships a new section slug, add it here.

/** F6 — Daily fuel-price pages (diesel + gasoline). */
const FUEL_DAILY_SECTIONS: readonly string[] = [
  // IT
  'prezzi-diesel',
  'prezzi-benzina',
  // EN
  'diesel-price-switzerland',
  'gasoline-price-switzerland',
  // DE
  'dieselpreis-schweiz',
  'benzinpreis-schweiz',
  // FR
  'prix-gasoil-suisse',
  'prix-essence-suisse',
];

/** F5 — Weekly "aziende che assumono" per-city hub. */
const WEEKLY_EMPLOYERS_SECTIONS: readonly string[] = [
  'aziende-che-assumono',        // IT
  'companies-hiring',            // EN
  'unternehmen-einstellen',      // DE
  'entreprises-recrutent',       // FR
];

/** F4 — Weekly/monthly Ticino job-market snapshot. */
const JOB_MARKET_SNAPSHOT_SECTIONS: readonly string[] = [
  'mercato-lavoro-ticino',       // IT
  'ticino-job-market',           // EN
  'tessiner-arbeitsmarkt',       // DE
  'marche-travail-tessin',       // FR
];

/** F2 — LAMal premiums-per-canton landings. */
const HEALTH_PREMIUMS_SECTIONS: readonly string[] = [
  'premi-cassa-malati',          // IT
  'health-insurance-premiums',   // EN
  'krankenkassenpraemien',       // DE
  'primes-assurance-maladie',    // FR
];

/** F3b — GSC orphan-query cluster landings. */
const ORPHAN_LANDING_SECTIONS: readonly string[] = [
  'ricerca',    // IT
  'search',     // EN
  'suche',      // DE
  'recherche',  // FR
];

/** Job-board top-level sections (covers F3a title optimization + sub-hubs). */
const JOB_BOARD_SECTIONS: readonly string[] = [
  'cerca-lavoro-ticino',         // IT
  'find-jobs-ticino',            // EN
  'jobs-im-tessin',              // DE
  'trouver-emploi-tessin',       // FR
];

/** Salary calculator long-tail SEO hubs. */
const SALARY_HUB_SECTIONS: readonly string[] = [
  'calcola-stipendio',           // IT
  'calculate-salary',            // EN
  'gehalt-berechnen',            // DE
  'calculer-salaire',            // FR
];

/** Exact geo-hub city slugs — match the second segment after the job-board section. */
const CITY_HUB_SLUGS: readonly string[] = ['lugano', 'mendrisio', 'bellinzona'];

/** Recency-hub slugs across locales (last-3-days / since-yesterday variants). */
const RECENCY_HUB_SLUGS: readonly string[] = [
  // IT
  'ultimi-3-giorni',
  'da-ieri',
  'da-ieri-a-oggi',
  'ultime-48-ore',
  // EN
  'last-3-days',
  'since-yesterday',
  // DE
  'letzten-3-tage',
  'seit-gestern',
  // FR
  '3-derniers-jours',
  'depuis-hier',
];

// ─── Classifier ────────────────────────────────────────────────────────

export type SeoPageType =
  | 'fuel_daily'
  | 'weekly_employers'
  | 'job_market_snapshot'
  | 'health_premiums'
  | 'orphan_query_landing'
  | 'job_listing'
  | 'city_hub'
  | 'sector_hub'
  | 'recency_hub'
  | 'salary_hub';

/**
 * Classify a URL pathname into one of the tagged SEO page types.
 * Returns `null` for any path that isn't a tagged SEO page.
 *
 * Hubs under the job-board section are classified in this priority order:
 *   1. `city_hub` — exact match for lugano/mendrisio/bellinzona
 *   2. `recency_hub` — exact match for locale-aware recency slugs
 *   3. `sector_hub` — any other non-empty second segment that isn't a job slug
 *   4. `job_listing` — fall-through (covers job details + top-level listings)
 */
export function classifySeoPageType(pathname: string): SeoPageType | null {
  if (typeof pathname !== 'string' || pathname.length === 0) return null;

  const stripped = stripLocalePrefix(pathname);
  if (stripped === '') return null;

  const segments = stripped.split('/').filter(Boolean);
  const firstSegment = segments[0];
  const secondSegment = segments[1];

  if (!firstSegment) return null;

  // F6 — fuel-daily
  if (FUEL_DAILY_SECTIONS.includes(firstSegment)) {
    return 'fuel_daily';
  }

  // F5 — weekly employers
  if (WEEKLY_EMPLOYERS_SECTIONS.includes(firstSegment)) {
    return 'weekly_employers';
  }

  // F4 — job-market snapshot
  if (JOB_MARKET_SNAPSHOT_SECTIONS.includes(firstSegment)) {
    return 'job_market_snapshot';
  }

  // F2 — health premiums
  if (HEALTH_PREMIUMS_SECTIONS.includes(firstSegment)) {
    return 'health_premiums';
  }

  // F3b — orphan-query landings: only tag when there's a sub-slug, so the
  // bare /ricerca (which is unused) doesn't silently get tagged.
  if (ORPHAN_LANDING_SECTIONS.includes(firstSegment) && secondSegment) {
    return 'orphan_query_landing';
  }

  // Salary-calculator hubs (long-tail SEO). Must have a second segment so
  // the root /calcola-stipendio (calculator home) is NOT tagged as a hub —
  // that page is the main calculator UI, not an SEO landing.
  if (SALARY_HUB_SECTIONS.includes(firstSegment) && secondSegment) {
    return 'salary_hub';
  }

  // Job-board sections (covers F3a + city/sector/recency hubs).
  if (JOB_BOARD_SECTIONS.includes(firstSegment)) {
    if (secondSegment) {
      if (CITY_HUB_SLUGS.includes(secondSegment)) return 'city_hub';
      if (RECENCY_HUB_SLUGS.includes(secondSegment)) return 'recency_hub';
      // Otherwise it's either a sector hub or a job detail. Sector hubs are
      // short, URL-safe identifiers without multiple hyphens (e.g.
      // "infermieri", "case-anziani"). Job detail slugs include many
      // hyphens and appended job-ids (e.g. "software-engineer-bank-x-12345").
      // Heuristic: if the second segment has <4 hyphen-separated parts,
      // treat as a sector hub; else as a job listing.
      const hyphenParts = secondSegment.split('-').filter(Boolean);
      if (hyphenParts.length < 4) return 'sector_hub';
      return 'job_listing';
    }
    // Bare /cerca-lavoro-ticino/ — the listing index page.
    return 'job_listing';
  }

  return null;
}

// ─── Tracker ───────────────────────────────────────────────────────────

/**
 * Minimal shape we expect on `window.gtag` — a variadic event-logging
 * function. Typed loosely so we don't fight GA4's string-literal union
 * (which varies across gtag.js versions).
 */
type GtagFn = (command: string, eventName: string, params?: Record<string, unknown>) => void;

interface GtagWindow {
  gtag?: GtagFn;
}

/**
 * Resolve the global gtag function if it exists. Returns `undefined` when
 * running under SSR / Node or when gtag.js hasn't loaded yet (ad blocker,
 * first-paint race).
 */
function getGtag(): GtagFn | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as GtagWindow;
  return typeof w.gtag === 'function' ? w.gtag : undefined;
}

/**
 * Track a page-view for a tagged SEO page. No-op when the pathname doesn't
 * classify as a known feature — we don't want to dilute the event with
 * untagged routes.
 *
 * Emits to:
 *   - PostHog:  `seo_page_view` with `seo_page_type`, `pathname`, `locale`
 *   - GA4/gtag: `seo_page_view` with `seo_page_type`, `page_path`
 *
 * Both emitters fail silently if their SDK isn't loaded.
 */
export function trackSeoPageView(pathname: string): void {
  const seoPageType = classifySeoPageType(pathname);
  if (!seoPageType) return;

  const locale = detectLocale(pathname);

  // PostHog — fire-and-forget. The captureEvent helper handles the
  // "not yet initialised" case internally.
  try {
    posthogCapture('seo_page_view', {
      seo_page_type: seoPageType,
      pathname,
      locale,
    });
  } catch {
    // PostHog blocked or in an error state — drop silently.
  }

  // GA4 via gtag. Skipped when gtag.js hasn't loaded (ad blocker or pre-init).
  const gtag = getGtag();
  if (gtag) {
    try {
      gtag('event', 'seo_page_view', {
        seo_page_type: seoPageType,
        page_path: pathname,
        locale,
      });
    } catch {
      // gtag stub-out or quota-refused — drop silently.
    }
  }
}
