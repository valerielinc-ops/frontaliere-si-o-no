// Tests for Article / NewsArticle / BlogPosting structured-data translators
// and the schema-translators dispatcher.

import { describe, it, expect } from 'vitest';
import {
 ARTICLE_TRANSLATIONS,
 translateArticleSchema,
 translateNewsArticleSchema,
 translateBlogPostingSchema,
} from '../services/seo/article-translations';
import {
 SCHEMA_TRANSLATOR_REGISTRY,
 translateSchemaByType,
} from '../services/seo/schema-translators';

const KNOWN_ITALIAN_HEADLINE = 'Permessi Lavoro Svizzera G, B, C, L - Guida Completa 2026';
const UNKNOWN_ITALIAN_HEADLINE = 'Titolo Sconosciuto Che Non Esiste Mai';

function buildArticleSchema(
 type: 'Article' | 'NewsArticle' | 'BlogPosting',
 headline: string
): Record<string, unknown> {
 return {
 '@context': 'https://schema.org',
 '@type': type,
 headline,
 description: 'Guida completa ai permessi di lavoro in Svizzera',
 inLanguage: 'it',
 image: {
 '@type': 'ImageObject',
 url: 'https://frontaliereticino.ch/images/permits.webp',
 width: 1344,
 height: 756,
 caption: 'Permessi di lavoro svizzeri',
 },
 };
}

describe('ARTICLE_TRANSLATIONS coverage', () => {
 it('includes all 10 Italian Article headlines from seo-pages.ts', () => {
 // These headlines are the only non-blog Article entries in seo-pages.ts.
 // Blog-specific NewsArticle entries are localized by the seoService OG pass
 // and intentionally have no entries here.
 const expected = [
 'Calendario Scadenze Fiscali 2026 per Frontalieri CH-IT',
 'Permessi Lavoro Svizzera G, B, C, L - Guida Completa 2026',
 'Vivere in Svizzera: Guida Completa per Frontalieri e Residenti',
 'Vivere in Italia come Frontaliere: Vantaggi e Svantaggi',
 'Valichi di Frontiera Svizzera-Italia: Orari, Traffico e Percorsi',
 'Posti da Visitare in Ticino: Natura, Cultura e Attività',
 'Scuole in Ticino per Frontalieri: dalla Materna al Liceo',
 'Disoccupazione Frontalieri: NASpI Italia e AD Svizzera',
 'Festività Ticino 2026: Tutti i Giorni Festivi del Canton Ticino',
 'Guida Completa al Lavoro Frontaliere in Svizzera 2026',
 ];
 for (const headline of expected) {
 expect(ARTICLE_TRANSLATIONS[headline]).toBeDefined();
 expect(ARTICLE_TRANSLATIONS[headline].en.headline).toBeTruthy();
 expect(ARTICLE_TRANSLATIONS[headline].de.headline).toBeTruthy();
 expect(ARTICLE_TRANSLATIONS[headline].fr.headline).toBeTruthy();
 expect(ARTICLE_TRANSLATIONS[headline].en.description).toBeTruthy();
 expect(ARTICLE_TRANSLATIONS[headline].de.description).toBeTruthy();
 expect(ARTICLE_TRANSLATIONS[headline].fr.description).toBeTruthy();
 }
 });
});

describe('translateArticleSchema', () => {
 it('translates headline/description into EN for known Italian headline', () => {
 const schema = buildArticleSchema('Article', KNOWN_ITALIAN_HEADLINE);
 translateArticleSchema(schema, 'en');
 expect(schema.headline).toBe('Swiss Work Permits G, B, C, L - Complete 2026 Guide');
 expect(schema.description).toContain('Complete guide');
 expect(schema.inLanguage).toBe('en');
 });

 it('translates headline/description into DE for known Italian headline', () => {
 const schema = buildArticleSchema('Article', KNOWN_ITALIAN_HEADLINE);
 translateArticleSchema(schema, 'de');
 expect(schema.headline).toBe(
 'Schweizer Arbeitsbewilligungen G, B, C, L - Vollstaendiger Leitfaden 2026'
 );
 expect(schema.description).toContain('Grenzgaenger');
 expect(schema.inLanguage).toBe('de');
 });

 it('translates headline/description into FR for known Italian headline', () => {
 const schema = buildArticleSchema('Article', KNOWN_ITALIAN_HEADLINE);
 translateArticleSchema(schema, 'fr');
 expect(schema.headline).toBe('Permis de travail suisses G, B, C, L - Guide complet 2026');
 expect(schema.description).toContain('frontaliers');
 expect(schema.inLanguage).toBe('fr');
 });

 it('leaves headline/description unchanged on missing translation but updates inLanguage', () => {
 const schema = buildArticleSchema('Article', UNKNOWN_ITALIAN_HEADLINE);
 translateArticleSchema(schema, 'en');
 expect(schema.headline).toBe(UNKNOWN_ITALIAN_HEADLINE);
 expect(schema.description).toBe('Guida completa ai permessi di lavoro in Svizzera');
 expect(schema.inLanguage).toBe('en');
 });
});

