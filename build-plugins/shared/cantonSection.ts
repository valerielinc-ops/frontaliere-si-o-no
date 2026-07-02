import cantonSlugFile from '../../data/canton-url-slugs.json';
import municipalitiesFile from '../../data/canton-municipalities.json';
import {
  createCantonResolvers,
  AGGREGATE_KEY as CORE_AGGREGATE_KEY,
  SECTION_LEGACY_TI,
} from './cantonResolvers.mjs';

export type CantonLocale = 'it' | 'en' | 'de' | 'fr';
export const AGGREGATE_KEY = CORE_AGGREGATE_KEY;

// The resolver logic itself lives in the runtime-agnostic single source of
// truth `cantonResolvers.mjs`, so the raw-`node` migration script
// `scripts/migrate-all-known-job-slugs-canton-aware.mjs` shares the EXACT same
// canton-section logic without a hand-mirrored copy that could drift (#1890).
// This file is the typed Vite/build-plugin shim: it feeds the statically
// imported JSON into the resolvers and re-exports them with precise signatures.
// Same pattern as `viteAssetHashRx.ts`.
const resolvers = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

export function resolveCantonGroup(cantonCode: string): string {
  return resolvers.resolveCantonGroup(cantonCode);
}

export function resolveCantonSection(locale: CantonLocale, cantonCode: string): string {
  return resolvers.resolveCantonSection(locale, cantonCode);
}

/**
 * Build the absolute SPA-prefixed root path for the legacy TI job-board hub
 * in a given locale. Returns e.g. `/cerca-lavoro-ticino` (IT) or
 * `/en/find-jobs-ticino` (EN). Use this when a caller would otherwise
 * inline the ternary
 * `locale === 'en' ? 'find-jobs-ticino' : locale === 'de' ? 'jobs-im-tessin' : ...`
 * — the literal slugs stay encapsulated here, so other build-plugin files
 * never carry the TI hardcodes (and never trip
 * `tests/seo/cathedral-no-ti-hardcodes.test.ts`).
 *
 * For canton-aware paths (everything except TI), use `resolveCantonSection`.
 */
export function legacyTiSectionRoot(locale: CantonLocale): string {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${SECTION_LEGACY_TI[locale]}`;
}

export function resolveJobCanton(job: { canton?: string; location?: string }): string {
  return resolvers.resolveJobCanton(job);
}

export const ALL_CANTON_CODES: readonly string[] = resolvers.ALL_CANTON_CODES;

// `/{section}/azienda-{slug}/` (and per-locale equivalents) is the RESERVED
// company-hub namespace. tests/seo/cathedral-sector-hubs.test.ts requires every
// entry under the TI legacy section to self-canonicalize to TI (or the
// Switzerland aggregator) — never a foreign-canton canonical. Any plugin that
// mirrors a job/orphan slug into that namespace must skip slugs that merely
// *start with* this prefix (e.g. a Vaud job once titled "Azienda di
// consulenza…") or it reintroduces issue #2976 (recurred as a 5th, unguarded
// call site in jobOrphanBridgePlugin.ts — PR validate-dist-structural-reliability
// follow-up). Single source of truth so every emitter shares one definition.
export const COMPANY_ROUTE_PREFIX: Record<CantonLocale, string> = {
  it: 'azienda',
  en: 'company',
  de: 'unternehmen',
  fr: 'entreprise',
};

export function isCompanyHubNamespaceSlug(slug: string, locale: CantonLocale): boolean {
  return slug.startsWith(`${COMPANY_ROUTE_PREFIX[locale]}-`);
}
