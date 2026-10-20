// Both A/B subjects of a locale come from ONE AI call (4 calls per run instead
// of 8): the model sees both style directives and writes two arms that differ
// in hook, where separate calls wrote two job subjects with 💼 in both arms.
// The measured cost is in tests/newsletter-subjects-real-measure.test.ts.
import { describe, expect, it, vi } from 'vitest';

import {
  acceptAISubject,
  acceptAISubjectTemplate,
  composeCohortBriefings,
  composeLocaleSubjects,
  generateLocaleNewsletterContent,
  generateAISubjects,
  newsletterSubjectKey,
  renderNewsletterSubject,
} from '@/scripts/send-newsletter.mjs';
import { buildLocaleNewsletterContentPrompt, buildSubjectPrompt, buildSubjectVariantsPrompt } from '@/services/newsletter-content-core.mjs';
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
const emptySubjects = () => Object.fromEntries(VARIANTS.map((variant) => [variant, null]));
const withSubjects = (subjects: Record<string, string | null>) => ({ ...emptySubjects(), ...subjects });
const VALID_SUBJECTS = {
  concreto: '📊 3 aziende assumono a Lugano',
  curioso: '🤔 Permesso G o B? Il calcolo che conta',
  pratico: '✅ 3 passi per capire il tuo netto',
  novita: '🆕 Cosa cambia questa settimana?',
};

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
    // The one-subject preview may use reader-specific hints; the production
    // variant prompt is shared by the whole locale and must not leak them.
    expect(user).not.toBe(buildSubjectPrompt({ ...ctx(locale), variant: VARIANTS[0] }).user);
    expect(user).not.toMatch(/Azienda0|Contabile|Lugano/);
  });

  it('does not expose the representative job in a shared subject prompt', () => {
    const { system, user } = buildSubjectVariantsPrompt({
      ...ctx('it'),
      matchedJobs: [{ title: 'Operaio', company: 'Sintetica SA', location: 'Mendrisio' }],
      briefingSummary: 'Operaio presso Sintetica SA a Mendrisio',
    });

    expect(user).not.toMatch(/Sintetica|Operaio|Mendrisio/);
    expect(system).toMatch(/reused for every Italian-speaking reader/i);
    expect(system).toMatch(/Do not mention any employer, job title/i);
    expect(system).not.toContain('Number + location');
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
    const llm = vi.fn(async () => JSON.stringify(VALID_SUBJECTS));
    const out = await generateAISubjects(ctx('it'), { llm });
    expect(llm).toHaveBeenCalledTimes(1);
    expect((llm.mock.calls[0] as any[])[1].jsonSchema.schema.required).toEqual(VARIANTS);
    expect(out).toEqual(VALID_SUBJECTS);
  });

  it('reads a fenced answer and an already-decoded object', async () => {
    const partial = { concreto: '📊 3 aziende assumono a Lugano', curioso: '🤔 Chi assume davvero a Lugano?' };
    expect(await run(`\`\`\`json\n${JSON.stringify(partial)}\n\`\`\``)).toEqual(withSubjects(partial));
    expect(await run({ concreto: '"📊 3 aziende assumono a Lugano"', curioso: '🤔 Chi assume davvero a Lugano?' }))
      .toEqual(withSubjects(partial));
  });

  it('nulls only the variant that is missing or unusable', async () => {
    expect(await run('{"concreto":"📊 3 aziende assumono a Lugano"}')).toEqual(withSubjects({ concreto: '📊 3 aziende assumono a Lugano' }));
    expect(await run(JSON.stringify({ concreto: '💼', curioso: `🤔 ${'parola '.repeat(12)}` }))).toEqual(emptySubjects());
    expect(await run({ concreto: '📊 3 aziende assumono a Lugano', curioso: 42 })).toEqual(withSubjects({ concreto: '📊 3 aziende assumono a Lugano' }));
  });

  it('nulls every variant, with a warning, when the answer has no JSON object or the call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await run('📊 3 aziende assumono a Lugano')).toEqual(emptySubjects());
      expect(await generateAISubjects(ctx('it'), { llm: async () => { throw new Error('quota'); } })).toEqual(emptySubjects());
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    expect(await generateAISubjects(ctx('it'), { llm: null as any })).toEqual(emptySubjects());
  });

  it('accepts the same subjects as before (10..55 characters, a 3-letter word)', () => {
    expect(acceptAISubject('  "📊 3 aziende assumono a Lugano"  ')).toBe('📊 3 aziende assumono a Lugano');
    expect(acceptAISubject('💼 !!!!!!!!!')).toBeNull();
    expect(acceptAISubject('x'.repeat(56))).toBeNull();
    expect(acceptAISubject(undefined)).toBeNull();
  });
});

