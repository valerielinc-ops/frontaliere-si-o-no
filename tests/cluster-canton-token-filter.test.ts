/**
 * A canton name, the "canton/kanton" marker and cross-border context words
 * ("frontalieri") are not CONTENT of a search-landing query: the canton FILTERS
 * the jobs, the rest never narrows them. Covers both families that emit search
 * landings: the GSC orphan clusters (`/ricerca/<slug>/`, orphanQueryData.ts) and
 * the related-search clusters (relatedSearchClustersPlugin.ts).
 *
 * Origin: `/ricerca/offerte-di-lavoro-canton-ticino-per-frontalieri/` had 13 GSC
 * clicks but matched no job ("canton" and "frontalier" had to sit in a job
 * title), shipped noindex and said "no openings", while its sibling
 * `/ricerca/offerte-di-lavoro-canton-ticino/` only matched by coincidence.
 */
import { describe, expect, it } from 'vitest';
import {
  selectOrphanLandingJobs,
  type OrphanCountableJob,
  type OrphanQueryCluster,
} from '../build-plugins/orphanQueryData';
import { TokenIndex, buildClusterContext, normalizeClusterQuery } from '../build-plugins/relatedSearchClustersPlugin';
import type { CandidateEntry, RawJob } from '../build-plugins/relatedSearchClustersData';
import { classifyClusterToken, splitClusterTokens } from '../build-plugins/shared/clusterQueryTokens';

const LONG_DESCRIPTION = Array.from({ length: 60 }, (_, i) => `parola${i}`).join(' ');

function orphanJob(id: string, title: string, canton: string, location: string): OrphanCountableJob {
  return {
    slug: id,
    title,
    company: 'Acme AG',
    canton,
    location,
    addressLocality: location,
    postedDate: '2026-11-20',
    description: LONG_DESCRIPTION,
    descriptionByLocale: { it: LONG_DESCRIPTION, en: LONG_DESCRIPTION, de: LONG_DESCRIPTION, fr: LONG_DESCRIPTION },
  };
}

function cluster(
  locale: OrphanQueryCluster['locale'],
  slug: string,
  roleTokens: string[],
  regionTokens: string[],
): OrphanQueryCluster {
  return {
    clusterId: `${locale}-${slug}`,
    locale,
    canonicalQuery: slug.replace(/-/g, ' '),
    canonicalSlug: slug,
    roleTokens,
    regionTokens,
    totalImpressions: 100,
    totalClicks: 5,
    queries: [{ query: slug.replace(/-/g, ' '), clicks: 5, impressions: 100 }],
  };
}

const ORPHAN_JOBS: OrphanCountableJob[] = [
  orphanJob('ti-1', 'Impiegato amministrativo', 'TI', 'Lugano'),
  orphanJob('ti-2', 'Magazziniere', 'TI', 'Mendrisio'),
  orphanJob('ti-3', 'Infermiere', 'TI', 'Bellinzona'),
  orphanJob('ti-4', 'Cuoco', 'TI', 'Locarno'),
  orphanJob('be-1', 'Lehrer Mathematik', 'BE', 'Bern'),
  orphanJob('be-2', 'Lehrerin Deutsch', 'BE', 'Thun'),
  orphanJob('be-3', 'Lehrer Sport', 'BE', 'Biel'),
  orphanJob('be-4', 'Koch', 'BE', 'Bern'),
  orphanJob('zh-1', 'Lehrer Physik', 'ZH', 'Zürich'),
];

const ids = (jobs: readonly OrphanCountableJob[]) => jobs.map((j) => j.slug).sort();

describe('clusterQueryTokens', () => {
  it('classifies canton names (4 locales), markers and context words', () => {
    expect(classifyClusterToken('canton')).toEqual({ kind: 'marker' });
    expect(classifyClusterToken('Kantone')).toEqual({ kind: 'marker' });
    expect(classifyClusterToken('frontalieri')).toEqual({ kind: 'context' });
    expect(classifyClusterToken('Grenzgänger')).toEqual({ kind: 'context' });
    expect(classifyClusterToken('tessin')).toEqual({ kind: 'canton', codes: ['TI'] });
    expect(classifyClusterToken('Zürich')).toEqual({ kind: 'canton', codes: ['ZH'] });
    expect(classifyClusterToken('valais')).toEqual({ kind: 'canton', codes: ['VS'] });
    expect(classifyClusterToken('infermiere')).toBeNull();
    // An employer word that merely starts like the marker stays content.
    expect(classifyClusterToken('cantonale')).toBeNull();
  });

  it('splits cantons from content and leaves untouched queries alone', () => {
    expect(splitClusterTokens(['canton', 'ticino', 'per', 'frontalieri'])).toEqual({
      content: [],
      cantonCodes: ['TI'],
      removed: true,
    });
    expect(splitClusterTokens(['kanton', 'bern', 'lehrer'])).toEqual({
      content: ['lehrer'],
      cantonCodes: ['BE'],
      removed: true,
    });
    expect(splitClusterTokens(['koch', 'san', 'gallo']).cantonCodes).toEqual(['SG']);
    // Connectives are dropped only when something else was removed.
    expect(splitClusterTokens(['assistente', 'di', 'cura'])).toEqual({
      content: ['assistente', 'di', 'cura'],
      cantonCodes: [],
      removed: false,
    });
  });
});

