import { describe, it, expect } from 'vitest';
import BLOG_SEO_METADATA_4 from '@/services/seo/seo-blog-4';
import { FAQ_TRANSLATIONS } from '@/services/seo/faq-translations';
import blogMetaIt from '@/services/locales/blog-meta-it';
import blogMetaEn from '@/services/locales/blog-meta-en';
import blogMetaDe from '@/services/locales/blog-meta-de';
import blogMetaFr from '@/services/locales/blog-meta-fr';

const DIESEL_ID = 'diesel-aumento-prezzi-svizzera-2026';
const CARBURANTI_ID = 'carburanti-ticino-aumento-prezzi';

const DIESEL_FAQ_IT_QUESTIONS: readonly string[] = [
 'Quanto costa il diesel in Svizzera nel 2026?',
 'Il diesel costa di più in Svizzera o in Italia?',
 'Perché il prezzo del diesel è aumentato in Svizzera?',
 'Come risparmiare sul diesel facendo il frontaliere?',
];

const CARBURANTI_FAQ_IT_QUESTIONS: readonly string[] = [
 'Quali sono i distributori più economici in Ticino nel 2026?',
 'Di quanto sono aumentati i prezzi dei carburanti in Ticino nel 2026?',
 'Conviene ancora fare benzina in Italia per i frontalieri?',
 'Quanto costa un pieno di diesel in Ticino oggi?',
];

function getStructuredDataArray(id: string): readonly Record<string, unknown>[] {
 const entry = (BLOG_SEO_METADATA_4 as Record<string, { structuredData: unknown }>)[`blog-${id}`];
 expect(entry).toBeTruthy();
 const sd = entry.structuredData;
 return Array.isArray(sd) ? (sd as Record<string, unknown>[]) : [sd as Record<string, unknown>];
}

describe('diesel/carburanti SEO pages — 2026 rewrite', () => {
 describe('title and description requirements', () => {
 it('Italian titles reference Ticino 2026 for both diesel articles', () => {
 expect(blogMetaIt[`blog.article.${DIESEL_ID}.title`]).toMatch(/Ticino/);
 expect(blogMetaIt[`blog.article.${DIESEL_ID}.title`]).toMatch(/2026/);
 expect(blogMetaIt[`blog.article.${CARBURANTI_ID}.title`]).toMatch(/Ticino/);
 expect(blogMetaIt[`blog.article.${CARBURANTI_ID}.title`]).toMatch(/2026/);
 });

 it('English titles include Ticino + 2026 keyword', () => {
 expect(blogMetaEn[`blog.article.${DIESEL_ID}.title`]).toMatch(/Ticino/);
 expect(blogMetaEn[`blog.article.${DIESEL_ID}.title`]).toMatch(/2026/);
 expect(blogMetaEn[`blog.article.${CARBURANTI_ID}.title`]).toMatch(/Ticino/);
 expect(blogMetaEn[`blog.article.${CARBURANTI_ID}.title`]).toMatch(/2026/);
 });

 it('German titles include Tessin + 2026 keyword', () => {
 expect(blogMetaDe[`blog.article.${DIESEL_ID}.title`]).toMatch(/Tessin/);
 expect(blogMetaDe[`blog.article.${DIESEL_ID}.title`]).toMatch(/2026/);
 expect(blogMetaDe[`blog.article.${CARBURANTI_ID}.title`]).toMatch(/Tessin/);
 expect(blogMetaDe[`blog.article.${CARBURANTI_ID}.title`]).toMatch(/2026/);
 });

 it('French titles include Tessin + 2026 keyword', () => {
 expect(blogMetaFr[`blog.article.${DIESEL_ID}.title`]).toMatch(/Tessin/);
 expect(blogMetaFr[`blog.article.${DIESEL_ID}.title`]).toMatch(/2026/);
 expect(blogMetaFr[`blog.article.${CARBURANTI_ID}.title`]).toMatch(/Tessin/);
 expect(blogMetaFr[`blog.article.${CARBURANTI_ID}.title`]).toMatch(/2026/);
 });

 it('SEO descriptions are within 120-200 chars for both articles (IT)', () => {
 for (const id of [DIESEL_ID, CARBURANTI_ID]) {
 const meta = (BLOG_SEO_METADATA_4 as Record<string, { description: string }>)[`blog-${id}`];
 expect(meta.description.length).toBeGreaterThanOrEqual(120);
 expect(meta.description.length).toBeLessThanOrEqual(200);
 }
 });
 });

 describe('FAQPage structured data', () => {
 it('diesel article exposes FAQPage with 4+ questions', () => {
 const blocks = getStructuredDataArray(DIESEL_ID);
 const faqBlock = blocks.find((b) => b['@type'] === 'FAQPage');
 expect(faqBlock).toBeTruthy();
 const mainEntity = (faqBlock as { mainEntity: unknown[] }).mainEntity;
 expect(Array.isArray(mainEntity)).toBe(true);
 expect(mainEntity.length).toBeGreaterThanOrEqual(4);
 });

 it('carburanti-ticino article gains FAQPage with 4+ questions', () => {
 const blocks = getStructuredDataArray(CARBURANTI_ID);
 const faqBlock = blocks.find((b) => b['@type'] === 'FAQPage');
 expect(faqBlock).toBeTruthy();
 const mainEntity = (faqBlock as { mainEntity: unknown[] }).mainEntity;
 expect(Array.isArray(mainEntity)).toBe(true);
 expect(mainEntity.length).toBeGreaterThanOrEqual(4);
 });

 it('all Italian FAQ questions have EN/DE/FR translations registered', () => {
 for (const q of [...DIESEL_FAQ_IT_QUESTIONS, ...CARBURANTI_FAQ_IT_QUESTIONS]) {
 const entry = FAQ_TRANSLATIONS[q];
 expect(entry, `missing FAQ translation entry for "${q}"`).toBeTruthy();
 for (const locale of ['en', 'de', 'fr'] as const) {
 expect(entry![locale]?.q, `missing ${locale} question for "${q}"`).toBeTruthy();
 expect(entry![locale]?.a, `missing ${locale} answer for "${q}"`).toBeTruthy();
 }
 }
 });
 });

 describe('canonical paths unchanged', () => {
 it('both articles keep their published canonical paths', () => {
 const dieselMeta = (BLOG_SEO_METADATA_4 as Record<string, { canonicalPath: string }>)[`blog-${DIESEL_ID}`];
 const carburantiMeta = (BLOG_SEO_METADATA_4 as Record<string, { canonicalPath: string }>)[`blog-${CARBURANTI_ID}`];
 expect(dieselMeta.canonicalPath).toBe(`/articoli-frontaliere/${DIESEL_ID}`);
 expect(carburantiMeta.canonicalPath).toBe(`/articoli-frontaliere/${CARBURANTI_ID}`);
 });
 });
});
