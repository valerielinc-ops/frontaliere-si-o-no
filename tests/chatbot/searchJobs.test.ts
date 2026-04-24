/**
 * Tests for services/chatbotTools → searchJobs and its helpers.
 *
 * Covers:
 * - Query extraction (heuristic extractor picks canton/sector/keywords)
 * - Token scoring (canton and keyword overlap contribute correctly)
 * - URL building (locale-aware slug selection + buildPath integration)
 * - Empty dataset / empty query graceful handling
 */

import { describe, it, expect } from 'vitest';
import {
 searchJobs,
 extractQueryHeuristic,
 scoreJob,
 buildJobUrl,
 tokenise,
 type JobRecord,
} from '@/services/chatbotTools';

const FIXTURES: JobRecord[] = [
 {
 slug: 'infermiere-lugano-ospedale-regionale',
 title: 'Infermiere SSR — Ospedale Regionale di Lugano',
 company: 'EOC — Ente Ospedaliero Cantonale',
 location: 'Lugano',
 canton: 'TI',
 category: 'healthcare',
 contract: 'full-time',
 description: 'Cerchiamo infermiere diplomato per reparto di medicina interna.',
 titleByLocale: {
 it: 'Infermiere SSR — Ospedale Regionale di Lugano',
 en: 'Registered Nurse — Lugano Regional Hospital',
 },
 slugByLocale: {
 it: 'infermiere-lugano-ospedale-regionale',
 en: 'registered-nurse-lugano-regional-hospital',
 },
 },
 {
 slug: 'software-engineer-zurich-ubs',
 title: 'Software Engineer (Full-Stack)',
 company: 'UBS',
 location: 'Zurigo',
 canton: 'ZH',
 category: 'tech',
 contract: 'full-time',
 description: 'React, TypeScript, Node.js. Team internazionale.',
 },
 {
 slug: 'commesso-vendite-mendrisio',
 title: 'Commesso vendite',
 company: 'Migros Ticino',
 location: 'Mendrisio',
 canton: 'TI',
 category: 'sales',
 contract: 'part-time',
 description: 'Centro commerciale, weekend compresi.',
 },
 {
 slug: 'aiuto-infermiere-bellinzona',
 title: 'Aiuto infermiere — Casa anziani',
 company: 'Casa anziani Bellinzona',
 location: 'Bellinzona',
 canton: 'TI',
 category: 'healthcare',
 contract: 'part-time',
 description: 'Turno notturno, esperienza gradita.',
 },
];

describe('chatbotTools › tokenise', () => {
 it('strips stopwords and short tokens, lowercases + normalises accents', () => {
 const tokens = tokenise('Cerco lavoro come INFERMIERE a Lugano');
 expect(tokens).toContain('infermiere');
 expect(tokens).toContain('lugano');
 expect(tokens).not.toContain('a');
 expect(tokens).not.toContain('cerco');
 expect(tokens).not.toContain('lavoro');
 });
});

describe('chatbotTools › extractQueryHeuristic', () => {
 it('parses canton from city name and sector from role keyword', () => {
 const parsed = extractQueryHeuristic('trova offerte infermiere a Lugano');
 expect(parsed.canton).toBe('TI');
 expect(parsed.sector).toBe('healthcare');
 expect(parsed.keywords).toContain('infermiere');
 expect(parsed.keywords).toContain('lugano');
 });

 it('parses canton by canonical name and English sector alias', () => {
 const parsed = extractQueryHeuristic('software engineer in Zurich full-time');
 expect(parsed.canton).toBe('ZH');
 expect(parsed.sector).toBe('tech');
 expect(parsed.contract).toBe('full-time');
 });

 it('returns empty structure for empty input without throwing', () => {
 const parsed = extractQueryHeuristic('');
 expect(parsed.keywords).toEqual([]);
 expect(parsed.canton).toBeUndefined();
 expect(parsed.sector).toBeUndefined();
 });
});

