/**
 * Shared data + path logic for the per-municipality AUSTRIA border pages
 * (issue #4883 — Vorarlberg/Tirol corridor: Bezirke Bregenz/Dornbirn/
 * Feldkirch/Bludenz/Landeck, fourth of the FR/DE/AT/LI rollout after France
 * #4545/#4878, Germany #4882, Liechtenstein #4884/#3890).
 *
 * GOVERNING FISCAL FACT — this family is structurally different from every
 * sibling: the special Art. 15 §4 DBA-A frontalieri regime (SR 0.672.916.31)
 * was ABROGATED in 2006/2007 (BGBl. III Nr. 22/2007, "aufgehoben"). There is
 * NO reduced rate, NO capped Quellensteuer, NO defined border zone and NO
 * non-return-days threshold for Austria — only ordinary Art. 15 §1 taxation
 * (full cantonal Quellensteuer tariff) applies. AUSTRIAN_REGIME below encodes
 * this as explicit `false` flags precisely so no page/test can silently
 * default to a German-shaped (4.5% / 60-day) figure. See AUSTRIAN_REGIME's
 * own doc comment and data/austrianBorderMunicipalities.ts's "REGIME" header
 * for the full sourcing.
 *
 * Single source of truth for:
 *   - the committed dataset (data/austrian-border-municipalities.json, built
 *     by scripts/build-austrian-border-municipalities.mjs from
 *     data/austrianBorderMunicipalities.ts),
 *   - the sourced (absence of a) regime (AUSTRIAN_REGIME),
 *   - the per-locale URL for a Gemeinde (trailing-slash, 4 locales),
 *   - `isAustrianBorderMunicipalityPath()` — the O(1) membership check the
 *     Search Console 404 compat layer uses to self-map this family
 *     (build-plugins/searchConsoleCompat.ts). Both the above-floor page and
 *     the below-floor noindex bridge are emitted at the SAME URL, so every
 *     enumerated Gemeinde path (above OR below floor, any locale) self-maps.
 *
 * Kept in ONE module (mirroring germanBorderMunicipalityData.ts) so the
 * plugin (renderer), router and compat layer never drift on the path shape
 * or the slug set.
 *
 * Architectural note: this family deliberately follows the FISCAL/FRANCE page
 * pattern (self-contained module, `{ activeTab: 'vita', staticOverlay: true }`
 * routing with NO sub-tab, NO hubChrome, NO bespoke locale-rewrite in
 * services/router.ts's updatePathForLocale) rather than the Italian
 * borderMunicipalityPagesPlugin.ts pattern — same as France/Germany/Liechtenstein.
 *
 * Floor note: POPULATION-ONLY (>=5000), deliberately NOT population+distance
 * like Germany's — Nenzing (6,502 residents) sits 25.7km from the nearest
 * crossing over a roadless alpine ridge, and a distance-constrained floor
 * would incorrectly demote a genuinely border-touching comune. See
 * data/austrianBorderMunicipalities.ts's FLOOR note. AUSTRIAN_ABOVE_FLOOR
 * below is read as-is from the committed dataset — do not reintroduce a
 * distance gate here.
 */

import austrianDataset from '../data/austrian-border-municipalities.json';

export type AustrianLocale = 'it' | 'en' | 'de' | 'fr';
export const AUSTRIAN_LOCALES: readonly AustrianLocale[] = ['it', 'en', 'de', 'fr'] as const;

export type AustrianBezirk = 'Bregenz' | 'Dornbirn' | 'Feldkirch' | 'Bludenz' | 'Landeck';
export type AustrianLand = 'Vorarlberg' | 'Tirol';

export interface AustrianBorderMunicipality {
  name: string;
  slug: string;
  gkz: string;
  bezirk: AustrianBezirk;
  land: AustrianLand;
  lat: number;
  lng: number;
  population: number;
  populationDate: string;
  /** OSRM road-routing distance to the nearest crossing — informational
   *  metadata only, NOT part of the floor gate (see FLOOR note above). */
  distanceKm: number;
  nearestCrossing: string;
  /** Swiss canton of the nearest crossing — geographic only, not a fiscal
   *  driver (there is no per-canton regime split: there is no regime at all,
   *  see AUSTRIAN_REGIME). */
  canton: 'SG' | 'GR';
  regime: 'no-regime-frontalieri-art15';
}

