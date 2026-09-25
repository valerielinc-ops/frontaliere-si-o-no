// Article / NewsArticle / BlogPosting translations for structured data
// Maps Italian `headline` text → { en, de, fr } translations of headline, description,
// and (optionally) image caption. Used by schema-translators.ts to localize JSON-LD
// rendered on non-Italian locales.
//
// SCOPE NOTE (important):
// -----------------------
// This module only contains translations for the ~10 Italian Article entries in
// `services/seo/seo-pages.ts` (calendar, permits, vivere-in-svizzera, vivere-in-italia,
// valichi-di-frontiera, posti-da-visitare, scuole, disoccupazione, festivita,
// guida-completa-2026). Blog articles (`NewsArticle` entries under the `blog-*`
// keys in seo-pages.ts and in seo-blog*.ts) are intentionally NOT translated here:
//
//   • The blog pipeline is already multi-locale at the ROUTER + OG layer
//     (`/en/cross-border-articles`, `/de/grenzgaenger-artikel`, `/fr/articles-frontalier`).
//   • `services/seoService.ts` already mutates `headline` / `description` / `image.caption`
//     on blog structuredData using the locale-resolved OG title + excerpt + image alt
//     pulled from the blog content source (see `isBlogArticle` branch). Duplicating
//     those headlines here would override per-article translations with a weaker fallback.
//
// For that reason the blog-posting translator defined below is a NO-OP for blog entries:
// a blog schema reaches the dispatcher AFTER the seoService OG pass has already set the
// locale-specific text, so any un-keyed headline simply falls back to the Italian source,
// which is the correct behaviour here.

export interface ArticleTranslation {
 headline: string;
 description: string;
 imageCaption?: string;
}

export type ArticleLocaleMap = Record<
 string,
 { en: ArticleTranslation; de: ArticleTranslation; fr: ArticleTranslation }
>;

/**
 * Lookup map: Italian `headline` text (exact, trimmed) → { en, de, fr }.
 * Keys correspond to the `headline` field on Article JSON-LD in `services/seo/seo-pages.ts`.
 */
