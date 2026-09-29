// The subject Theme is the start of the locale's largest cohort briefing,
// which is the cohort's jobs paragraph. Its opening ("Se cerchi qualcosa di
// concreto, questa settimana ci sono ") is the same in every email, so it took
// most of the Theme's 80 characters every week, and the model copied it into
// the subjects of both A/B arms: with real Codex, 5 of 24 subjects on
// origin/main held its word ("💼 Suchst du etwas Konkretes in Bellinzona?",
// scripts/measurements/newsletter-subject-theme-real-2026-09-29.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { composeCohortBriefings, composeLocaleSubjects } from '@/scripts/send-newsletter.mjs';
import { getVariantFallback } from '@/services/newsletter-subject-variants.mjs';

const EXCHANGE = { rate: 1.0595, previousRate: 1.0557 };
const LOCALES = ['it', 'en', 'de', 'fr'];
const OPENINGS = /concret|konkret|Looking for something|Auf der Suche|Vous cherchez|Se cerchi/i;
const job = (n: number, title: string) => ({ title, company: `Azienda${n}`, location: 'Lugano', url: `/lavoro/ruolo-${n}` });
const aiText = (loc: string) => `<p>${loc} apertura del briefing sul cambio ${'parola '.repeat(60).trim()}.</p>`;
const cohortsWith = (locale: string, matchedJobs: any[]) => new Map([[`${locale}:0`, { locale, subscriber: { locale }, members: [{}], matchedJobs }]]);

async function themeOf(cohorts: Map<string, any>, source: { briefingFor?: (loc: string) => Promise<string | null>; briefingMap?: Map<string, string> }) {
  const locale = [...cohorts.values()][0].locale;
  let theme = '';
  const subjects = await composeLocaleSubjects(cohorts, {
    locales: [locale],
    variantIds: ['concreto'],
    ...source,
    exchangeRate: EXCHANGE,
    generate: async (ctx: { briefingSummary: string }) => { theme = ctx.briefingSummary; return null; },
  });
  return { theme, subjects };
}

describe('subject Theme without the jobs paragraph opening', () => {
  const JOB_SETS = { 'one job': [job(0, 'Contabile')], 'three jobs': [job(0, 'Contabile'), job(1, 'Cuoco'), job(2, 'Tecnico di laboratorio chimico')] };

  it.each(LOCALES)('%s: next to Phase 2 and after it, the Theme starts with the first job', async (locale) => {
    for (const jobs of Object.values(JOB_SETS)) {
      const cohorts = cohortsWith(locale, jobs);
      const together = await themeOf(cohorts, { briefingFor: async (l) => aiText(l) });
      const phase2 = await composeCohortBriefings(cohorts, { locales: [locale], generate: async (l: string) => aiText(l), exchangeRate: EXCHANGE });
      const sequential = await themeOf(cohorts, { briefingMap: phase2.briefingMap });

      expect(together.theme.startsWith('Contabile')).toBe(true);
      expect(together.theme).not.toMatch(OPENINGS);
      expect(sequential.theme).toBe(together.theme);
      // The email itself keeps its opening: only the Theme drops it.
      expect(phase2.briefingMap.get(`${locale}:0`)).toMatch(OPENINGS);
    }
  });

  it('a cohort without jobs keeps the AI text as its Theme', async () => {
    const { theme } = await themeOf(cohortsWith('de', []), { briefingFor: async (l) => aiText(l) });
    expect(theme.startsWith('de apertura del briefing')).toBe(true);
  });

  it('the subjects still fall back per variant', async () => {
    const { subjects } = await themeOf(cohortsWith('fr', [job(0, 'Contabile')]), { briefingFor: async () => null });
    expect(subjects.get('fr::concreto')).toBe(getVariantFallback('concreto', 'fr'));
  });
});

// REAL Codex (gpt-5.6-luna, effort max, the CI broker's function profile, 3
// lanes) on the same cohorts and briefings, recorded before the merge: the
// fixed opening's word leaves the subjects, and the calls and tokens stay the
// same (one call per locale × variant, same prompt).
describe('subject Theme — real Codex run, before and after', () => {
  const real = JSON.parse(readFileSync(new URL('../scripts/measurements/newsletter-subject-theme-real-2026-09-29.json', import.meta.url), 'utf8'));
  const rows = (mode: string) => real.rows.filter((r: any) => r.mode === mode);
  const mean = (mode: string, key: string) => rows(mode).reduce((n: number, r: any) => n + r[key], 0) / rows(mode).length;

  it.each(['before', 'after'])('%s: an AI subject for every locale and variant, none on the static fallback', (mode) => {
    expect(rows(mode).length).toBeGreaterThanOrEqual(2);
    for (const r of rows(mode)) {
      expect(Object.keys(r.subjects)).toHaveLength(r.locales * r.variants);
      expect(r.onStaticFallback).toEqual([]);
      expect(r.requests).toBe(r.locales * r.variants);
    }
  });

  it('the Theme loses the opening and the subjects lose its word', () => {
    for (const r of rows('before')) for (const theme of Object.values(r.themes) as string[]) expect(theme).toMatch(OPENINGS);
    for (const r of rows('after')) for (const theme of Object.values(r.themes) as string[]) expect(theme).not.toMatch(OPENINGS);
    expect(rows('before').flatMap((r: any) => r.withFixedOpeningWords).length).toBeGreaterThanOrEqual(5);
    expect(rows('after').flatMap((r: any) => r.withFixedOpeningWords)).toEqual([]);
  });

  it('the same input tokens; output tokens and time within the run-to-run noise', () => {
    expect(Math.abs(mean('after', 'inputTokens') - mean('before', 'inputTokens'))).toBeLessThan(mean('before', 'inputTokens') * 0.01);
    expect(mean('after', 'outputTokens')).toBeLessThan(mean('before', 'outputTokens') * 1.25);
    expect(mean('after', 'wallSeconds')).toBeLessThan(mean('before', 'wallSeconds') * 1.25);
  });
});
