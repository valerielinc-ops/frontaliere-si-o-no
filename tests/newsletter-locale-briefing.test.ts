// The newsletter asks the AI for ONE briefing per locale and prepends each
// cohort's own jobs deterministically. Cohorts are ~1:1 with subscribers, so
// the former per-cohort batches meant one serialized Codex call per ~3
// recipients: 73 calls / 2h21 for 255 recipients (run 36230809455), ~700 for
// the 2119 cohorts of a fresh Monday campaign (run 35582069095).
import { describe, expect, it, vi } from 'vitest';

import { composeCohortBriefings, composeLocaleSubjects, SUBJECT_THEME_CHARS } from '@/scripts/send-newsletter.mjs';
import { buildBriefingPrompt, buildLocaleBriefingPrompt } from '@/services/newsletter-content-core.mjs';

const EXCHANGE = { rate: 1.0595, previousRate: 1.0557 };
const SHARED = (loc: string) =>
  `<p>${loc} editorial ${'parola '.repeat(60).trim()}.</p>`;

function cohortsFor(spec: Record<string, number>) {
  const cohorts = new Map<string, { locale: string; matchedJobs: any[] }>();
  let n = 0;
  for (const [locale, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i++, n++) {
      cohorts.set(`${locale}:${n}`, {
        locale,
        matchedJobs: [{
          title: `Ruolo ${n}`,
          company: `Azienda${n}`,
          location: 'Lugano',
          url: `/lavoro/ruolo-${n}`,
        }],
      });
    }
  }
  return cohorts;
}

describe('composeCohortBriefings', () => {
  it('calls the AI once per locale, however many cohorts there are', async () => {
    const cohorts = cohortsFor({ it: 200, de: 100 });
    const generate = vi.fn(async (loc: string) => SHARED(loc));

    const out = await composeCohortBriefings(cohorts, { locales: ['it', 'de'], generate, exchangeRate: EXCHANGE });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls.map(([loc]) => loc).sort()).toEqual(['de', 'it']);
    expect(out.aiCohorts).toBe(300);
    expect(out.fallbackCohorts).toBe(0);
    expect(out.briefingMap.size).toBe(300);
  });

  it("prepends each cohort's own jobs, linked, to the shared locale text", async () => {
    const cohorts = cohortsFor({ it: 2 });
    const out = await composeCohortBriefings(cohorts, {
      locales: ['it'],
      generate: async (loc: string) => SHARED(loc),
      exchangeRate: EXCHANGE,
    });

    const first = out.briefingMap.get('it:0')!;
    const second = out.briefingMap.get('it:1')!;
    expect(first).toContain('href="https://frontaliereticino.ch/lavoro/ruolo-0"');
    expect(first).not.toContain('ruolo-1');
    expect(second).toContain('href="https://frontaliereticino.ch/lavoro/ruolo-1"');
    // Jobs first, then the shared editorial.
    expect(first.indexOf('ruolo-0')).toBeLessThan(first.indexOf('it editorial'));
  });

  it('puts only the cohorts of a failed locale on the fallback template', async () => {
    const cohorts = cohortsFor({ it: 3, fr: 2 });
    const out = await composeCohortBriefings(cohorts, {
      locales: ['it', 'fr'],
      generate: async (loc: string) => (loc === 'fr' ? null : SHARED(loc)),
      exchangeRate: EXCHANGE,
    });

    expect(out.aiCohorts).toBe(3);
    expect(out.fallbackCohorts).toBe(2);
    expect(out.localeBriefings.has('fr')).toBe(false);
    const fr = out.briefingMap.get('fr:3')!;
    expect(fr).toContain(EXCHANGE.rate.toFixed(4));
    expect(fr).toContain('href="https://frontaliereticino.ch/lavoro/ruolo-3"');
  });

  it('makes no AI call when AI is off', async () => {
    const out = await composeCohortBriefings(cohortsFor({ it: 4 }), {
      locales: ['it'],
      generate: null,
      exchangeRate: EXCHANGE,
    });
    expect(out.aiCohorts).toBe(0);
    expect(out.fallbackCohorts).toBe(4);
  });
});

