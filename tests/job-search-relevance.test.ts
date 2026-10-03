import { describe, expect, it } from 'vitest';
import { getJobSearchRoleTokens, matchesJobOccupation } from '../services/jobSearchRelevance';
import { hasSalaryIntent, hasActiveSalarySearchIntent, isSalaryModifier } from '../services/jobSearchIntent';

describe('occupational relevance for salary searches', () => {
  it('requires both customs and specialist instead of matching generic Swiss salary text', () => {
    const roles = getJobSearchRoleTokens('stipendio specialista delle dogane svizzera');
    expect(matchesJobOccupation({ title: 'Specialista in neurologia' }, 'it', roles)).toBe(false);
    expect(matchesJobOccupation({ title: 'Specialista delle dogane' }, 'it', roles)).toBe(true);
  });

  it('preserves salary intent after router boilerplate stripping only while the route query is active', () => {
    const slug = 'ricerca-stipendio-specialista-delle-dogane-svizzera';
    expect(hasActiveSalarySearchIntent('specialista delle dogane', 'specialista delle dogane', slug)).toBe(true);
    expect(hasActiveSalarySearchIntent('Python', 'specialista delle dogane', slug)).toBe(false);
    expect(hasActiveSalarySearchIntent('specialista delle dogane', null, slug)).toBe(false);
  });

  it.each(['salair', 'salaire', 'salaires'])('treats French salary form %s as intent, never an occupation', modifier => {
    const query = `${modifier} infirmier Lugano`;
    expect(isSalaryModifier(modifier)).toBe(true);
    expect(hasSalaryIntent(query)).toBe(true);
    const roles = getJobSearchRoleTokens(query);
    expect(roles).toEqual(['infirmier']);
    expect(matchesJobOccupation({ title: 'Infirmier' }, 'fr', roles)).toBe(true);
  });

  it('preserves multilingual occupational synonyms', () => {
    expect(matchesJobOccupation({ title: 'Infermiera' }, 'en', getJobSearchRoleTokens('nurse salary'))).toBe(true);
  });

  it.each(['offres emploi infirmier', 'assunzioni infermieri'])('removes generic query words in %s', query => {
    expect(getJobSearchRoleTokens(query)).toHaveLength(1);
    expect(matchesJobOccupation({ title: 'Infermiere', titleByLocale: { fr: 'Infirmier' } }, 'fr', getJobSearchRoleTokens(query))).toBe(true);
  });

  it.each(['Python', 'koch davos', 'Lohnbuchhalter SAP'])('does not classify free-text query %s as salary intent', query => {
    expect(hasSalaryIntent(query)).toBe(false);
  });

  it.each(['salaire infirmier', 'nurse salaries', 'gehalt koch', 'stipendio doganiere'])('recognizes salary query %s', query => {
    expect(hasSalaryIntent(query)).toBe(true);
  });
});
