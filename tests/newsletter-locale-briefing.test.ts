// The newsletter asks the AI for ONE briefing per locale and prepends each
// cohort's own jobs deterministically. Cohorts are ~1:1 with subscribers, so
// the former per-cohort batches meant one serialized Codex call per ~3
// recipients: 73 calls / 2h21 for 255 recipients (run 36230809455), ~700 for
// the 2119 cohorts of a fresh Monday campaign (run 35582069095).
import { describe, expect, it, vi } from 'vitest';

import { composeCohortBriefings } from '@/scripts/send-newsletter.mjs';
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