describe('combined locale newsletter content', () => {
  const briefing = `<p>${'Questa settimana trovi dati utili per lavorare tra Italia e Svizzera. '.repeat(5).trim()} Il cambio resta sotto controllo.</p>`;
  const localeCtx = {
    locale: 'it',
    exchangeRate: EXCHANGE,
    exchangeInsight: null,
    weeklyFact: { text: 'Fatto della settimana', source: 'UST' },
    featuredTool: { title: 'Calcolatore stipendio', description: 'Netto in 30 secondi' },
    variants: VARIANTS,
  };

  it('asks for briefing and subject templates in one structured response', () => {
    const { system, user, jsonSchema } = buildLocaleNewsletterContentPrompt(localeCtx);
    expect(system).toContain('single structured response');
    expect(system).toContain('{{job_title}}');
    expect(user).toContain('Fatto della settimana');
    expect(jsonSchema.schema.required).toEqual(['briefing', 'subjects']);
    expect(Object.keys(jsonSchema.schema.properties.subjects.properties)).toEqual(VARIANTS);
  });

  it('keeps the exact recipient job in the rendered subject without extra AI calls', async () => {
    const llm = vi.fn(async () => JSON.stringify({
      briefing,
      subjects: {
        concreto: '📊 {{job_count}} aziende assumono a {{location}}',
        curioso: '🤔 {{company}} cerca {{job_title}}?',
      },
    }));
    const content = await generateLocaleNewsletterContent(localeCtx, { llm });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(content?.briefing).toContain('Questa settimana');
    expect(content?.subjects.curioso).toContain('{{company}}');

    const sint = renderNewsletterSubject(content?.subjects.curioso, {
      matchedJobs: [{ title: 'Operaio', company: 'Sintetica SA', location: 'Mendrisio' }],
      locale: 'it',
      variant: 'curioso',
    });
    const relewant = renderNewsletterSubject(content?.subjects.curioso, {
      matchedJobs: [{ title: 'Java Sviluppatore', company: 'ReleWant', location: 'Chiasso' }],
      locale: 'it',
      variant: 'curioso',
    });
    expect(sint).toContain('Sintetica SA');
    expect(sint).toContain('Operaio');
    expect(sint).not.toContain('ReleWant');
    expect(relewant).toContain('ReleWant');
    expect(relewant).not.toContain('Sintetica');
  });

  it('rejects unsupported subject placeholders and falls back for missing job data', () => {
    expect(acceptAISubjectTemplate('💼 {{employer}} assume a {{location}}')).toBeNull();
    expect(acceptAISubjectTemplate('💼 {{company}} assume a {{location}}')).toBe('💼 {{company}} assume a {{location}}');
    expect(renderNewsletterSubject('💼 {{company}} assume a {{location}}', { locale: 'it', variant: 'concreto', matchedJobs: [] }))
      .toBe(getVariantFallback('concreto', 'it'));
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
    for (const [c] of generate.mock.calls as any[]) {
      expect(c.variants).toEqual(VARIANTS);
      expect(c.sharedAcrossLocale).toBe(true);
    }
    expect(subjects.size).toBe(LOCALES.length * VARIANTS.length);
    expect(subjects.get(newsletterSubjectKey('it', 'curioso'))).toBe('🤔 curioso it?');
    expect(subjects.get(newsletterSubjectKey('fr', 'concreto'))).toBe('📊 concreto fr Lugano');
    expect(subjects.get(newsletterSubjectKey('fr', 'curioso'))).toBe(getVariantFallback('curioso', 'fr'));
    for (const v of VARIANTS) expect(subjects.get(newsletterSubjectKey('de', v))).toBe(getVariantFallback(v, 'de'));
  });
});
