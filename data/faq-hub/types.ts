/**
 * Types for the FAQ hub (AE-5).
 *
 * 10 categories, ~10 entries each, translated into 4 locales. Per-category
 * counts may grow past 10 as content is added — see data/faq-hub/index.ts.
 * Each entry lives in data/faq-hub/category-<name>.ts and is aggregated
 * by data/faq-hub/index.ts into ALL_FAQ_HUB.
 */

export type FaqHubCategory =
  | 'fisco'
  | 'lamal'
  | 'permessi'
  | 'avs-lpp'
  | 'stipendi'
  | 'trasporti'
  | 'lavoro'
  | 'vita-quotidiana'
  | 'famiglia'
  | 'diritti';

export type FaqHubLocale = 'it' | 'en' | 'de' | 'fr';

export type FaqHubLocalizedString = Readonly<Record<FaqHubLocale, string>>;

export type FaqHubRelatedLink = Readonly<{
  /**
   * Target path. Plain `string` when the destination route is identical
   * across locales (e.g. a tool page with no localized slug). Use the
   * `Record<locale, path>` form whenever the target has a locale-specific
   * slug (e.g. evergreen articles under `/guida-frontaliere/<slug>/` vs
   * `/en/cross-border-guide/<slug>/`) — never hardcode a single locale's
   * path and reuse it verbatim across all 4 locale renders.
   */
  href: string | FaqHubLocalizedString;
  label: FaqHubLocalizedString;
}>;

/**
 * A single FAQ hub entry.
 *
 * - `id`: kebab-case stable slug, unique sitewide (used as DOM id anchor).
 * - `question` / `answer`: 4 locales, faithful translations.
 *   Answer bodies are 80-180 words per locale, with authoritative sources
 *   cited inline (AFC, AVS/UFAS, SEM, SECO, INPS, Accordo CH-IT 17/07/2023,
 *   LAMal, CO, UFSP, Fedlex).
 * - `relatedLinks`: 1-3 internal links into existing hub/landing pages.
 * - `sources`: flat list of URLs cited in the answer across all locales.
 */
export type FaqHubEntry = Readonly<{
  id: string;
  category: FaqHubCategory;
  question: FaqHubLocalizedString;
  /**
   * Short form used ONLY for the `<title>` tag of the per-question page, when
   * the question itself exceeds the 66-char budget `audit:title-length`
   * enforces.
   *
   * Deliberately NOT a full `FaqHubLocalizedString`: question length varies by
   * language (a German compound blows the budget where the English does not),
   * so this is per-locale optional and only the locales that actually overflow
   * carry an entry. Every other surface — `<h1>`, the FAQPage JSON-LD `name`,
   * the hub cards, the OG tags — keeps the question verbatim, because the
   * long-tail natural-language phrasing is the whole point of the FAQ hub
   * (#5008) and must not be shortened for a title-tag budget.
   *
   * `build-plugins/shared/titleSuffix.ts` forbids mid-headline `…` truncation:
   * a short form is authored copy, never a machine-clipped question.
   */
  titleShort?: Readonly<Partial<Record<FaqHubLocale, string>>>;
  answer: FaqHubLocalizedString;
  relatedLinks?: ReadonlyArray<FaqHubRelatedLink>;
  sources?: ReadonlyArray<string>;
}>;

export const FAQ_HUB_CATEGORIES: ReadonlyArray<FaqHubCategory> = [
  'avs-lpp',
  'diritti',
  'famiglia',
  'fisco',
  'lamal',
  'lavoro',
  'permessi',
  'stipendi',
  'trasporti',
  'vita-quotidiana',
] as const;

export const FAQ_HUB_LOCALES: ReadonlyArray<FaqHubLocale> = ['it', 'en', 'de', 'fr'] as const;