describe('chatbotTools › scoreJob', () => {
 it('awards the canton and sector bonuses for an exact match', () => {
 const extracted = { canton: 'TI', sector: 'healthcare', keywords: ['infermiere'], contract: undefined };
 const scoreHealthcareTI = scoreJob(FIXTURES[0], extracted, 'it');
 const scoreTechZH = scoreJob(FIXTURES[1], extracted, 'it');
 // Same keywords present in TI+healthcare job, absent in ZH tech job.
 expect(scoreHealthcareTI).toBeGreaterThan(scoreTechZH);
 // canton (10) + sector (8) + keyword-in-title (3) = at least 21
 expect(scoreHealthcareTI).toBeGreaterThanOrEqual(21);
 });

 it('returns 0 when no tokens or canonical fields match', () => {
 const extracted = { canton: 'GE', sector: 'hospitality', keywords: ['cuoco'], contract: undefined };
 const score = scoreJob(FIXTURES[1], extracted, 'it');
 expect(score).toBe(0);
 });
});

describe('chatbotTools › buildJobUrl', () => {
 it('uses the locale-specific slug when available', () => {
 const urlEn = buildJobUrl(FIXTURES[0], 'en');
 expect(urlEn).toContain('registered-nurse-lugano-regional-hospital');
 });

 it('falls back to the canonical slug when locale slug missing', () => {
 const urlDe = buildJobUrl(FIXTURES[0], 'de');
 // No German slug in fixture → uses canonical `slug` field
 expect(urlDe).toContain('infermiere-lugano-ospedale-regionale');
 });
});

describe('chatbotTools › searchJobs', () => {
 it('returns ranked results for a plain Italian query', async () => {
 const results = await searchJobs({
 query: 'trova offerte infermiere a Lugano',
 locale: 'it',
 jobs: FIXTURES,
 limit: 3,
 });
 expect(results.length).toBeGreaterThan(0);
 expect(results.length).toBeLessThanOrEqual(3);
 // Top result must be a Ticino healthcare job
 const top = results[0];
 expect(top.slug).toBe('infermiere-lugano-ospedale-regionale');
 expect(top.url).toMatch(/infermiere-lugano/);
 expect(top.title).toContain('Infermiere');
 });

 it('returns [] for an empty query', async () => {
 const results = await searchJobs({ query: '', locale: 'it', jobs: FIXTURES });
 expect(results).toEqual([]);
 });

 it('returns [] when the dataset is empty', async () => {
 const results = await searchJobs({
 query: 'trova lavoro',
 locale: 'it',
 jobs: [],
 });
 expect(results).toEqual([]);
 });

 it('respects the limit param and never returns more than asked', async () => {
 const results = await searchJobs({
 query: 'lavoro Ticino',
 locale: 'it',
 jobs: FIXTURES,
 limit: 2,
 });
 expect(results.length).toBeLessThanOrEqual(2);
 });

 it('falls back to the heuristic extractor when the injected LLM extractor throws', async () => {
 const results = await searchJobs({
 query: 'infermiere Lugano',
 locale: 'it',
 jobs: FIXTURES,
 limit: 5,
 extractor: async () => {
 throw new Error('LLM unreachable');
 },
 });
 expect(results.length).toBeGreaterThan(0);
 expect(results[0].slug).toBe('infermiere-lugano-ospedale-regionale');
 });

 it('uses the injected LLM extractor result when it returns a valid shape', async () => {
 const results = await searchJobs({
 query: 'jobs plz',
 locale: 'en',
 jobs: FIXTURES,
 limit: 5,
 extractor: async () => ({
 canton: 'ZH',
 sector: 'tech',
 keywords: ['software'],
 }),
 });
 expect(results.length).toBeGreaterThan(0);
 expect(results[0].slug).toBe('software-engineer-zurich-ubs');
 });
});