describe('translateNewsArticleSchema', () => {
 it('translates a NewsArticle into EN when the headline matches', () => {
 const schema = buildArticleSchema('NewsArticle', KNOWN_ITALIAN_HEADLINE);
 translateNewsArticleSchema(schema, 'en');
 expect(schema.headline).toBe('Swiss Work Permits G, B, C, L - Complete 2026 Guide');
 expect(schema.inLanguage).toBe('en');
 });

 it('translates a NewsArticle into DE when the headline matches', () => {
 const schema = buildArticleSchema('NewsArticle', KNOWN_ITALIAN_HEADLINE);
 translateNewsArticleSchema(schema, 'de');
 expect(schema.headline).toContain('Schweizer Arbeitsbewilligungen');
 expect(schema.inLanguage).toBe('de');
 });

 it('translates a NewsArticle into FR when the headline matches', () => {
 const schema = buildArticleSchema('NewsArticle', KNOWN_ITALIAN_HEADLINE);
 translateNewsArticleSchema(schema, 'fr');
 expect(schema.headline).toContain('Permis de travail');
 expect(schema.inLanguage).toBe('fr');
 });

 it('is a no-op on unknown (blog) headlines — keeps Italian source', () => {
 const schema = buildArticleSchema('NewsArticle', 'Borse in rosso — articolo di blog IT');
 translateNewsArticleSchema(schema, 'en');
 expect(schema.headline).toBe('Borse in rosso — articolo di blog IT');
 });
});

describe('translateBlogPostingSchema', () => {
 it('translates a BlogPosting into EN when the headline matches', () => {
 const schema = buildArticleSchema('BlogPosting', KNOWN_ITALIAN_HEADLINE);
 translateBlogPostingSchema(schema, 'en');
 expect(schema.headline).toBe('Swiss Work Permits G, B, C, L - Complete 2026 Guide');
 expect(schema.inLanguage).toBe('en');
 });

 it('translates a BlogPosting into DE when the headline matches', () => {
 const schema = buildArticleSchema('BlogPosting', KNOWN_ITALIAN_HEADLINE);
 translateBlogPostingSchema(schema, 'de');
 expect(schema.headline).toContain('Schweizer Arbeitsbewilligungen');
 expect(schema.inLanguage).toBe('de');
 });

 it('translates a BlogPosting into FR when the headline matches', () => {
 const schema = buildArticleSchema('BlogPosting', KNOWN_ITALIAN_HEADLINE);
 translateBlogPostingSchema(schema, 'fr');
 expect(schema.headline).toContain('Permis de travail');
 expect(schema.inLanguage).toBe('fr');
 });

 it('leaves the BlogPosting unchanged when no translation exists', () => {
 const schema = buildArticleSchema('BlogPosting', UNKNOWN_ITALIAN_HEADLINE);
 translateBlogPostingSchema(schema, 'en');
 expect(schema.headline).toBe(UNKNOWN_ITALIAN_HEADLINE);
 });
});

describe('schema-translators dispatcher', () => {
 it('registry is alphabetically sorted', () => {
 const keys = Object.keys(SCHEMA_TRANSLATOR_REGISTRY);
 const sorted = [...keys].sort((a, b) => a.localeCompare(b));
 expect(keys).toEqual(sorted);
 });

 it('registry includes Article, BlogPosting, NewsArticle, FAQPage, HowTo', () => {
 expect(SCHEMA_TRANSLATOR_REGISTRY.Article).toBeDefined();
 expect(SCHEMA_TRANSLATOR_REGISTRY.BlogPosting).toBeDefined();
 expect(SCHEMA_TRANSLATOR_REGISTRY.NewsArticle).toBeDefined();
 expect(SCHEMA_TRANSLATOR_REGISTRY.FAQPage).toBeDefined();
 expect(SCHEMA_TRANSLATOR_REGISTRY.HowTo).toBeDefined();
 });

 it('dispatches Article schemas via translateSchemaByType', () => {
 const schema = buildArticleSchema('Article', KNOWN_ITALIAN_HEADLINE);
 translateSchemaByType(schema, 'en');
 expect(schema.headline).toBe('Swiss Work Permits G, B, C, L - Complete 2026 Guide');
 });

 it('dispatches NewsArticle schemas via translateSchemaByType', () => {
 const schema = buildArticleSchema('NewsArticle', KNOWN_ITALIAN_HEADLINE);
 translateSchemaByType(schema, 'de');
 expect(schema.headline).toContain('Schweizer Arbeitsbewilligungen');
 });

 it('dispatches BlogPosting schemas via translateSchemaByType', () => {
 const schema = buildArticleSchema('BlogPosting', KNOWN_ITALIAN_HEADLINE);
 translateSchemaByType(schema, 'fr');
 expect(schema.headline).toContain('Permis de travail');
 });

 it('is a no-op on unknown @type', () => {
 const schema = {
 '@context': 'https://schema.org',
 '@type': 'WebPage',
 headline: KNOWN_ITALIAN_HEADLINE,
 } as Record<string, unknown>;
 translateSchemaByType(schema, 'en');
 expect(schema.headline).toBe(KNOWN_ITALIAN_HEADLINE);
 });

 it('is a no-op on missing/non-string @type', () => {
 const schema = { headline: KNOWN_ITALIAN_HEADLINE } as Record<string, unknown>;
 translateSchemaByType(schema, 'en');
 expect(schema.headline).toBe(KNOWN_ITALIAN_HEADLINE);
 });
});