interface AustrianDatasetShape {
  source: string;
  year: number;
  floor: Record<string, unknown>;
  regime: { value: string; note: string };
  aboveFloor: AustrianBorderMunicipality[];
  belowFloor: AustrianBorderMunicipality[];
}

const DATASET = austrianDataset as AustrianDatasetShape;

export const AUSTRIAN_SOURCE = DATASET.source;
export const AUSTRIAN_YEAR = DATASET.year;
export const AUSTRIAN_ABOVE_FLOOR: readonly AustrianBorderMunicipality[] = DATASET.aboveFloor;
export const AUSTRIAN_BELOW_FLOOR: readonly AustrianBorderMunicipality[] = DATASET.belowFloor;

/**
 * The (absent) Austria-Switzerland frontalieri regime. Sourced 2026-07-29
 * from SR 0.672.916.31 (RIS Austria, consolidated treaty text), BGBl. III
 * Nr. 22/2007 (abrogation), and the Swiss Federal Council report to
 * Parliament 2013-11-15 (Postulato Robbiani 11.3607) — see
 * /Users/saggesel/.claude/jobs/acadf57f/tmp/at-research.md for the full
 * sourcing and data/austrianBorderMunicipalities.ts's "REGIME" header.
 *
 * Every `has*`/`is*` flag below is `false` DELIBERATELY: this object exists
 * so no page copy or test can silently reuse a German-shaped figure (4.5%
 * cap, 60-day non-return threshold) for Austria. A reader coming from the
 * German or Liechtenstein corridor pages would wrongly assume one of those
 * applies here — the page copy must actively deny it, not merely omit it.
 *
 * Deliberately NOT included here (unverified / not officially anchored, see
 * the research doc's "NOT pubblicabile" section):
 *   - a frontalieri worker COUNT for Austria (only an unverified secondary
 *     estimate exists, ~9,000, mysalario.ch, no official anchor) — must
 *     never appear in emitted page copy;
 *   - a bilateral fiscal telework agreement (only the general EU/EFTA
 *     SOCIAL-SECURITY threshold below is sourced; no fiscal telework treaty
 *     was found — absence of evidence, not proof of absence).
 */
export const AUSTRIAN_REGIME = {
  /** No special frontalieri regime exists at all — abrogated. */
  hasSpecialRegime: false as const,
  /** Year the abrogation took legal effect (BGBl. III Nr. 22/2007 states
   *  "aufgehoben" retroactive to this date). */
  abrogatedEffectiveYear: 2006,
  /** Year the abrogating protocol was published in the Austrian federal
   *  law gazette. */
  abrogatedPublishedYear: 2007,
  /** No reduced/capped Quellensteuer rate — ordinary Art. 15 §1 full
   *  cantonal tariff applies, same as any non-frontalieri worker. */
  hasReducedRate: false as const,
  /** No defined border zone: Art. 15 §1 applies to any Austria-resident
   *  working in Switzerland regardless of distance from the border. */
  hasBorderZoneRestriction: false as const,
  /** No non-return-days threshold — there is no frontalieri status to
   *  lose. Only the general OECD short-stay exception exists (below), which
   *  is unrelated and must NOT be presented as a frontalieri rule. */
  hasNonReturnThreshold: false as const,
  /** General OECD short-stay exception (Art. 15 §2) — NOT a frontalieri
   *  non-return threshold. Applies to short missions, unrelated to
   *  cross-border-commuter status. */
  oecdShortStayThresholdDays: 183,
  /** Austria relieves double taxation via the credit method, not the
   *  exemption method it uses as its general rule (Art. 23 §2). */
  creditMethod: 'Anrechnungsmethode' as const,
  /** Swiss cantons collectively pay Austria's treasury this share of the
   *  Quellensteuer revenue raised under Art. 15 §1 (inter-state
   *  compensation in lieu of an individual relief, Final Protocol point 4). */
  interStateCompensationRate: 0.125,
  /** EU/EFTA multilateral telework social-security threshold (Art. 16(1)
   *  Reg. 883/2004): below this share of working time performed from the
   *  residence state, the worker stays insured in the state of the
   *  employer. Both Austria and Switzerland are signatories, effective
   *  2023-07-01. This is a SOCIAL-SECURITY rule, not a fiscal one — no
   *  bilateral fiscal telework agreement was found. */
  teleworkSocialSecurityThreshold: 0.499,
  teleworkFrameworkEffectiveDate: '2023-07-01',
  source:
    'SR 0.672.916.31 (RIS Austria, consolidato); BGBl. III Nr. 22/2007 (abrogazione art. 15 §4); rapporto del Consiglio federale svizzero al Parlamento, 15.11.2013 (Postulato Robbiani 11.3607); accordo quadro UE-EFTA ex art. 16(1) Reg. 883/2004 (telelavoro, AT e CH firmatari dal 2023-07-01).',
};

