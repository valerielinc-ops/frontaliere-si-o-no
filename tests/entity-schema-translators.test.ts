// Tests for entity schema translators (WebApplication, Organization, Review,
// ClaimReview, Dataset) and their wiring in the schema-translators dispatcher.

import { describe, it, expect } from 'vitest';
import {
 translateWebApplication,
 translateOrganization,
 translateReview,
 translateClaimReview,
 translateDataset,
} from '../services/seo/entity-translations';
import {
 getSchemaTranslator,
 listSupportedSchemaTypes,
 translateSchema,
} from '../services/seo/schema-translators';

type Locale = 'en' | 'de' | 'fr';
const LOCALES: Locale[] = ['en', 'de', 'fr'];

// ─── Registry wiring ────────────────────────────────────────────────────

describe('schema-translators registry: entity types wired', () => {
 it('exposes ClaimReview, Dataset, Organization, Review, WebApplication translators', () => {
 const types = listSupportedSchemaTypes();
 expect(types).toContain('ClaimReview');
 expect(types).toContain('Dataset');
 expect(types).toContain('Organization');
 expect(types).toContain('Review');
 expect(types).toContain('WebApplication');
 });

 it('keeps the registry alphabetized', () => {
 const types = listSupportedSchemaTypes();
 const sorted = [...types].sort();
 expect(types).toEqual(sorted);
 });

 it('dispatches via translateSchema for every new type', () => {
 for (const t of ['ClaimReview', 'Dataset', 'Organization', 'Review', 'WebApplication']) {
 expect(getSchemaTranslator(t)).toBeTypeOf('function');
 }
 });
});

// ─── WebApplication ─────────────────────────────────────────────────────

describe('translateWebApplication', () => {
 const source = () => ({
 '@context': 'https://schema.org',
 '@type': 'WebApplication',
 name: 'Simulatore Fiscale Frontalieri',
 description:
 'Calcolo preciso delle tasse per frontalieri tra Svizzera e Italia secondo il nuovo accordo 2026',
 applicationCategory: 'FinanceApplication',
 operatingSystem: 'Web Browser',
 inLanguage: 'it',
 });

 it.each(LOCALES)('translates name + description for %s', (locale) => {
 const obj = source();
 translateWebApplication(obj, locale);
 expect(obj.name).not.toBe('Simulatore Fiscale Frontalieri');
 expect(obj.description).not.toContain('Calcolo preciso delle tasse');
 expect(obj.inLanguage).toBe(locale);
 // enum-like fields preserved
 expect(obj.applicationCategory).toBe('FinanceApplication');
 expect(obj.operatingSystem).toBe('Web Browser');
 });

 it('leaves Italian untouched when no translation is registered', () => {
 const obj = {
 '@type': 'WebApplication',
 name: 'Nome Non Tradotto Inventato',
 description: 'Descrizione non tradotta inventata',
 inLanguage: 'it',
 };
 translateWebApplication(obj, 'en');
 expect(obj.name).toBe('Nome Non Tradotto Inventato');
 expect(obj.description).toBe('Descrizione non tradotta inventata');
 // inLanguage is still updated (locale marker)
 expect(obj.inLanguage).toBe('en');
 });

 it('does not touch inLanguage when the field is absent', () => {
 const obj: Record<string, any> = {
 '@type': 'WebApplication',
 name: 'Simulatore Fiscale Frontalieri',
 description:
 'Calcolo preciso delle tasse per frontalieri tra Svizzera e Italia secondo il nuovo accordo 2026',
 };
 translateWebApplication(obj, 'de');
 expect(obj.inLanguage).toBeUndefined();
 });
});

// ─── Organization ───────────────────────────────────────────────────────

