/**
 * jobBoardSlugs.ts — canton job-board URL slugs: the one table, and the three
 * functions that read it.
 *
 * Extracted out of `services/router.ts` (issue #7174). The slug↔canton mapping
 * is the only thing several non-SPA consumers need — `scripts/lib/seo-ctr-curve.mjs`
 * classifies a discovered GSC path segment with it — and importing the router
 * to get it pulls the entire SPA + build-plugin graph (i18n, every municipality
 * dataset, every SSG route module) into a weekly CI script: slow, and one
 * module-level throw anywhere in that graph away from killing the monitor.
 * Copying the prefix table into the script instead would be the duplication
 * AGENTS.md #6 forbids — the DE `dePrefix` override and the legacy `jobs-im-tessin`
 * branch are exactly the kind of rule that drifts once it exists twice.
 *
 * So: one leaf module, two imports (the slug JSON and the canton-group
 * normaliser), no SPA dependencies. `services/router.ts` re-exports every
 * symbol below, so existing callers are unchanged.
 */
import CANTON_URL_SLUGS_RAW from '../data/canton-url-slugs.json';
import { resolveCantonGroup, type CantonLocale as Locale } from './cantonList';

interface CantonSlugRecord {
 it: string;
 en: string;
 de: string;
 fr: string;
 /**
  * Optional German prefix override for cantons whose name takes a
  * definite article in German (e.g. `'jobs-im-'` for AG/TG/JU/VS,
  * `'jobs-in-der-'` for VD). When set, replaces the default `JOB_BOARD_PREFIX.de`
  * for that canton only. TI stays special-cased via {@link JOB_BOARD_PREFIX_LEGACY_DE}.
  */
 dePrefix?: string;
}
interface CantonGroupRecord {
 members: readonly string[];
}
interface CantonUrlSlugsFile {
 cantons: Record<string, CantonSlugRecord>;
 cantonGroups?: Record<string, CantonGroupRecord>;
 aggregate: CantonSlugRecord;
}
export const CANTON_URL_SLUGS = CANTON_URL_SLUGS_RAW as unknown as CantonUrlSlugsFile;

/** Reserved sentinel for the Switzerland-wide aggregator route. */
export const JOB_BOARD_CANTON_AGGREGATE = '_AGGREGATE_';

/**
 * Job-board URL prefixes per locale. The DE prefix has TWO accepted
 * forms: the legacy `jobs-im-` (only for `tessin` — the article "im"
 * grammatically attaches to Tessin), and the canonical new-canton form
 * `jobs-in-` for everything else. Both parse to the same `jobBoardCanton`.
 */
const JOB_BOARD_PREFIX: Record<Locale, string> = {
 it: 'cerca-lavoro-',
 en: 'find-jobs-',
 de: 'jobs-in-',
 fr: 'trouver-emploi-',
};
const JOB_BOARD_PREFIX_LEGACY_DE = 'jobs-im-'; // legacy TI-only

/**
 * Build the canonical job-board URL slug for a given canton + locale.
 *
 * For Ticino, returns the same slug as `SLUG_TABLES[locale].jobBoard`,
 * preserving backward compatibility (`cerca-lavoro-ticino`,
 * `find-jobs-ticino`, `jobs-im-tessin`, `trouver-emploi-tessin`).
 *
 * For all other cantons, returns `${prefix}${cantonSlug}` using the
 * locale-specific anglicized/native canton slug from
 * `data/canton-url-slugs.json` (e.g. `ZH` + `it` → `cerca-lavoro-zurigo`,
 * `GE` + `de` → `jobs-in-genf`).
 *
 * @param cantonCode - 2-letter canton ISO code (uppercase, e.g. `'ZH'`).
 * @param locale - SPA locale (`'it' | 'en' | 'de' | 'fr'`).
 * @returns The full top-level URL segment (no leading slash).
 * @throws Never — falls back to the legacy TI slug on unknown input so
 *         callers always get a routable string.
 */