/** Per-locale base path (NO trailing municipality slug, NO trailing slash). */
export const AUSTRIAN_BASE_PATH: Record<AustrianLocale, string> = {
  it: '/vivere-in-austria-lavorare-in-svizzera',
  en: '/en/living-in-austria-working-in-switzerland',
  de: '/de/leben-in-osterreich-arbeiten-in-der-schweiz',
  fr: '/fr/vivre-en-autriche-travailler-en-suisse',
};

/** Canonical hub path per locale (index of the AT border-municipality family). */
export const AUSTRIAN_HUB_PATH: Record<AustrianLocale, string> = {
  it: `${AUSTRIAN_BASE_PATH.it}/`,
  en: `${AUSTRIAN_BASE_PATH.en}/`,
  de: `${AUSTRIAN_BASE_PATH.de}/`,
  fr: `${AUSTRIAN_BASE_PATH.fr}/`,
};

/** Trailing-slash URL for a Gemeinde's page in a locale. */
export function austrianMunicipalityPathFor(locale: AustrianLocale, slug: string): string {
  return `${AUSTRIAN_BASE_PATH[locale]}/${slug}/`;
}

function normalizePath(input: string): string {
  const p = (input || '').split('?')[0].split('#')[0];
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Precomputed Set of every emitted Gemeinde path (above + below floor × 4
 * locales), built ONCE at module load. Keeps `isAustrianBorderMunicipalityPath`
 * O(1) inside the 150k+-path loop of tests/search-console-compat.test.ts —
 * same rationale as the other self-mappable families in searchConsoleCompat.ts.
 */
const AUSTRIAN_PATH_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const m of [...AUSTRIAN_ABOVE_FLOOR, ...AUSTRIAN_BELOW_FLOOR]) {
    for (const locale of AUSTRIAN_LOCALES) set.add(austrianMunicipalityPathFor(locale, m.slug));
  }
  return set;
})();

/** True for any emitted AT border-municipality URL (above-floor page OR
 *  below-floor bridge, any locale). Used by the Search Console 404 compat self-map. */
export function isAustrianBorderMunicipalityPath(inputPath: string): boolean {
  return AUSTRIAN_PATH_SET.has(normalizePath(inputPath));
}

/**
 * Reverse index (path → locale + slug) for the per-Gemeinde detail/bridge
 * pages, used by services/router.ts to recognise the URL at hydration time
 * and recover the locale without re-parsing the path shape. Same membership
 * as AUSTRIAN_PATH_SET/isAustrianBorderMunicipalityPath above (above + below floor).
 */
const AUSTRIAN_DETAIL_INDEX: ReadonlyMap<string, { locale: AustrianLocale; slug: string }> = (() => {
  const map = new Map<string, { locale: AustrianLocale; slug: string }>();
  for (const m of [...AUSTRIAN_ABOVE_FLOOR, ...AUSTRIAN_BELOW_FLOOR]) {
    for (const locale of AUSTRIAN_LOCALES) {
      map.set(normalizePath(austrianMunicipalityPathFor(locale, m.slug)), { locale, slug: m.slug });
    }
  }
  return map;
})();

export function parseAustrianBorderMunicipalityPath(inputPath: string): { locale: AustrianLocale; slug: string } | null {
  return AUSTRIAN_DETAIL_INDEX.get(normalizePath(inputPath)) ?? null;
}

/** Reverse index (path → locale) for the hub/index page, one per locale. */
const AUSTRIAN_HUB_INDEX: ReadonlyMap<string, AustrianLocale> = new Map(
  AUSTRIAN_LOCALES.map((l) => [normalizePath(AUSTRIAN_HUB_PATH[l]), l]),
);

export function isAustrianBorderMunicipalityHubPath(inputPath: string): boolean {
  return AUSTRIAN_HUB_INDEX.has(normalizePath(inputPath));
}

export function parseAustrianBorderMunicipalityHubPath(inputPath: string): { locale: AustrianLocale } | null {
  const found = AUSTRIAN_HUB_INDEX.get(normalizePath(inputPath));
  return found ? { locale: found } : null;
}
