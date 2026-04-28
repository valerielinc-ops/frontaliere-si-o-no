import { describe, expect, it } from 'vitest';
import { buildBriefingPrompt } from '../services/newsletter-content.mjs';

const baseCtx = (locale: 'it' | 'en' | 'de' | 'fr') => ({
  subscriber: { locale, preferences: {}, locationInterest: null, sectorInterest: null },
  exchangeRate: { rate: 0.94, previousRate: 0.94 },
  exchangeInsight: null,
  matchedJobs: [],
  weeklyFact: null,
  featuredTool: null,
});

describe('buildBriefingPrompt — locale-aware example', () => {
  it('IT prompt contains an Italian-flavoured example', () => {
    const { system } = buildBriefingPrompt(baseCtx('it'));
    expect(system).toContain('presso');
  });

  it('EN prompt does NOT contain Italian phrasings (presso/dai un\'occhiata/alla posizione di)', () => {
    const { system } = buildBriefingPrompt(baseCtx('en'));
    expect(system).not.toMatch(/\bpresso\b/);
    expect(system).not.toMatch(/dai un['']occhiata/i);
    expect(system).not.toMatch(/alla posizione di/i);
    // And it DOES contain natural EN phrasings
    expect(system).toMatch(/\bat\b/);
    expect(system).toMatch(/\bin\b/);
  });

  it('DE prompt contains German preposition "bei" and not Italian "presso"', () => {
    const { system } = buildBriefingPrompt(baseCtx('de'));
    expect(system).toContain('bei');
    expect(system).not.toMatch(/\bpresso\b/);
  });

  it('FR prompt contains French preposition "chez" and not Italian "presso"', () => {
    const { system } = buildBriefingPrompt(baseCtx('fr'));
    expect(system).toContain('chez');
    expect(system).not.toMatch(/\bpresso\b/);
  });

  it('every non-IT prompt contains an ABSOLUTE LANGUAGE RULE', () => {
    for (const locale of ['en', 'de', 'fr'] as const) {
      const { system } = buildBriefingPrompt(baseCtx(locale));
      expect(system).toMatch(/ABSOLUTE LANGUAGE RULE/);
    }
  });
});