export const ARTICLE_TRANSLATIONS: ArticleLocaleMap = {
 // ── 1. calendar (scadenze fiscali) ──
 'Calendario Scadenze Fiscali 2026 per Frontalieri CH-IT': {
 en: {
 headline: '2026 Tax Deadline Calendar for CH-IT Cross-Border Workers',
 description:
 'All 2026 tax deadlines for cross-border workers: IRPEF, 730, withholding tax, AVS, with countdown and required documents.',
 },
 de: {
 headline: 'Steuerfristen-Kalender 2026 fuer CH-IT Grenzgaenger',
 description:
 'Alle Steuerfristen 2026 fuer Grenzgaenger: IRPEF, 730, Quellensteuer, AHV, mit Countdown und erforderlichen Unterlagen.',
 },
 fr: {
 headline: 'Calendrier des echeances fiscales 2026 pour frontaliers CH-IT',
 description:
 "Toutes les echeances fiscales 2026 pour frontaliers : IRPEF, 730, impot a la source, AVS, avec compte a rebours et documents requis.",
 },
 },

 // ── 2. permits (permessi di lavoro) ──
 'Permessi Lavoro Svizzera G, B, C, L - Guida Completa 2026': {
 en: {
 headline: 'Swiss Work Permits G, B, C, L - Complete 2026 Guide',
 description:
 'Complete guide to Swiss work permits: G (cross-border workers), B (residence), C (settlement), L (short-term).',
 },
 de: {
 headline: 'Schweizer Arbeitsbewilligungen G, B, C, L - Vollstaendiger Leitfaden 2026',
 description:
 'Vollstaendiger Leitfaden zu Schweizer Arbeitsbewilligungen: G (Grenzgaenger), B (Aufenthalt), C (Niederlassung), L (Kurzaufenthalt).',
 },
 fr: {
 headline: 'Permis de travail suisses G, B, C, L - Guide complet 2026',
 description:
 'Guide complet des permis de travail suisses : G (frontaliers), B (sejour), C (etablissement), L (courte duree).',
 },
 },

 // ── 3. vivere-in-svizzera ──
 'Vivere in Svizzera: Guida Completa per Frontalieri e Residenti': {
 en: {
 headline: 'Living in Switzerland: Complete Guide for Cross-Border Workers and Residents',
 description:
 'Everything about living in Switzerland: cost of living, rents, LAMal healthcare, schools and bureaucracy in Canton Ticino.',
 },
 de: {
 headline: 'Leben in der Schweiz: Vollstaendiger Leitfaden fuer Grenzgaenger und Einwohner',
 description:
 'Alles ueber das Leben in der Schweiz: Lebenshaltungskosten, Mieten, KVG-Krankenversicherung, Schulen und Buerokratie im Kanton Tessin.',
 },
 fr: {
 headline: 'Vivre en Suisse : guide complet pour frontaliers et residents',
 description:
 "Tout sur la vie en Suisse : cout de la vie, loyers, assurance maladie LAMal, ecoles et administration au Canton du Tessin.",
 },
 },

 // ── 4. vivere-in-italia ──
 'Vivere in Italia come Frontaliere: Vantaggi e Svantaggi': {
 en: {
 headline: 'Living in Italy as a Cross-Border Worker: Pros and Cons',
 description:
 'Pros and cons of living in Italy while working in Switzerland: costs, deductions, Italian SSN healthcare in border provinces.',
 },
 de: {
 headline: 'Leben in Italien als Grenzgaenger: Vor- und Nachteile',
 description:
 'Vor- und Nachteile des Lebens in Italien bei Arbeit in der Schweiz: Kosten, Abzuege, italienische SSN-Gesundheitsversorgung in den Grenzprovinzen.',
 },
 fr: {
 headline: 'Vivre en Italie en tant que frontalier : avantages et inconvenients',
 description:
 "Avantages et inconvenients de vivre en Italie tout en travaillant en Suisse : couts, deductions, assurance maladie SSN italienne dans les provinces frontalieres.",
 },
 },

 // ── 5. valichi-di-frontiera ──
 'Valichi di Frontiera Svizzera-Italia: Orari, Traffico e Percorsi': {
 en: {
 headline: 'Switzerland-Italy Border Crossings: Opening Hours, Traffic and Routes',
 description:
 'Complete guide to CH-IT border crossings: Chiasso, Ponte Tresa, Gaggiolo, Brogeda, Stabio, with opening hours and alternative routes.',
 },
 de: {
 headline: 'Schweiz-Italien-Grenzuebergaenge: Oeffnungszeiten, Verkehr und Routen',
 description:
 'Vollstaendiger Leitfaden zu den CH-IT-Grenzuebergaengen: Chiasso, Ponte Tresa, Gaggiolo, Brogeda, Stabio, mit Oeffnungszeiten und alternativen Routen.',
 },
 fr: {
 headline: 'Passages frontaliers Suisse-Italie : horaires, trafic et itineraires',
 description:
 "Guide complet des passages frontaliers CH-IT : Chiasso, Ponte Tresa, Gaggiolo, Brogeda, Stabio, avec horaires et itineraires alternatifs.",
 },
 },

 // ── 6. posti-da-visitare ──
 'Posti da Visitare in Ticino: Natura, Cultura e Attività': {
 en: {
 headline: 'Places to Visit in Ticino: Nature, Culture and Activities',
 description:
 'Guide to the most beautiful places in Canton Ticino: mountains, lakes, cities, culture and family-friendly activities.',
 },
 de: {
 headline: 'Sehenswuerdigkeiten im Tessin: Natur, Kultur und Aktivitaeten',
 description:
 'Leitfaden zu den schoensten Orten im Kanton Tessin: Berge, Seen, Staedte, Kultur und familienfreundliche Aktivitaeten.',
 },
 fr: {
 headline: 'Lieux a visiter au Tessin : nature, culture et activites',
 description:
 "Guide des plus beaux lieux du Canton du Tessin : montagnes, lacs, villes, culture et activites pour les familles.",
 },
 },

 // ── 7. scuole ──
 'Scuole in Ticino per Frontalieri: dalla Materna al Liceo': {
 en: {
 headline: 'Schools in Ticino for Cross-Border Workers: from Kindergarten to High School',
 description:
 'Complete guide to schools in Canton Ticino for cross-border workers: nursery, kindergarten, primary, middle and high school, with costs and schedules.',
 },
 de: {
 headline: 'Schulen im Tessin fuer Grenzgaenger: vom Kindergarten bis zum Gymnasium',
 description:
 'Vollstaendiger Leitfaden zu den Schulen im Kanton Tessin fuer Grenzgaenger: Krippe, Kindergarten, Primar-, Sekundar- und Mittelschule, mit Kosten und Zeitplaenen.',
 },
 fr: {
 headline: 'Ecoles au Tessin pour frontaliers : de la maternelle au lycee',
 description:
 "Guide complet des ecoles du Canton du Tessin pour frontaliers : creche, maternelle, primaire, secondaire et lycee, avec couts et horaires.",
 },
 },

 // ── 8. disoccupazione ──
 'Disoccupazione Frontalieri: NASpI Italia e AD Svizzera': {
 en: {
 headline: 'Unemployment for Cross-Border Workers: NASpI Italy and AD Switzerland',
 description:
 'Complete guide to unemployment for cross-border workers: NASpI, AD/ALV, PD U1 form, amounts and step-by-step procedures.',
 },
 de: {
 headline: 'Arbeitslosigkeit fuer Grenzgaenger: NASpI Italien und ALV Schweiz',
 description:
 'Vollstaendiger Leitfaden zur Arbeitslosigkeit fuer Grenzgaenger: NASpI, AD/ALV, Formular PD U1, Betraege und Schritt-fuer-Schritt-Verfahren.',
 },
 fr: {
 headline: 'Chomage pour frontaliers : NASpI Italie et AC Suisse',
 description:
 "Guide complet du chomage pour frontaliers : NASpI, AD/AC, formulaire PD U1, montants et procedures etape par etape.",
 },
 },

 // ── 9. festivita ──
 'Festività Ticino 2026: Tutti i Giorni Festivi del Canton Ticino': {
 en: {
 headline: 'Ticino Public Holidays 2026: All Public Holidays of Canton Ticino',
 description:
 'Ticino public holidays 2026: all 15 official public holidays of Canton Ticino, cantonal and federal holidays, long weekends and comparison with Italy.',
 },
 de: {
 headline: 'Tessiner Feiertage 2026: alle Feiertage des Kantons Tessin',
 description:
 'Tessiner Feiertage 2026: alle 15 offiziellen Feiertage des Kantons Tessin, kantonale und eidgenoessische Feiertage, Brueckentage und Vergleich mit Italien.',
 },
 fr: {
 headline: 'Jours feries au Tessin 2026 : tous les jours feries du Canton du Tessin',
 description:
 "Jours feries au Tessin 2026 : les 15 jours feries officiels du Canton du Tessin, feries cantonaux et federaux, ponts et comparaison avec l'Italie.",
 },
 },

 // ── 10. guida-completa-2026 ──
 'Guida Completa al Lavoro Frontaliere in Svizzera 2026': {
 en: {
 headline: 'Complete Guide to Cross-Border Work in Switzerland 2026',
 description:
 'The definitive guide for Italy-Switzerland cross-border workers: G permit, new tax agreement, AVS/LPP social contributions, LAMal insurance, commuting and tax return. Updated for 2026.',
 },
 de: {
 headline: 'Vollstaendiger Leitfaden zur Grenzgaengerarbeit in der Schweiz 2026',
 description:
 'Der massgebliche Leitfaden fuer Italien-Schweiz-Grenzgaenger: G-Bewilligung, neues Steuerabkommen, Sozialbeitraege AHV/BVG, KVG-Versicherung, Pendeln und Steuererklaerung. Aktualisiert fuer 2026.',
 },
 fr: {
 headline: 'Guide complet du travail frontalier en Suisse 2026',
 description:
 "Le guide de reference pour les frontaliers Italie-Suisse : permis G, nouvel accord fiscal, cotisations sociales AVS/LPP, assurance LAMal, pendulaires et declaration de revenus. Mis a jour pour 2026.",
 },
 },
};