describe('buildLocaleBriefingPrompt', () => {
  const ctx = (locale: string) => ({
    locale,
    exchangeRate: EXCHANGE,
    exchangeInsight: null,
    weeklyFact: { text: 'Fatto della settimana', source: 'UST' },
    featuredTool: { title: 'Calcolatore stipendio', description: 'Netto in 30 secondi', toolUrl: '/calcolatore' },
  });

  it('declares a minimum at or above the 50-word gate of sanitizeAIBriefingHtml', () => {
    const { system } = buildLocaleBriefingPrompt(ctx('it'));
    const match = system.match(/between\s+(\d+)\s+and\s+\d+\s+words/i);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(50);
  });

  it('carries only locale-wide data and tells the model to leave jobs out', () => {
    const { system, user } = buildLocaleBriefingPrompt(ctx('it'));
    expect(system).toMatch(/JOBS RULE/);
    expect(user).not.toMatch(/JOB_URL|Matched jobs|Reader/);
    expect(user).toContain('Fatto della settimana');
    expect(user).toContain('Calcolatore stipendio');
  });

  it('uses the same exchange-rate line as the per-reader prompt', () => {
    const { user } = buildLocaleBriefingPrompt(ctx('it'));
    const perReader = buildBriefingPrompt({ ...ctx('it'), subscriber: { locale: 'it' }, matchedJobs: [] });
    expect(user.split('\n\n')[0]).toBe(perReader.user.split('\n\n')[0]);
  });

  it('pins the language and forbids Markdown', () => {
    const { system } = buildLocaleBriefingPrompt(ctx('de-CH'));
    expect(system).toMatch(/Write in German/);
    expect(system).toMatch(/ABSOLUTE LANGUAGE RULE/);
    expect(system).toMatch(/NEVER use Markdown/);
  });
});

// Phases 2 and 3 run together: a subject waits for its locale's AI briefing
// only when the Theme (first 100 characters of the largest cohort's briefing,
// without the jobs paragraph's fixed opening) depends on it, and the Theme is
// the same one the sequential phases produced.
describe('composeLocaleSubjects next to Phase 2', () => {
  const job = (n: number, title: string) => ({ title, company: `Azienda${n}`, location: 'Lugano', url: `/lavoro/ruolo-${n}` });
  function cohortMap(entries: Array<[string, { locale: string; matchedJobs: any[] }]>) {
    return new Map(entries.map(([key, c]) => [key, { ...c, members: [{}], subscriber: { locale: c.locale } }]));
  }
  const aiText = (loc: string) => `<p>${loc} apertura del briefing sul cambio ${'parola '.repeat(60).trim()}.</p>`;

  async function themes(cohorts: Map<string, any>, briefingFor: (loc: string) => Promise<string | null>) {
    const seen = new Map<string, string>();
    await composeLocaleSubjects(cohorts, {
      locales: [...new Set([...cohorts.values()].map((c) => c.locale))],
      variantIds: ['concreto'],
      briefingFor,
      exchangeRate: EXCHANGE,
      generate: async (ctx: { subscriber: { locale: string }; briefingSummary: string }) => {
        seen.set(ctx.subscriber.locale, ctx.briefingSummary);
        return { concreto: 'Oggetto' };
      },
    });
    return seen;
  }
  async function sequentialTheme(cohorts: Map<string, any>, loc: string) {
    const phase2 = await composeCohortBriefings(cohorts, { locales: [loc], generate: async (l: string) => aiText(l), exchangeRate: EXCHANGE });
    const seen = new Map<string, string>();
    await composeLocaleSubjects(cohorts, {
      locales: [loc], variantIds: ['concreto'], briefingMap: phase2.briefingMap, exchangeRate: EXCHANGE,
      generate: async (ctx: { briefingSummary: string }) => { seen.set(loc, ctx.briefingSummary); return { concreto: 'Oggetto' }; },
    });
    return seen.get(loc);
  }

  it('does not wait for the briefing when the jobs paragraph covers the Theme, and keeps the same Theme', async () => {
    const cohorts = cohortMap([['it:0', { locale: 'it', matchedJobs: [
      job(0, 'Specialista in contabilità e controllo di gestione'),
      job(1, 'Responsabile della logistica di magazzino'),
      job(2, 'Tecnico di laboratorio chimico'),
    ] }]]);
    const never = vi.fn(() => new Promise<string | null>(() => {}));
    const seen = await themes(cohorts, never);
    expect(never).not.toHaveBeenCalled();
    expect(seen.get('it')).toHaveLength(SUBJECT_THEME_CHARS);
    expect(seen.get('it')).toBe(await sequentialTheme(cohorts, 'it'));
  });

  it("waits for the locale's AI text when the cohort has no jobs", async () => {
    const cohorts = cohortMap([['de:0', { locale: 'de', matchedJobs: [] }]]);
    const seen = await themes(cohorts, async (loc) => aiText(loc));
    expect(seen.get('de')!.startsWith('de apertura del briefing')).toBe(true);
    expect(seen.get('de')).toBe(await sequentialTheme(cohorts, 'de'));
  });

  it('waits for the briefing when a short jobs paragraph leaves room for its text, with the same Theme', async () => {
    const cohorts = cohortMap([['fr:0', { locale: 'fr', matchedJobs: [job(0, 'Cuoco')] }]]);
    const briefingFor = vi.fn(async (loc: string) => aiText(loc));
    const seen = await themes(cohorts, briefingFor);
    expect(briefingFor).toHaveBeenCalledWith('fr');
    expect(seen.get('fr')).toBe(await sequentialTheme(cohorts, 'fr'));
  });
});