describe('translateOrganization', () => {
 const source = () => ({
 '@context': 'https://schema.org',
 '@type': 'Organization',
 '@id': 'https://frontaliereticino.ch/#organization',
 name: 'Frontaliere Ticino',
 description:
 'La risorsa più completa per i lavoratori frontalieri tra Italia e Svizzera: simulatore fiscale, pensione, assicurazione sanitaria, cambio valuta e guide pratiche.',
 areaServed: [
 { '@type': 'Country', name: 'Switzerland' },
 { '@type': 'Country', name: 'Italy' },
 ],
 knowsAbout: [
 'Cross-border worker taxation',
 'Swiss withholding tax',
 'Italian IRPEF',
 ],
 });

 it.each(LOCALES)('translates description and knowsAbout but keeps brand name for %s', (locale) => {
 const obj = source();
 translateOrganization(obj, locale);
 expect(obj.name).toBe('Frontaliere Ticino');
 expect(obj.description).not.toContain('La risorsa più completa');
 expect(Array.isArray(obj.knowsAbout)).toBe(true);
 expect(obj.knowsAbout.length).toBe(6);
 });

 it('localises areaServed country names', () => {
 const obj = source();
 translateOrganization(obj, 'de');
 expect(obj.areaServed[0].name).toBe('Schweiz');
 expect(obj.areaServed[1].name).toBe('Italien');
 translateOrganization(obj as any, 'fr'); // idempotent-ish safety
 // After FR pass, the DE-translated country names should NOT be retranslatable,
 // since they are no longer present in COUNTRY_NAME_TRANSLATIONS keys.
 expect(obj.areaServed[0].name).toBe('Schweiz');
 });

 it('translates the generic Claim author "Opinione comune"', () => {
 const obj: Record<string, any> = {
 '@type': 'Organization',
 name: 'Opinione comune',
 };
 translateOrganization(obj, 'en');
 expect(obj.name).toBe('Common belief');
 });

 it('leaves an unknown Organization name untouched (silent fallback)', () => {
 const obj: Record<string, any> = {
 '@type': 'Organization',
 name: 'Sconosciuta SRL',
 description: 'Descrizione qualunque',
 };
 translateOrganization(obj, 'en');
 expect(obj.name).toBe('Sconosciuta SRL');
 expect(obj.description).toBe('Descrizione qualunque');
 });
});

// ─── Review ─────────────────────────────────────────────────────────────

describe('translateReview', () => {
 const source = () => ({
 '@context': 'https://schema.org',
 '@type': 'Review',
 itemReviewed: {
 '@type': 'WebApplication',
 name: 'Simulatore Stipendio Frontaliere',
 url: 'https://frontaliereticino.ch/calcola-stipendio',
 },
 author: { '@type': 'Person', name: 'Marco R.' },
 reviewRating: { '@type': 'Rating', ratingValue: '5', bestRating: '5' },
 datePublished: '2026-01-15',
 reviewBody:
 'Finalmente un calcolatore preciso per frontalieri! Ho verificato con la mia busta paga e il risultato era quasi identico. Utilissimo per chi deve decidere tra Permesso B e G.',
 });

 it.each(LOCALES)('translates reviewBody and nested itemReviewed.name for %s', (locale) => {
 const obj = source();
 translateReview(obj, locale);
 expect(obj.reviewBody.startsWith('Finalmente un calcolatore')).toBe(false);
 expect(obj.itemReviewed.name).not.toBe('Simulatore Stipendio Frontaliere');
 // Person author.name is NOT translated (non-translatable personal name).
 expect(obj.author.name).toBe('Marco R.');
 });

 it('leaves Italian review body untouched when source string unknown', () => {
 const obj: Record<string, any> = {
 '@type': 'Review',
 reviewBody: 'Un commento non registrato nel dizionario',
 };
 translateReview(obj, 'de');
 expect(obj.reviewBody).toBe('Un commento non registrato nel dizionario');
 });
});

// ─── ClaimReview ────────────────────────────────────────────────────────

