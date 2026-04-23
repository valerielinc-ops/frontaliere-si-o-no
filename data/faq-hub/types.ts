/**
 * Types for the 100-Q&A FAQ hub (AE-5).
 *
 * 10 categories × 10 entries × 4 locales = 400 unique Q&A pairs.
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
  href: string;
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
