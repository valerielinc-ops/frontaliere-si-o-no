// Both A/B subjects of a locale come from ONE AI call (4 calls per run instead
// of 8), and their Theme no longer starts with the jobs paragraph's fixed
// opening, which the model copied into both arms ("💼 A Bellinzona trovi
// qualcosa di concreto?").
import { describe, expect, it, vi } from 'vitest';

import {
  acceptAISubject,
  composeCohortBriefings,
  composeLocaleSubjects,
  generateAISubjects,
  newsletterSubjectKey,
} from '@/scripts/send-newsletter.mjs';
import { buildSubjectPrompt, buildSubjectVariantsPrompt } from '@/services/newsletter-content-core.mjs';
import { getVariantFallback, getVariantStyleDirective, listVariantIds } from '@/services/newsletter-subject-variants.mjs';

const EXCHANGE = { rate: 1.0595, previousRate: 1.0557 };
const VARIANTS = listVariantIds();
const LOCALES = ['it', 'en', 'de', 'fr'];
const job = (n: number, title: string) => ({ title, company: `Azienda${n}`, location: 'Lugano', url: `/lavoro/ruolo-${n}` });
const ctx = (locale: string) => ({
  subscriber: { locale },
  exchangeRate: EXCHANGE,
  matchedJobs: [job(0, 'Contabile')],
  briefingSummary: 'Contabile presso Azienda0 a Lugano',
  variants: VARIANTS,
});

describe('buildSubjectVariantsPrompt', () => {
  it.each(LOCALES)('%s: asks for every variant, each with its own style directive, as one JSON object', (locale) => {
    const { system, user, jsonSchema } = buildSubjectVariantsPrompt(ctx(locale));
    expect(system).toContain(`Write ${VARIANTS.length} email subject lines`);
    for (const v of VARIANTS) {
      expect(system).toContain(`key "${v}": ${getVariantStyleDirective(v, locale)}`);
    }
    expect(jsonSchema.schema.required).toEqual(VARIANTS);
    expect(Object.keys(jsonSchema.schema.properties)).toEqual(VARIANTS);
    expect(jsonSchema.schema.additionalProperties).toBe(false);
    // Same hints as the one-subject prompt.
    expect(user).toBe(buildSubjectPrompt({ ...ctx(locale), variant: VARIANTS[0] }).user);
  });

  it('keeps the rules of the one-subject prompt', () => {
    const one = buildSubjectPrompt({ ...ctx('de'), variant: VARIANTS[0] }).system;
    const all = buildSubjectVariantsPrompt(ctx('de')).system;
    const rules = one.split('RULES:\n')[1].split('\n').slice(0, -1);
    for (const rule of rules) expect(all).toContain(rule);
    expect(all).toMatch(/ABSOLUTE LANGUAGE RULE: Every subject MUST be written in German/);
  });
});

describe('generateAISubjects', () => {
  const run = (answer: unknown) => generateAISubjects(ctx('it'), { llm: async () => answer as string });

  it('makes one call with the variants schema and returns every subject', async () => {
    const llm = vi.fn(async () => JSON.stringify({ concreto: '📊 3 aziende assumono a Lugano', curioso: '🤔 Permesso G o B? Il calcolo che conta' }));
    const out = await generateAISubjects(ctx('it'), { llm });
    expect(llm).toHaveBeenCalledTimes(1);
    expect((llm.mock.calls[0] as any[])[1].jsonSchema.schema.required).toEqual(VARIANTS);
    expect(out).toEqual({ concreto: '📊 3 aziende assumono a Lugano', curioso: '🤔 Permesso G o B? Il calcolo che conta' });
  });

  it('reads a fenced answer and an already-decoded object', async () => {
    expect(await run('```json\n{"concreto":"📊 3 aziende assumono a Lugano","curioso":"🤔 Chi assume davvero a Lugano?"}\n```'))
      .toEqual({ concreto: '📊 3 aziende assumono a Lugano', curioso: '🤔 Chi assume davvero a Lugano?' });
    expect(await run({ concreto: '"📊 3 aziende assumono a Lugano"', curioso: '🤔 Chi assume davvero a Lugano?' }))
      .toEqual({ concreto: '📊 3 aziende assumono a Lugano', curioso: '🤔 Chi assume davvero a Lugano?' });
  });

  it('nulls only the variant that is missing or unusable', async () => {
    expect(await run('{"concreto":"📊 3 aziende assumono a Lugano"}')).toEqual({ concreto: '📊 3 aziende assumono a Lugano', curioso: null });
    expect(await run(JSON.stringify({ concreto: '💼', curioso: `🤔 ${'parola '.repeat(12)}` }))).toEqual({ concreto: null, curioso: null });
    expect(await run({ concreto: '📊 3 aziende assumono a Lugano', curioso: 42 })).toEqual({ concreto: '📊 3 aziende assumono a Lugano', curioso: null });
  });

  it('nulls every variant, with a warning, when the answer has no JSON object or the call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await run('📊 3 aziende assumono a Lugano')).toEqual({ concreto: null, curioso: null });
      expect(await generateAISubjects(ctx('it'), { llm: async () => { throw new Error('quota'); } })).toEqual({ concreto: null, curioso: null });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    expect(await generateAISubjects(ctx('it'), { llm: null as any })).toEqual({ concreto: null, curioso: null });
  });

  it('accepts the same subjects as before (10..55 characters, a 3-letter word)', () => {
    expect(acceptAISubject('  "📊 3 aziende assumono a Lugano"  ')).toBe('📊 3 aziende assumono a Lugano');
    expect(acceptAISubject('💼 !!!!!!!!!')).toBeNull();
    expect(acceptAISubject('x'.repeat(56))).toBeNull();
    expect(acceptAISubject(undefined)).toBeNull();
  });
});

