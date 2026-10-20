import { describe, expect, it } from 'vitest';
import { checkFabricatedInstitutionAcronyms } from '../scripts/lib/article-factuality-gates.mjs';

describe('official Swiss cybersecurity office acronym', () => {
  it('does not report UFCS as an unknown institution', () => {
    expect(checkFabricatedInstitutionAcronyms(
      'Autorità → Ufficio federale della cibersicurezza (UFCS)',
    )).toEqual([]);
  });
});
