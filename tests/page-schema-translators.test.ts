import { describe, it, expect } from 'vitest';
import {
 translateAboutPage,
 translateCollectionPage,
 translateContactPage,
 translateItemList,
 translateWebPage
} from '@/services/seo/page-translations';
import {
 SCHEMA_TRANSLATOR_REGISTRY,
 translateSchemaObject
} from '@/services/seo/schema-translators';

type Lang = 'en' | 'de' | 'fr';

function makeCollectionPage(): Record<string, any> {
 return {
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: 'Comparatori Servizi Frontalieri',
 url: 'https://frontaliereticino.ch/compara-servizi',
 description: 'Strumenti di confronto per servizi essenziali per lavoratori frontalieri',
 inLanguage: 'it'
 };
}

function makeItemList(): Record<string, any> {
 return {
 '@context': 'https://schema.org',
 '@type': 'ItemList',
 name: 'Strumenti di confronto frontalieri',
 numberOfItems: 8,
 itemListElement: [
 { '@type': 'ListItem', position: 1, name: 'Cambio Valuta CHF/EUR', url: '/a' },
 { '@type': 'ListItem', position: 2, name: 'Operatori Mobili', url: '/b' },
 // Proper-noun child — must NEVER be translated.
 { '@type': 'ListItem', position: 3, item: { '@type': 'Organization', name: 'UBS', url: 'https://ubs.com' } }
 ],
 inLanguage: 'it'
 };
}

function makeWebPage(): Record<string, any> {
 return {
 '@context': 'https://schema.org',
 '@type': 'WebPage',
 name: 'Aliquote imposta alla fonte Ticino 2026',
 url: 'https://frontaliereticino.ch/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026',
 description: 'Guida pratica alle tabelle A, B, C e H del Ticino per frontalieri con esempi di aliquota, FAQ e link ai simulatori fiscali.',
 inLanguage: 'it'
 };
}

function makeAboutPage(): Record<string, any> {
 return {
 '@context': 'https://schema.org',
 '@type': 'AboutPage',
 name: 'Chi Siamo — Frontaliere Ticino',
 url: 'https://frontaliereticino.ch/chi-siamo/',
 description: 'Piattaforma informativa per frontalieri italiani in Svizzera',
 inLanguage: 'it'
 };
}

function makeContactPage(): Record<string, any> {
 return {
 '@context': 'https://schema.org',
 '@type': 'ContactPage',
 name: 'Contatti Frontaliere Ticino',
 url: 'https://frontaliereticino.ch/contattaci',
 description: 'Pagina contatti per il servizio Frontaliere Ticino',
 inLanguage: 'it'
 };
}

const locales: Lang[] = ['en', 'de', 'fr'];

describe('translateCollectionPage', () => {
 for (const locale of locales) {
 it(`translates CollectionPage name and description to ${locale}`, () => {
 const obj = makeCollectionPage();
 translateCollectionPage(obj, locale);
 expect(obj.name).not.toBe('Comparatori Servizi Frontalieri');
 expect(obj.description).not.toBe('Strumenti di confronto per servizi essenziali per lavoratori frontalieri');
 expect(obj.inLanguage).toBe(locale);
 expect(obj['@type']).toBe('CollectionPage');
 });
 }

 it('leaves an unknown CollectionPage name untranslated (silent fallback)', () => {
 const obj = {
 '@type': 'CollectionPage',
 name: 'Pagina Inesistente Placeholder',
 description: 'Descrizione placeholder',
 inLanguage: 'it'
 };
 translateCollectionPage(obj, 'en');
 expect(obj.name).toBe('Pagina Inesistente Placeholder');
 expect(obj.description).toBe('Descrizione placeholder');
 // inLanguage is only overwritten when a translation is actually applied.
 expect(obj.inLanguage).toBe('it');
 });
});

describe('translateItemList', () => {
 for (const locale of locales) {
 it(`translates ItemList name and known child names to ${locale}`, () => {
 const obj = makeItemList();
 translateItemList(obj, locale);
 expect(obj.name).not.toBe('Strumenti di confronto frontalieri');
 expect(obj.inLanguage).toBe(locale);

 const [first, second, third] = obj.itemListElement;
 expect(first.name).not.toBe('Cambio Valuta CHF/EUR');
 expect(second.name).not.toBe('Operatori Mobili');
 // Proper noun nested under `item` must stay intact.
 expect(third.item.name).toBe('UBS');
 });
 }

 it('leaves proper-noun child elements untouched', () => {
 const obj = makeItemList();
 translateItemList(obj, 'en');
 expect(obj.itemListElement[2].item.name).toBe('UBS');
 });

 it('silent fallback for unknown ItemList name', () => {
 const obj: Record<string, any> = {
 '@type': 'ItemList',
 name: 'Lista sconosciuta',
 itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Cambio Valuta CHF/EUR', url: '/x' }]
 };
 translateItemList(obj, 'en');
 expect(obj.name).toBe('Lista sconosciuta');
 // Children are only translated when the parent list is known.
 expect(obj.itemListElement[0].name).toBe('Cambio Valuta CHF/EUR');
 });
});