/**
 * Look up an Article translation by Italian `headline` text.
 * Returns undefined if no translation exists for the given headline.
 */
export function getArticleTranslation(
 italianHeadline: string,
 locale: 'en' | 'de' | 'fr'
): ArticleTranslation | undefined {
 const entry = ARTICLE_TRANSLATIONS[italianHeadline];
 return entry?.[locale];
}

type TranslatableArticleSchema = Record<string, unknown> & {
 headline?: unknown;
 description?: unknown;
 image?: unknown;
 inLanguage?: unknown;
};

/**
 * Shared helper that applies an ArticleTranslation to a schema object in place.
 * If no translation exists for the Italian headline the schema is left unchanged
 * (silent fallback). The `inLanguage` field is always updated to the target locale
 * when the schema is non-empty, even if a translation is missing, to keep the
 * served JSON-LD consistent with the rendered page.
 */
function applyArticleTranslation(
 schema: TranslatableArticleSchema,
 locale: 'en' | 'de' | 'fr'
): void {
 if (!schema || typeof schema !== 'object') return;

 // Always tag the inLanguage to the current locale, even if we can't translate
 // the narrative fields — this matches what seoService does for non-article schema.
 schema.inLanguage = locale;

 if (typeof schema.headline !== 'string') return;
 const translation = getArticleTranslation(schema.headline, locale);
 if (!translation) return;

 schema.headline = translation.headline;
 schema.description = translation.description;

 if (
 translation.imageCaption &&
 schema.image &&
 typeof schema.image === 'object' &&
 !Array.isArray(schema.image)
 ) {
 (schema.image as Record<string, unknown>).caption = translation.imageCaption;
 }
}

/**
 * Translate an Article structured-data object in place. No-op on missing translation.
 */
export function translateArticleSchema(
 schema: Record<string, unknown>,
 locale: 'en' | 'de' | 'fr'
): void {
 applyArticleTranslation(schema as TranslatableArticleSchema, locale);
}

/**
 * Translate a NewsArticle structured-data object in place. No-op on missing translation.
 * Blog entries (44 NewsArticles under `blog-*` keys) intentionally have no entries in
 * ARTICLE_TRANSLATIONS — the seoService OG pass already localized them per-article.
 */
export function translateNewsArticleSchema(
 schema: Record<string, unknown>,
 locale: 'en' | 'de' | 'fr'
): void {
 applyArticleTranslation(schema as TranslatableArticleSchema, locale);
}

/**
 * Translate a BlogPosting structured-data object in place. No-op on missing translation.
 * Kept for registry symmetry; the project does not currently emit BlogPosting schema.
 */
export function translateBlogPostingSchema(
 schema: Record<string, unknown>,
 locale: 'en' | 'de' | 'fr'
): void {
 applyArticleTranslation(schema as TranslatableArticleSchema, locale);
}
