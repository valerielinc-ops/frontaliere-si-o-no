/**
 * ctrBoostDescription.ts — additive-only meta-description CTR lever for blog
 * articles (issue #4300 plan item 2, "articoli-frontaliere" family).
 *
 * Blog article `<title>`/`<h1>`/headline structured data cannot be touched:
 * Google News Publisher Center requires them to match verbatim (see the
 * `buildTitleWithBrand` comment block in `ogPagesPlugin.ts`). The meta
 * description has no such constraint, so it is the only build-time-safe CTR
 * lever for this template family.
 *
 * Deliberately conservative to avoid the risk flagged for issue #4300 —
 * disturbing description text on articles that are already ranking/
 * converting well. This function NEVER rewrites or removes existing
 * description text; it only APPENDS a short, mechanically generated
 * freshness/year marker, and only when:
 *   1. the description does not already contain a 4-digit year (many
 *      article excerpts already do — those are left untouched), and
 *   2. there is room left inside the shared meta-description budget
 *      ({@link META_DESCRIPTION_MAX_CHARS} from `./titleSuffix`) so the
 *      append itself never forces an unsafe/ugly downstream truncation.
 *
 * This mirrors the "dynamic year/number" lever named in the issue without
 * inventing per-article facts that aren't already in the source content.
 */

import { META_DESCRIPTION_MAX_CHARS } from './titleSuffix';

export type CtrBoostLocale = 'it' | 'en' | 'de' | 'fr';

const YEAR_RE = /\b20\d{2}\b/;

const YEAR_SUFFIX: Record<CtrBoostLocale, (year: number) => string> = {
  it: (year) => ` Aggiornato ${year}.`,
  en: (year) => ` Updated for ${year}.`,
  de: (year) => ` Aktualisiert ${year}.`,
  fr: (year) => ` Mis à jour ${year}.`,
};

/**
 * Append a short "updated <year>" marker to `description` when it lacks a
 * year signal and there is room within `maxLength`. Returns `description`
 * unchanged otherwise (empty input, year already present, or no room).
 */
export function boostDescriptionForCtr(
  description: string,
  locale: CtrBoostLocale,
  opts: { year?: number; maxLength?: number } = {},
): string {
  if (!description) return description;
  if (YEAR_RE.test(description)) return description;

  const year = opts.year ?? new Date().getFullYear();
  const maxLength = opts.maxLength ?? META_DESCRIPTION_MAX_CHARS;
  const suffix = YEAR_SUFFIX[locale](year);

  if (description.length + suffix.length > maxLength) return description;
  return `${description}${suffix}`;
}
