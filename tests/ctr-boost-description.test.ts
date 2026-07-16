import { describe, it, expect } from 'vitest';
import { boostDescriptionForCtr } from '../build-plugins/shared/ctrBoostDescription';

describe('boostDescriptionForCtr (issue #4300 plan item 2)', () => {
  it('appends a year marker when description has no year and room is available', () => {
    const out = boostDescriptionForCtr(
      'Guida pratica per calcolare le tasse da frontaliere in Ticino.',
      'it',
      { year: 2026 },
    );
    expect(out).toBe('Guida pratica per calcolare le tasse da frontaliere in Ticino. Aggiornato 2026.');
  });

  it('is a no-op when the description already contains a 4-digit year', () => {
    const original = 'Guida frontaliere 2026: tutto quello che serve sapere sul permesso G.';
    expect(boostDescriptionForCtr(original, 'it', { year: 2026 })).toBe(original);
  });

  it('is a no-op when there is no room within maxLength', () => {
    const original = 'x'.repeat(150);
    expect(boostDescriptionForCtr(original, 'it', { year: 2026, maxLength: 155 })).toBe(original);
  });

  it('is a no-op for empty input', () => {
    expect(boostDescriptionForCtr('', 'it')).toBe('');
  });

  it('never mutates or removes existing text — only appends', () => {
    const original = 'Come funziona la dichiarazione fiscale per i frontalieri.';
    const out = boostDescriptionForCtr(original, 'it', { year: 2026 });
    expect(out.startsWith(original)).toBe(true);
  });

  it.each([
    ['en', ' Updated for 2026.'],
    ['de', ' Aktualisiert 2026.'],
    ['fr', ' Mis à jour 2026.'],
  ] as const)('produces a %s-locale suffix', (locale, expectedSuffix) => {
    const base = 'Guide for cross-border workers in Switzerland.';
    const out = boostDescriptionForCtr(base, locale, { year: 2026 });
    expect(out).toBe(base + expectedSuffix);
  });

  it('respects a custom maxLength boundary exactly (fits vs. does not fit)', () => {
    const suffix = ' Aggiornato 2026.'; // 17 chars
    const fits = 'a'.repeat(100);
    const doesNotFit = 'a'.repeat(100 + suffix.length); // pushes past budget
    expect(boostDescriptionForCtr(fits, 'it', { year: 2026, maxLength: 100 + suffix.length })).toBe(fits + suffix);
    expect(boostDescriptionForCtr(doesNotFit, 'it', { year: 2026, maxLength: 100 + suffix.length })).toBe(doesNotFit);
  });
});
