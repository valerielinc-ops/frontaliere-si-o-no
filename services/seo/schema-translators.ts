// Central dispatcher for JSON-LD structured-data localization.
// Each schema @type is handled by a registered translator function that
// mutates the clone in place to produce locale-appropriate text.
//
// Extension: import a new translator module in the `// ── Translator registrations ──`
// block below and add an entry to the `REGISTRY` record. The dispatcher is
// invoked from both the runtime path (seoService.ts) and the build-time
// path (staticPagesPlugin.ts) so every registered type is localized in both
// SPA hydration and the pre-rendered static HTML.
//
// Translator contract:
//   - Mutates the object in place (caller passes a clone).
//   - If a field has no translation available, leave it untouched (silent
//     fallback to Italian is preferred over broken schema).
//   - Should also set `inLanguage` if present on the object.

import {
 translateClaimReview,
 translateDataset,
 translateOrganization,
 translateReview,
 translateWebApplication,
} from './entity-translations';
import { translateFaqPage } from './faq-translations';
import { translateHowToSchema } from './howto-translations';

export type SupportedLocale = 'en' | 'de' | 'fr';

export type SchemaTranslator = (obj: Record<string, any>, locale: SupportedLocale) => void;

// ── Translator registrations ─────────────────────────────────────────────
// Keep this block alphabetized by @type. Each entry: one line.
const REGISTRY: Record<string, SchemaTranslator> = {
 ClaimReview: translateClaimReview,
 Dataset: translateDataset,
 FAQPage: translateFaqPage,
 HowTo: translateHowToSchema,
 Organization: translateOrganization,
 Review: translateReview,
 WebApplication: translateWebApplication,
};

/**
 * Look up a translator for a given @type. Returns undefined if none
 * registered. Exposed for tests.
 */
export function getSchemaTranslator(type: string): SchemaTranslator | undefined {
 return REGISTRY[type];
}

/**
 * Translate a JSON-LD object in place for the given locale.
 * No-op when the object is not a plain object, when @type is missing,
 * or when no translator is registered for that @type.
 */
export function translateSchema(obj: unknown, locale: SupportedLocale): void {
 if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
 const record = obj as Record<string, any>;
 const type = record['@type'];
 if (typeof type !== 'string') return;
 const fn = REGISTRY[type];
 if (fn) fn(record, locale);
}

/**
 * Returns the list of @type strings currently handled by the registry.
 * Exposed for tests and coverage diagnostics.
 */
export function listSupportedSchemaTypes(): string[] {
 return Object.keys(REGISTRY).sort();
}
