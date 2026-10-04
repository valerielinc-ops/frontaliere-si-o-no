import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenIndex, buildClusterContext } from '../build-plugins/relatedSearchClustersPlugin';
import type { CandidateEntry, RawJob } from '../build-plugins/relatedSearchClustersData';
import type { Locale } from '../services/i18n';
import * as relevance from '../services/jobSearchRelevance';
import { professionSynonymText } from '../services/professionSynonyms';
import { stemSearchToken } from '../services/searchStem.mjs';

// Frozen pre-cache predicate: keep the oracle independent of the new preparation helper.
function legacyAccept(job: RawJob, locale: Locale, roles: readonly string[]): boolean {
  if (roles.length === 0) return true;
  const localized = job.titleByLocale?.[locale] || job.title;
  const titles = [job.title, localized, job.company, professionSynonymText(localized)]
    .flatMap(relevance.normalizeJobSearchTokens);
  const terms = [...titles, ...titles.map(stemSearchToken)];
  return roles.every(role => relevance.tokenMatchesStem(terms, role));
}

class LegacyIndex extends TokenIndex {
  override matchingOccupationJobs(locale: Locale, tokens: readonly string[], cap: number, floor: number, roles: readonly string[]) {
    return this.matchingJobs(locale, tokens, cap, floor, job => legacyAccept(job, locale, roles));
  }
}

const jobs: RawJob[] = [
  { id: 'nurse', title: 'Infermiera', titleByLocale: { en: 'Nurse', de: 'Pflegefachfrau', fr: 'Infirmière' }, company: 'Clinica', location: 'Lugano', canton: 'TI' },
  { id: 'customs', title: 'Specialista delle dogane', titleByLocale: { en: 'Customs specialist', de: 'Zollfachmann', fr: 'Spécialiste des douanes' }, company: 'Dogane', location: 'Chiasso', canton: 'TI' },
  { id: 'neurology', title: 'Specialista in neurologia', company: 'Ospedale', location: 'Bellinzona', canton: 'TI' },
  { id: 'chef', title: 'Koch', titleByLocale: { en: '', fr: 'Cuisinier' }, company: 'Hotel', location: 'Davos', canton: 'GR' },
  { id: 'company', title: 'Support', company: 'SAP', location: 'Zurich', canton: 'ZH' },
  { id: 'empty' },
];

afterEach(() => vi.restoreAllMocks());

describe('build-scoped occupational terms', () => {
  it('preserves complete cluster contexts across locales and repeated candidates', () => {
    const cached = new TokenIndex(jobs);
    const legacy = new LegacyIndex(jobs);
    const queries = ['infermiere Lugano', 'nurse salary', 'infirmier salaire', 'gehalt koch', 'stipendio specialista delle dogane svizzera', 'SAP', 'offerte lavoro'];
    for (const locale of ['it', 'en', 'de', 'fr', 'it'] as const) {
      for (const query of queries) {
        const candidate: CandidateEntry = { slug: `fixture-${query.replaceAll(' ', '-')}`, locale, jobCount: 5, sampleTerms: [query], editorialCollision: null };
        expect(buildClusterContext(candidate, cached, jobs)).toEqual(buildClusterContext(candidate, legacy, jobs));
      }
    }
  });

  it('preserves AND/OR score ordering, corpus tie breaks and floor before capping', () => {
    const corpus = Array.from({ length: 12 }, (_, i) => ({ id: String(i), title: i < 4 ? 'Neurologo' : 'Infermiere' }));
    const cached = new TokenIndex(corpus);
    const legacy = new LegacyIndex(corpus);
    for (const index of [cached, legacy]) index.seedPostings('it', [
      { token: 'a', list: [0, 1, 4, 6, 8, 10] },
      { token: 'b', list: [0, 2, 4, 7, 8, 11] },
      { token: 'c', list: [0, 3, 4, 5, 8, 9] },
    ]);
    for (const floor of [1, 2, 3]) {
      for (const cap of [1, 3, 30]) {
        expect(cached.matchingOccupationJobs('it', ['a', 'b', 'c'], cap, floor, ['infermier']))
          .toEqual(legacy.matchingOccupationJobs('it', ['a', 'b', 'c'], cap, floor, ['infermier']));
      }
    }
    expect(cached.matchingOccupationJobs('it', ['a', 'b', 'c'], 4, 1, ['infermier']).map(job => job.id)).toEqual(['4', '8', '5', '6']);
  });

  it('prepares once per visited job/locale, skips empty roles, and clears with the index', () => {
    const prepare = vi.spyOn(relevance, 'prepareJobOccupationTerms');
    const index = new TokenIndex(jobs);
    const seed = () => { for (const locale of ['it', 'en'] as const) index.seedPostings(locale, [{ token: 'all', list: jobs.map((_, i) => i) }]); };
    seed();
    index.matchingOccupationJobs('it', ['all'], 30, 1, []);
    expect(prepare).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) index.matchingOccupationJobs('it', ['all'], 30, 1, ['infermier']);
    expect(prepare).toHaveBeenCalledTimes(jobs.length);
    index.matchingOccupationJobs('en', ['all'], 30, 1, ['nurse']);
    expect(prepare).toHaveBeenCalledTimes(jobs.length * 2);
    index.clear();
    seed();
    index.matchingOccupationJobs('it', ['all'], 30, 1, ['infermier']);
    expect(prepare).toHaveBeenCalledTimes(jobs.length * 3);
  });

  it('does not share cached terms between snapshots with the same job ID', () => {
    const nurse = new TokenIndex([{ id: 'same', title: 'Infermiere' }]);
    const chef = new TokenIndex([{ id: 'same', title: 'Koch' }]);
    for (const index of [nurse, chef]) index.seedPostings('it', [{ token: 'all', list: [0] }]);
    expect(nurse.matchingOccupationJobs('it', ['all'], 1, 1, ['infermier'])).toHaveLength(1);
    expect(chef.matchingOccupationJobs('it', ['all'], 1, 1, ['infermier'])).toHaveLength(0);
  });
});