describe('translateWebPage', () => {
 for (const locale of locales) {
 it(`translates WebPage name and description to ${locale}`, () => {
 const obj = makeWebPage();
 translateWebPage(obj, locale);
 expect(obj.name).not.toBe('Aliquote imposta alla fonte Ticino 2026');
 expect(obj.description).not.toBe(
 'Guida pratica alle tabelle A, B, C e H del Ticino per frontalieri con esempi di aliquota, FAQ e link ai simulatori fiscali.'
 );
 expect(obj.inLanguage).toBe(locale);
 });
 }

 it('silent fallback for unknown WebPage name', () => {
 const obj = { '@type': 'WebPage', name: 'Pagina Fantasma', description: 'X', inLanguage: 'it' };
 translateWebPage(obj, 'de');
 expect(obj.name).toBe('Pagina Fantasma');
 expect(obj.inLanguage).toBe('it');
 });
});

describe('translateAboutPage', () => {
 for (const locale of locales) {
 it(`translates AboutPage name and description to ${locale}`, () => {
 const obj = makeAboutPage();
 translateAboutPage(obj, locale);
 expect(obj.name).not.toBe('Chi Siamo — Frontaliere Ticino');
 expect(obj.description).not.toBe('Piattaforma informativa per frontalieri italiani in Svizzera');
 expect(obj.inLanguage).toBe(locale);
 });
 }

 it('silent fallback for unknown AboutPage name', () => {
 const obj = { '@type': 'AboutPage', name: 'Chi Altri', description: 'X', inLanguage: 'it' };
 translateAboutPage(obj, 'fr');
 expect(obj.name).toBe('Chi Altri');
 });
});

describe('translateContactPage', () => {
 for (const locale of locales) {
 it(`translates ContactPage name and description to ${locale}`, () => {
 const obj = makeContactPage();
 translateContactPage(obj, locale);
 expect(obj.name).not.toBe('Contatti Frontaliere Ticino');
 expect(obj.description).not.toBe('Pagina contatti per il servizio Frontaliere Ticino');
 expect(obj.inLanguage).toBe(locale);
 });
 }

 it('silent fallback for unknown ContactPage name', () => {
 const obj = { '@type': 'ContactPage', name: 'Contatto Sconosciuto', description: 'X', inLanguage: 'it' };
 translateContactPage(obj, 'en');
 expect(obj.name).toBe('Contatto Sconosciuto');
 });
});

describe('schema-translators dispatcher registry', () => {
 it('registers handlers for every page-level target @type', () => {
 const expected = ['AboutPage', 'CollectionPage', 'ContactPage', 'ItemList', 'WebPage'];
 const keys = Object.keys(SCHEMA_TRANSLATOR_REGISTRY);
 for (const key of expected) {
 expect(keys).toContain(key);
 expect(typeof SCHEMA_TRANSLATOR_REGISTRY[key]).toBe('function');
 }
 });

 it('dispatches CollectionPage through translateSchemaObject', () => {
 const obj = makeCollectionPage();
 const ran = translateSchemaObject(obj, 'en');
 expect(ran).toBe(true);
 expect(obj.inLanguage).toBe('en');
 expect(obj.name).not.toBe('Comparatori Servizi Frontalieri');
 });

 it('no-ops for locale="it"', () => {
 const obj = makeWebPage();
 const ran = translateSchemaObject(obj, 'it');
 expect(ran).toBe(false);
 expect(obj.name).toBe('Aliquote imposta alla fonte Ticino 2026');
 });

 it('returns false for unregistered @type', () => {
 const obj = { '@type': 'Recipe', name: 'Risotto al Pesto' };
 const ran = translateSchemaObject(obj, 'en');
 expect(ran).toBe(false);
 expect(obj.name).toBe('Risotto al Pesto');
 });

 it('returns false for malformed objects', () => {
 expect(translateSchemaObject(null, 'en')).toBe(false);
 expect(translateSchemaObject(undefined, 'en')).toBe(false);
 expect(translateSchemaObject({} as any, 'en')).toBe(false);
 });
});