describe('translateClaimReview', () => {
 const source = () => ({
 '@context': 'https://schema.org',
 '@type': 'ClaimReview',
 url: 'https://frontaliereticino.ch/tasse-e-pensione',
 claimReviewed:
 'I frontalieri pagano le tasse due volte, sia in Svizzera che in Italia',
 author: {
 '@type': 'Organization',
 name: 'Frontaliere Ticino',
 url: 'https://frontaliereticino.ch',
 },
 datePublished: '2026-04-01',
 reviewRating: {
 '@type': 'Rating',
 ratingValue: '2',
 bestRating: '5',
 worstRating: '1',
 alternateName: 'Parzialmente falso',
 },
 itemReviewed: {
 '@type': 'Claim',
 author: { '@type': 'Organization', name: 'Opinione comune' },
 datePublished: '2025-01-01',
 },
 });

 it.each(LOCALES)('translates claimReviewed, rating verdict and nested author for %s', (locale) => {
 const obj = source();
 translateClaimReview(obj, locale);
 expect(obj.claimReviewed).not.toContain('I frontalieri pagano le tasse');
 expect(obj.reviewRating.alternateName).not.toBe('Parzialmente falso');
 expect(obj.itemReviewed.author.name).not.toBe('Opinione comune');
 // Brand author stays
 expect(obj.author.name).toBe('Frontaliere Ticino');
 });

 it('leaves unknown claimReviewed untouched', () => {
 const obj: Record<string, any> = {
 '@type': 'ClaimReview',
 claimReviewed: 'Affermazione non registrata nel dizionario',
 reviewRating: { '@type': 'Rating', alternateName: 'Valore ignoto' },
 };
 translateClaimReview(obj, 'en');
 expect(obj.claimReviewed).toBe(
 'Affermazione non registrata nel dizionario'
 );
 expect(obj.reviewRating.alternateName).toBe('Valore ignoto');
 });
});

// ─── Dataset ────────────────────────────────────────────────────────────

describe('translateDataset', () => {
 const source = () => ({
 '@context': 'https://schema.org',
 '@type': 'Dataset',
 name: 'Statistiche frontalieri e osservatorio offerte lavoro Ticino 2026',
 description:
 'Dati statistici sui frontalieri svizzeri-italiani e osservatorio del job board Ticino: numero permessi G, aziende attive, localities, trend offerte e statistiche BFS 2026.',
 creator: {
 '@type': 'Organization',
 name: 'Frontaliere Ticino',
 url: 'https://frontaliereticino.ch',
 },
 temporalCoverage: '2024/2026',
 });

 it.each(LOCALES)('translates name + description and recurses into creator for %s', (locale) => {
 const obj = source();
 translateDataset(obj, locale);
 expect(obj.name).not.toBe(
 'Statistiche frontalieri e osservatorio offerte lavoro Ticino 2026'
 );
 expect(obj.description).not.toContain('Dati statistici sui frontalieri');
 // Brand name stays; temporalCoverage untouched
 expect(obj.creator.name).toBe('Frontaliere Ticino');
 expect(obj.temporalCoverage).toBe('2024/2026');
 });

 it('translates SECO creator "name" when it appears as the source creator', () => {
 const obj: Record<string, any> = {
 '@type': 'Dataset',
 name: 'Tasso di Disoccupazione Svizzera',
 description:
 'Serie storica mensile del tasso di disoccupazione registrata in Svizzera (SECO) dal 2016',
 creator: {
 '@type': 'Organization',
 name: "SECO — Segreteria di Stato dell'economia",
 url: 'https://www.seco.admin.ch',
 },
 };
 translateDataset(obj, 'en');
 expect(obj.creator.name).toBe('SECO — State Secretariat for Economic Affairs');
 });

 it('leaves unknown Dataset untouched', () => {
 const obj: Record<string, any> = {
 '@type': 'Dataset',
 name: 'Dataset sconosciuto',
 description: 'Descrizione sconosciuta',
 };
 translateDataset(obj, 'fr');
 expect(obj.name).toBe('Dataset sconosciuto');
 expect(obj.description).toBe('Descrizione sconosciuta');
 });
});

// ─── End-to-end via dispatcher ──────────────────────────────────────────

describe('translateSchema dispatcher: end-to-end', () => {
 it('routes WebApplication to the right translator', () => {
 const obj: Record<string, any> = {
 '@type': 'WebApplication',
 name: 'Simulatore Fiscale Frontalieri',
 description:
 'Calcolo preciso delle tasse per frontalieri tra Svizzera e Italia secondo il nuovo accordo 2026',
 };
 translateSchema(obj, 'en');
 expect(obj.name).toBe('Cross-Border Worker Tax Simulator');
 });

 it('is a no-op for unregistered @type', () => {
 const obj: Record<string, any> = {
 '@type': 'Thing',
 name: 'Qualcosa',
 };
 translateSchema(obj, 'de');
 expect(obj.name).toBe('Qualcosa');
 });
});