describe('composeLocaleSubjects — one call per locale', () => {
  const cohorts = new Map(LOCALES.map((locale, n) => [`${locale}:${n}`, { locale, subscriber: { locale }, members: [{}], matchedJobs: [job(n, 'Contabile')] }]));

  it('asks once per locale for every variant and falls back per variant', async () => {
    const phase2 = await composeCohortBriefings(cohorts, { locales: LOCALES, exchangeRate: EXCHANGE, generate: null });
    const generate = vi.fn(async (c: { subscriber: { locale: string }; variants: string[] }) =>
      (c.subscriber.locale === 'de' ? null : { concreto: `📊 concreto ${c.subscriber.locale} Lugano`, curioso: c.subscriber.locale === 'fr' ? null : `🤔 curioso ${c.subscriber.locale}?` }));
    const subjects = await composeLocaleSubjects(cohorts, { locales: LOCALES, variantIds: VARIANTS, briefingMap: phase2.briefingMap, exchangeRate: EXCHANGE, generate });

    expect(generate).toHaveBeenCalledTimes(LOCALES.length);
    for (const [c] of generate.mock.calls as any[]) expect(c.variants).toEqual(VARIANTS);
    expect(subjects.size).toBe(LOCALES.length * VARIANTS.length);
    expect(subjects.get(newsletterSubjectKey('it', 'curioso'))).toBe('🤔 curioso it?');
    expect(subjects.get(newsletterSubjectKey('fr', 'concreto'))).toBe('📊 concreto fr Lugano');
    expect(subjects.get(newsletterSubjectKey('fr', 'curioso'))).toBe(getVariantFallback('curioso', 'fr'));
    for (const v of VARIANTS) expect(subjects.get(newsletterSubjectKey('de', v))).toBe(getVariantFallback(v, 'de'));
  });
});

describe('subject Theme without the jobs paragraph opening', () => {
  const OPENINGS = /concret|konkret|Looking for something|Auf der Suche|Vous cherchez|Se cerchi/i;

  it.each(LOCALES)('%s: one job or several, the Theme starts with the first job', async (locale) => {
    for (const jobs of [[job(0, 'Contabile')], [job(0, 'Contabile'), job(1, 'Cuoco'), job(2, 'Tecnico di laboratorio chimico')]]) {
      const cohorts = new Map([[`${locale}:0`, { locale, subscriber: { locale }, members: [{}], matchedJobs: jobs }]]);
      let theme = '';
      await composeLocaleSubjects(cohorts, {
        locales: [locale],
        variantIds: VARIANTS,
        briefingFor: async () => `<p>${locale} apertura del briefing sul cambio ${'parola '.repeat(60).trim()}.</p>`,
        exchangeRate: EXCHANGE,
        generate: async (c: { briefingSummary: string }) => { theme = c.briefingSummary; return null; },
      });
      expect(theme.startsWith('Contabile')).toBe(true);
      expect(theme).not.toMatch(OPENINGS);
    }
  });
});
