// Tests for the HowTo + FAQPage structured data on the payslip simulator page
// (/calcola-stipendio/simula-busta-paga) plus locale translations.

import { describe, it, expect } from 'vitest';
import SEO_PAGES_METADATA from '../services/seo/seo-pages';
import {
 HOWTO_TRANSLATIONS,
 translateHowToSchema,
} from '../services/seo/howto-translations';
import {
 FAQ_TRANSLATIONS,
 translateFaqPage,
} from '../services/seo/faq-translations';

const PAYSLIP_KEY = 'payslip';
const HOWTO_NAME =
 'Come simulare la busta paga del nuovo frontaliere Svizzera-Italia';
const FAQ_QUESTIONS = [
 "Che cos'è il Nuovo Accordo frontalieri 2026?",
 "Quando si è considerati 'nuovo frontaliere'?",
 "Come si calcola l'imposta alla fonte in Ticino nel 2026?",
 'Cosa cambia se vivo oltre 20 km dal confine svizzero?',
 'I contributi AVS e LPP sono deducibili in Italia?',
 'Posso usare il simulatore anche se ho il Permesso B?',
 "L'imposta alla fonte è definitiva o posso recuperare qualcosa con la TDR?",
 'Il simulatore include la tredicesima e gli assegni familiari?',
];

function getSchemas(): Array<Record<string, unknown>> {
 const entry = SEO_PAGES_METADATA[PAYSLIP_KEY];
 expect(entry, `Missing SEO_PAGES_METADATA['${PAYSLIP_KEY}']`).toBeDefined();
 const sd = entry.structuredData;
 expect(sd, 'payslip entry missing structuredData').toBeDefined();
 return Array.isArray(sd) ? (sd as Array<Record<string, unknown>>) : [sd as Record<string, unknown>];
}

describe('Payslip simulator: HowTo structured data (IT)', () => {
 const schemas = getSchemas();
 const howTo = schemas.find((s) => s['@type'] === 'HowTo');

 it('exposes a HowTo schema with Schema.org context', () => {
 expect(howTo, 'HowTo schema missing from payslip entry').toBeDefined();
 expect(howTo!['@context']).toBe('https://schema.org');
 });

 it('HowTo name matches the translation key', () => {
 expect(howTo!.name).toBe(HOWTO_NAME);
 });

 it('HowTo has a totalTime (required by AI SEO P0)', () => {
 expect(howTo!.totalTime).toBeTruthy();
 });

 it('HowTo has >=5 steps, each a valid HowToStep', () => {
 const steps = howTo!.step as Array<Record<string, unknown>>;
 expect(Array.isArray(steps)).toBe(true);
 expect(steps.length).toBeGreaterThanOrEqual(5);
 for (const step of steps) {
 expect(step['@type']).toBe('HowToStep');
 expect(typeof step.name).toBe('string');
 expect((step.name as string).length).toBeGreaterThan(3);
 expect(typeof step.text).toBe('string');
 expect((step.text as string).length).toBeGreaterThan(20);
 }
 });
});

describe('Payslip simulator: FAQPage structured data (IT)', () => {
 const schemas = getSchemas();
 const faq = schemas.find((s) => s['@type'] === 'FAQPage');

 it('exposes a FAQPage schema with >=6 questions', () => {
 expect(faq, 'FAQPage schema missing from payslip entry').toBeDefined();
 const mainEntity = faq!.mainEntity as Array<Record<string, unknown>>;
 expect(Array.isArray(mainEntity)).toBe(true);
 expect(mainEntity.length).toBeGreaterThanOrEqual(6);
 });

 it('every Question has a name and an acceptedAnswer with text', () => {
 const faqEntity = faq!.mainEntity as Array<Record<string, unknown>>;
 for (const q of faqEntity) {
 expect(q['@type']).toBe('Question');
 expect(typeof q.name).toBe('string');
 const answer = q.acceptedAnswer as Record<string, unknown>;
 expect(answer['@type']).toBe('Answer');
 expect(typeof answer.text).toBe('string');
 expect((answer.text as string).length).toBeGreaterThan(40);
 }
 });

 it('contains all expected payslip FAQ questions', () => {
 const faqEntity = faq!.mainEntity as Array<Record<string, unknown>>;
 const names = faqEntity.map((q) => q.name as string);
 for (const expected of FAQ_QUESTIONS) {
 expect(names).toContain(expected);
 }
 });
});

describe('Payslip simulator: locale translations', () => {
 it('HOWTO_TRANSLATIONS has en/de/fr for the payslip HowTo', () => {
 const entry = HOWTO_TRANSLATIONS[HOWTO_NAME];
 expect(entry, `Missing HOWTO_TRANSLATIONS['${HOWTO_NAME}']`).toBeDefined();
 for (const locale of ['en', 'de', 'fr'] as const) {
 const t = entry[locale];
 expect(t.name.length).toBeGreaterThan(5);
 expect(t.description.length).toBeGreaterThan(20);
 expect(t.steps.length).toBeGreaterThanOrEqual(5);
 for (const step of t.steps) {
 expect(step.name.length).toBeGreaterThan(3);
 expect(step.text.length).toBeGreaterThan(20);
 }
 }
 });

 it('FAQ_TRANSLATIONS has en/de/fr for every payslip FAQ', () => {
 for (const question of FAQ_QUESTIONS) {
 const entry = FAQ_TRANSLATIONS[question];
 expect(entry, `Missing FAQ_TRANSLATIONS['${question}']`).toBeDefined();
 for (const locale of ['en', 'de', 'fr'] as const) {
 const t = entry[locale];
 expect(t.q.length).toBeGreaterThan(5);
 expect(t.a.length).toBeGreaterThan(40);
 }
 }
 });

 it('translateHowToSchema produces a fully localized HowTo for each locale', () => {
 const schemas = getSchemas();
 const original = schemas.find((s) => s['@type'] === 'HowTo')!;
 for (const locale of ['en', 'de', 'fr'] as const) {
 const clone = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
 translateHowToSchema(clone, locale);
 expect(clone.name).not.toBe(HOWTO_NAME);
 const steps = clone.step as Array<Record<string, unknown>>;
 for (const step of steps) {
 expect(typeof step.name).toBe('string');
 expect(typeof step.text).toBe('string');
 }
 }
 });

 it('translateFaqPage produces fully localized FAQ entries for each locale', () => {
 const schemas = getSchemas();
 const original = schemas.find((s) => s['@type'] === 'FAQPage')!;
 for (const locale of ['en', 'de', 'fr'] as const) {
 const clone = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
 translateFaqPage(clone, locale);
 const mainEntity = clone.mainEntity as Array<Record<string, unknown>>;
 for (const q of mainEntity) {
 const name = q.name as string;
 // Translation should have replaced every question we shipped translations for.
 expect(FAQ_QUESTIONS).not.toContain(name);
 }
 }
 });
});