export function getJobBoardSlugForCanton(cantonCode: string, locale: Locale): string {
 // Legacy parity: TI in DE keeps the `jobs-im-tessin` form.
 if (cantonCode === 'TI' && locale === 'de') {
   return `${JOB_BOARD_PREFIX_LEGACY_DE}tessin`;
 }
 // Half-canton merge: callers may pass a real BFS code (e.g. 'AI', 'BS')
 // — collapse onto the URL group key before looking up the slug record.
 const urlKey = resolveCantonGroup(cantonCode);
 const record = CANTON_URL_SLUGS.cantons[urlKey];
 if (!record) {
   // Unknown canton: degrade gracefully to the legacy Ticino slug. Caller
   // can detect & log; we never throw out of a router helper.
   return `${JOB_BOARD_PREFIX[locale]}ticino`;
 }
 // German preposition override: cantons whose name takes a definite article
 // in German (im Aargau, im Thurgau, im Jura, im Wallis, in der Waadt) get
 // a per-canton dePrefix instead of the bare `jobs-in-`. Grammatically
 // accurate URLs help Google rank cantonal queries in DE.
 if (locale === 'de' && record.dePrefix) {
   return `${record.dePrefix}${record[locale]}`;
 }
 return `${JOB_BOARD_PREFIX[locale]}${record[locale]}`;
}

/**
 * Build the Switzerland-wide aggregator job-board URL slug.
 *
 * @example getAggregatorJobBoardSlug('it') → 'cerca-lavoro-svizzera'
 * @example getAggregatorJobBoardSlug('en') → 'find-jobs-switzerland'
 * @example getAggregatorJobBoardSlug('de') → 'jobs-in-schweiz'
 * @example getAggregatorJobBoardSlug('fr') → 'trouver-emploi-suisse'
 */
export function getAggregatorJobBoardSlug(locale: Locale): string {
 return `${JOB_BOARD_PREFIX[locale]}${CANTON_URL_SLUGS.aggregate[locale]}`;
}

/**
 * Parse the first URL segment as a per-canton job-board slug.
 *
 * Recognised inputs (per locale):
 *   - `cerca-lavoro-{cantonSlug}` / `find-jobs-…` / `jobs-in-…` / `trouver-emploi-…`
 *   - The legacy DE form `jobs-im-tessin` (returns `cantonCode: 'TI'`).
 *   - The aggregator slug (`cerca-lavoro-svizzera`, …) → `isAggregator: true`,
 *     `cantonCode: '_AGGREGATE_'`.
 *
 * Does NOT match the legacy table-driven `table.jobBoard` slug for TI —
 * callers must continue to check `first === table.jobBoard` first to
 * preserve every pre-P1.3 URL (the legacy branch handles
 * `cerca-lavoro-ticino` etc. with the existing city/sector/jobSlug logic).
 *
 * @param pathSegment - First non-empty path segment after the locale prefix.
 * @param locale - SPA locale.
 * @returns `{ cantonCode, isAggregator }` on match, or `null` if the
 *          segment is not a recognised job-board slug.
 */
export function parseJobBoardSlug(
 pathSegment: string,
 locale: Locale,
): { cantonCode: string; isAggregator: boolean } | null {
 if (!pathSegment) return null;

 // Aggregator (Switzerland-wide) — check first so the prefix walk below
 // doesn't match the per-canton form by accident.
 if (pathSegment === getAggregatorJobBoardSlug(locale)) {
   return { cantonCode: JOB_BOARD_CANTON_AGGREGATE, isAggregator: true };
 }

 // Legacy DE Tessin form.
 if (locale === 'de' && pathSegment === `${JOB_BOARD_PREFIX_LEGACY_DE}tessin`) {
   return { cantonCode: 'TI', isAggregator: false };
 }

 // German per-canton dePrefix overrides (jobs-im-aargau, jobs-im-thurgau,
 // jobs-im-jura, jobs-im-wallis, jobs-in-der-waadt). Check before the
 // default JOB_BOARD_PREFIX walk so e.g. `jobs-in-der-waadt` doesn't get
 // misparsed via the bare `jobs-in-` prefix.
 if (locale === 'de') {
   for (const [code, record] of Object.entries(CANTON_URL_SLUGS.cantons)) {
     if (record.dePrefix && pathSegment === `${record.dePrefix}${record.de}`) {
       return { cantonCode: code, isAggregator: false };
     }
   }
 }

 const prefix = JOB_BOARD_PREFIX[locale];
 if (!pathSegment.startsWith(prefix)) return null;
 const tail = pathSegment.slice(prefix.length);
 if (!tail) return null;

 for (const [code, record] of Object.entries(CANTON_URL_SLUGS.cantons)) {
   if (record[locale] === tail) {
     return { cantonCode: code, isAggregator: false };
   }
 }
 return null;
}
