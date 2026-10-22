import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderClusterPage, TokenIndex, buildClusterContext } from '../build-plugins/relatedSearchClustersPlugin';
import type { CandidateEntry, RawJob } from '../build-plugins/relatedSearchClustersData';
import type { Locale } from '../services/i18n';
import * as relevance from '../services/jobSearchRelevance';
import { professionSynonymText } from '../services/professionSynonyms';
import { stemSearchToken } from '../services/searchStem.mjs';
import { SPA_ENTRY_CSS_FILENAME, SPA_ENTRY_JS_FILENAME } from '../build-plugins/shared/spaEntryFilenames';

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

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmpDirs: string[] = [];

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-occupation-'));
  tmpDirs.push(dir);
  const assetsDir = join(dir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, SPA_ENTRY_JS_FILENAME), 'console.log(1)', 'utf8');
  writeFileSync(join(assetsDir, SPA_ENTRY_CSS_FILENAME), 'body{}', 'utf8');
  return dir;
}

describe('build-scoped occupational terms', () => {
  it('does not classify ordinary role queries through the qualifier taxonomy', () => {
    const profile = vi.spyOn(relevance, 'getJobSearchRoleProfile');
    const candidate: CandidateEntry = {
      slug: 'fixture-infermiere-lugano',
      locale: 'it',
      jobCount: 5,
      sampleTerms: ['infermiere Lugano'],
      editorialCollision: null,
    };

    buildClusterContext(candidate, new TokenIndex(jobs), jobs);

    expect(profile).not.toHaveBeenCalled();
  });

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

  it('keeps matching and rendered HTML byte-identical when most postings are rejected', () => {
    const corpus: RawJob[] = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      title: i < 997 ? 'Support' : 'Infermiere',
      company: 'Fixture',
      location: 'Lugano',
      canton: 'TI',
    }));
    const candidate: CandidateEntry = {
      slug: 'ricerca-infermiere-lugano',
      locale: 'it',
      jobCount: corpus.length,
      sampleTerms: ['infermiere Lugano'],
      editorialCollision: null,
    };
    const optimized = new TokenIndex(corpus);
    const legacy = new LegacyIndex(corpus);
    const allJobs = corpus.map((_, i) => i);
    for (const index of [optimized, legacy]) index.seedPostings('it', [{ token: 'infermiere', list: allJobs }]);

    const optimizedContext = buildClusterContext(candidate, optimized, corpus);
    const legacyContext = buildClusterContext(candidate, legacy, corpus);
    expect(optimizedContext?.matchingJobs.map(job => job.id)).toEqual(['997', '998', '999']);
    expect(optimizedContext?.matchingJobs.map(job => job.id)).toEqual(legacyContext?.matchingJobs.map(job => job.id));

    const dateStamp = new Date().toISOString().slice(0, 10);
    const render = (ctx: NonNullable<typeof optimizedContext>): string => renderClusterPage({
      distDir: makeDist(),
      dateStamp,
      ctx,
      enriched: undefined,
      hreflang: [],
      related: [],
    }).html;
    expect(render(optimizedContext!)).toBe(render(legacyContext!));
  });

  it('keeps sparse OR merges in score/corpus order without scanning untouched jobs', () => {
    const corpus = Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: 'Role' }));
    const index = new TokenIndex(corpus);
    index.seedPostings('it', [
      { token: 'a', list: [10, 30, 50] },
      { token: 'b', list: [20, 30, 40] },
      { token: 'c', list: [5, 20, 30] },
    ]);

    // The touched set is deliberately much smaller than the corpus. The
    // result must still be AND first, then OR score descending with corpus
    // order as the tie-break (30, 20, then 5, 10, 40, 50).
    expect(index.matchingOccupationJobs('it', ['a', 'b', 'c'], 6, 1, ['role']).map(job => job.id))
      .toEqual(['30', '20', '5', '10', '40', '50']);
  });

  it('clears scratch scores without sorting when the floor leaves no OR levels', () => {
    const index = new TokenIndex(Array.from({ length: 4 }, (_, i) => ({ id: String(i), title: 'Role' })));
    index.seedPostings('it', [
      { token: 'a', list: [3] },
      { token: 'b', list: [1] },
    ]);
    const sort = vi.spyOn(Array.prototype, 'sort');

    expect(index.matchingJobs('it', ['a', 'b'], 30, 2)).toEqual([]);
    expect(sort).not.toHaveBeenCalled();
    expect(Array.from(Reflect.get(index, 'scratchScores') as Uint8Array)).toEqual([0, 0, 0, 0]);
  });

  it('prepares once per job/locale, skips empty roles, and clears with the index', () => {
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
