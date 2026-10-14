import { describe, expect, it } from 'vitest';
import { checkFabricatedNormAcronyms } from '../scripts/lib/article-factuality-gates.mjs';

const codes = (issues: Array<{ code: string }>) => issues.map(({ code }) => code);

describe('ambiguous AG corporate suffix', () => {
  it('does not let the Aargau code suppress a fabricated norm acronym', () => {
    expect(codes(checkFabricatedNormAcronyms(
      'Secondo la LFW, AG, ogni datore di lavoro deve registrare le ore.',
    ))).toContain('fabricated-norm-acronym');
  });

  it('still accepts AG without a comma as a corporate suffix', () => {
    expect(checkFabricatedNormAcronyms(
      'LFW AG gestisce la busta paga dei frontalieri.',
    )).toEqual([]);
  });

  it('still accepts an unambiguous corporate suffix after a comma', () => {
    expect(checkFabricatedNormAcronyms(
      'LFW, GmbH gestisce la busta paga dei frontalieri.',
    )).toEqual([]);
  });
});
