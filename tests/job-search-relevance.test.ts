import { describe, expect, it } from 'vitest';
import {
  classifyJobSearchOccupation,
  getJobSearchRoleProfile,
  getJobSearchRoleTokens,
  matchesJobOccupation,
  matchesJobSearchRoleProfile,
} from '../services/jobSearchRelevance';
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

describe('profession versus qualifier intent', () => {
  const qualifiedProfile = getJobSearchRoleProfile('medico anestesista responsabile');

  it('keeps the medical profession and anaesthesia specialty in the hard core', () => {
    expect(qualifiedProfile).toMatchObject({
      professionId: 'medico',
      professionTokens: ['medic'],
      specialtyTokens: ['anestes'],
      qualifierTokens: ['responsabil'],
      qualifierFamilies: ['leadership'],
    });
  });

  it('does not turn a qualifier-only query into an empty occupation probe', () => {
    expect(getJobSearchRoleProfile('responsabile')).toMatchObject({
      professionalTokens: ['responsabil'],
      qualifierTokens: [],
      qualifierFamilies: [],
    });
  });

  it('treats a known profession phrase as a profession, not as a qualifier', () => {
    for (const query of ['responsabile negozio', 'responsabile del negozio', 'responsable de magasin']) {
      const profile = getJobSearchRoleProfile(query);
      expect(profile, query).toMatchObject({
        professionId: 'responsabile-negozio',
        qualifierTokens: [],
        qualifierFamilies: [],
      });
      expect(matchesJobSearchRoleProfile({ title: 'Responsabile negozio' }, 'it', profile), query).toBe(true);
    }
  });

  it.each([
    'Fachärztin / Facharzt Anästhesiologie mit Führungsverantwortung',
    'Leitende Oberärztin / Leitender Oberarzt Anästhesiologie',
    'Chefärztin Anästhesiologie',
  ])('accepts a physician title with a multilingual leadership marker: %s', (title) => {
    expect(classifyJobSearchOccupation({ title }, 'it', qualifiedProfile)).toMatchObject({
      tier: 'exact',
      coreMatched: true,
      titleQualifierMatched: true,
    });
  });

  it.each([
    'Medizinische Praxisassistentin Anästhesie',
    'Chefarztsekretärin Anästhesie',
    'Medizinstudent Anästhesie',
  ])('rejects a medical support/student title: %s', (title) => {
    expect(matchesJobSearchRoleProfile({ title }, 'it', qualifiedProfile)).toBe(false);
  });

  it('keeps a nursing query distinct from the physician support-title guard', () => {
    const profile = getJobSearchRoleProfile('responsabile infermiere');
    expect(profile.professionId).toBe('infermiere');
    expect(matchesJobSearchRoleProfile({ title: 'Responsabile anesthesia nurse' }, 'en', profile)).toBe(true);
  });

  it('does not promote a generic care responsibility in the description', () => {
    const evidence = classifyJobSearchOccupation({
      title: 'Facharzt Anästhesiologie',
      description: "Il candidato sarà responsabile dell'assistenza ai pazienti.",
    }, 'it', qualifiedProfile);
    expect(evidence.tier).toBe('core');
    expect(matchesJobSearchRoleProfile({
      title: 'Facharzt Anästhesiologie',
      description: "Il candidato sarà responsabile dell'assistenza ai pazienti.",
    }, 'it', qualifiedProfile)).toBe(false);
  });

  it('keeps contextual description evidence separate from the indexable title tier', () => {
    const job = {
      title: 'Facharzt Anästhesiologie',
      description: 'Sarà responsabile della direzione del reparto e del team.',
    };
    expect(classifyJobSearchOccupation(job, 'it', qualifiedProfile).tier).toBe('semantic');
    expect(matchesJobSearchRoleProfile(job, 'it', qualifiedProfile)).toBe(false);
    expect(matchesJobSearchRoleProfile(job, 'it', qualifiedProfile, { allowSemantic: true })).toBe(true);
  });

  it('keeps strict matching title-only without poisoning later semantic classification', () => {
    let descriptionReads = 0;
    let localizedDescriptionReads = 0;
    const job: { title: string; description?: string; descriptionByLocale?: Partial<Record<string, string>> } = {
      title: 'Facharzt Anästhesiologie',
    };
    Object.defineProperty(job, 'description', {
      get() {
        descriptionReads += 1;
        return 'Sarà responsabile della direzione del reparto e del team.';
      },
    });
    Object.defineProperty(job, 'descriptionByLocale', {
      get() {
        localizedDescriptionReads += 1;
        return { it: '' };
      },
    });

    expect(matchesJobSearchRoleProfile(job, 'it', qualifiedProfile, { allowSemantic: false })).toBe(false);
    expect(descriptionReads).toBe(0);
    expect(localizedDescriptionReads).toBe(0);

    expect(classifyJobSearchOccupation(job, 'it', qualifiedProfile).tier).toBe('semantic');
    expect(descriptionReads).toBe(1);
    expect(localizedDescriptionReads).toBe(1);

    // Cached description evidence must not make the strict matcher semantic.
    expect(matchesJobSearchRoleProfile(job, 'it', qualifiedProfile, { allowSemantic: false })).toBe(false);
    expect(matchesJobSearchRoleProfile(job, 'it', qualifiedProfile, { allowSemantic: true })).toBe(true);
    expect(descriptionReads).toBe(1);
    expect(localizedDescriptionReads).toBe(1);
  });

  it.each([
    {
      name: 'a core miss',
      job: { title: 'Lagerist' },
      profile: qualifiedProfile,
      tier: 'none',
    },
    {
      name: 'an exact title match',
      job: { title: 'Leitender Facharzt Anästhesiologie' },
      profile: qualifiedProfile,
      tier: 'exact',
    },
    {
      name: 'an unqualified core match',
      job: { title: 'Facharzt Anästhesiologie' },
      profile: getJobSearchRoleProfile('Facharzt Anästhesiologie'),
      tier: 'core',
    },
  ])('classifies $name without reading descriptions', ({ job, profile, tier }) => {
    const jobWithUnreadableDescriptions = { ...job };
    Object.defineProperty(jobWithUnreadableDescriptions, 'description', {
      get() {
        throw new Error('description should remain lazy for title-only evidence');
      },
    });
    Object.defineProperty(jobWithUnreadableDescriptions, 'descriptionByLocale', {
      get() {
        throw new Error('localized description should remain lazy for title-only evidence');
      },
    });

    expect(classifyJobSearchOccupation(jobWithUnreadableDescriptions, 'it', profile).tier).toBe(tier);
  });
});