describe('orphan landings (/ricerca/): canton token = filter', () => {
  const generic = cluster('it', 'offerte-di-lavoro-canton-ticino-per-frontalieri', ['canton', 'frontalier', 'lavor', 'offert'], ['ticino']);
  const sibling = cluster('it', 'offerte-di-lavoro-canton-ticino', ['canton', 'lavor', 'offert'], ['ticino']);

  it('cantone + context word only: shows the canton jobs, indexable', () => {
    const sel = selectOrphanLandingJobs(ORPHAN_JOBS, generic, 15, 3);
    expect(ids(sel.jobs)).toEqual(['ti-1', 'ti-2', 'ti-3', 'ti-4']);
    expect(sel.regionRelevant).toBe(true);
  });

  it('the sibling with traffic keeps the same indexable state and listing', () => {
    const a = selectOrphanLandingJobs(ORPHAN_JOBS, sibling, 15, 3);
    const b = selectOrphanLandingJobs(ORPHAN_JOBS, generic, 15, 3);
    expect(a.regionRelevant).toBe(true);
    expect(a.jobs.length).toBeGreaterThanOrEqual(3);
    expect(ids(a.jobs)).toEqual(ids(b.jobs));
  });

  it('cantone + trade: only that trade, filtered by canton', () => {
    const sel = selectOrphanLandingJobs(ORPHAN_JOBS, cluster('de', 'stellen-kanton-bern-lehrer', ['kanton', 'lehrer', 'stellen'], ['berna']), 15, 3);
    expect(ids(sel.jobs)).toEqual(['be-1', 'be-2', 'be-3']);
  });

  it('a canton named only among the role tokens is still a filter', () => {
    const sel = selectOrphanLandingJobs(ORPHAN_JOBS, cluster('de', 'jobs-kanton-bern', ['job', 'kanton', 'bern'], []), 15, 3);
    expect(ids(sel.jobs)).toEqual(['be-1', 'be-2', 'be-3', 'be-4']);
  });

  it('a query that is only context words shows every active job', () => {
    const sel = selectOrphanLandingJobs(ORPHAN_JOBS, cluster('it', 'frontalieri', ['frontalier'], []), 15, 3);
    expect(sel.jobs).toHaveLength(ORPHAN_JOBS.length);
  });

  it('an employer token that only looks like the marker still has to match', () => {
    const sel = selectOrphanLandingJobs(ORPHAN_JOBS, cluster('it', 'ente-cantonale', ['cantonal', 'ente'], []), 15, 3);
    expect(sel.jobs).toHaveLength(0);
  });
});

describe('related-search clusters: canton token = filter', () => {
  const job = (id: string, title: string, canton: string, location: string): RawJob => ({
    id, title, company: 'Acme AG', location, canton,
  });
  const JOBS: RawJob[] = [
    job('ti-1', 'Impiegato amministrativo', 'TI', 'Lugano'),
    job('ti-2', 'Magazziniere', 'TI', 'Mendrisio'),
    job('ti-3', 'Infermiere', 'TI', 'Bellinzona'),
    job('ti-4', 'Cuoco', 'TI', 'Locarno'),
    job('be-1', 'Lehrer Mathematik', 'BE', 'Bern'),
    job('be-2', 'Lehrerin Deutsch', 'BE', 'Thun'),
    job('be-3', 'Lehrer Sport', 'BE', 'Biel'),
    job('zh-1', 'Lehrer Physik', 'ZH', 'Zürich'),
  ];
  const candidate = (term: string, locale: CandidateEntry['locale'] = 'it'): CandidateEntry => ({
    slug: `ricerca-${term.replace(/\s+/g, '-')}`,
    locale,
    jobCount: 1,
    sampleTerms: [term],
    editorialCollision: null,
  });
  const matched = (term: string, locale: CandidateEntry['locale'] = 'it') =>
    buildClusterContext(candidate(term, locale), new TokenIndex(JOBS), JOBS)?.matchingJobs.map((j) => j.id).sort();

  it('normalizeClusterQuery strips boilerplate, canton and context words', () => {
    const q = normalizeClusterQuery('offerte di lavoro canton ticino per frontalieri');
    expect(q.tokens).toEqual([]);
    expect([...q.cantonCodes]).toEqual(['TI']);
    expect(q.removed).toBe(true);
  });

  it('cantone + context word only: the canton jobs, not zero', () => {
    expect(matched('offerte di lavoro canton ticino per frontalieri')).toEqual(['ti-1', 'ti-2', 'ti-3', 'ti-4']);
  });

  it('the sibling with traffic is unchanged: same jobs, above the floor', () => {
    expect(matched('offerte di lavoro canton ticino')).toEqual(['ti-1', 'ti-2', 'ti-3', 'ti-4']);
  });

  it('cantone + trade: that trade in that canton only', () => {
    expect(matched('stellen kanton bern lehrer', 'de')).toEqual(['be-1', 'be-2', 'be-3']);
  });
});
