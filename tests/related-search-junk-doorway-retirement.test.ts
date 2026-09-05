/**
 * Regression gate for the junk-doorway RETIREMENT (issue #7316).
 *
 * The junk denylist guard in `buildClusterContext` stops emitting a thin
 * doorway, which is not the same as withdrawing one that is already
 * published: the served corpus is reassembled across deploys, so measured
 * live on 2026-09-04 `/cerca-lavoro-svizzera/ricerca-cookie-bern/`,
 * `…/ricerca-pazienti-baden/` and `…/ricerca-owner-zurich/` all answered 200
 * while no hub page linked them — orphaned AND indexable.
 *
 * These tests pin the withdrawal artefact: for a junk keyword the plugin must
 * produce the retirement paths and a `noindex,follow` document canonicalized
 * to the locale search hub, not merely skip the page.
 */

import { describe, expect, it } from 'vitest';
import {
  buildClusterContext,
  buildJunkRetirementHtml,
  clusterKeywordFromCandidate,
  enumerateJunkRetirements,
  TokenIndex,
} from '../build-plugins/relatedSearchClustersPlugin';
import type { CandidateEntry, RawJob } from '../build-plugins/relatedSearchClustersData';

const JUNK: CandidateEntry = {
  slug: 'ricerca-cookie-bern',
  locale: 'it',
  jobCount: 20,
  sampleTerms: ['cookie Bern'],
  editorialCollision: null,
};

const REAL: CandidateEntry = {
  slug: 'ricerca-infermiere-lugano',
  locale: 'it',
  jobCount: 12,
  sampleTerms: ['infermiere Lugano'],
  editorialCollision: null,
};

const JOBS: RawJob[] = [
  { id: 'a', title: 'Infermiere', company: 'EOC', location: 'Lugano', canton: 'TI' },
  { id: 'b', title: 'Infermiere diplomato', company: 'Clinica', location: 'Lugano', canton: 'TI' },
  { id: 'c', title: 'Infermiere di sala', company: 'Moncucco', location: 'Lugano', canton: 'TI' },
];

describe('enumerateJunkRetirements — the already-published doorway gets a withdrawal', () => {
  it('lists the junk candidate and skips the real one', () => {
    const retirements = enumerateJunkRetirements([JUNK, REAL]);
    expect(retirements.map((r) => r.slug)).toEqual(['ricerca-cookie-bern']);
    expect(retirements[0].keyword.toLowerCase()).toBe('cookie');
  });

  it('covers the Svizzera aggregate canonical AND the legacy TI mirror', () => {
    const [retirement] = enumerateJunkRetirements([JUNK]);
    expect(retirement.paths).toContain('/cerca-lavoro-svizzera/ricerca-cookie-bern/');
    expect(retirement.paths).toContain('/cerca-lavoro-ticino/ricerca-cookie-bern/');
  });

  it('merges the GSC/GA4-observed indexed URLs, trailing slash normalized', () => {
    const indexed = new Map<string, string[]>([
      ['it::ricerca-cookie-bern', ['/cerca-lavoro-zurigo/ricerca-cookie-bern']],
    ]);
    const [retirement] = enumerateJunkRetirements([JUNK], indexed);
    expect(retirement.paths).toContain('/cerca-lavoro-zurigo/ricerca-cookie-bern/');
    // No duplicates: the same path from two sources collapses to one write.
    expect(new Set(retirement.paths).size).toBe(retirement.paths.length);
  });

  it('dedupes candidates sharing a (locale, slug)', () => {
    expect(enumerateJunkRetirements([JUNK, { ...JUNK, jobCount: 3 }])).toHaveLength(1);
  });

  it('classifies through the same helper the emit guard uses', () => {
    // Binding assertion: the two sides must never disagree about which
    // doorway is junk, or the withdrawal would land on a live page.
    const index = new TokenIndex(JOBS);
    expect(buildClusterContext(JUNK, index, JOBS)).toBeNull();
    expect(clusterKeywordFromCandidate(JUNK)?.keyword.toLowerCase()).toBe('cookie');
    expect(enumerateJunkRetirements([REAL])).toEqual([]);
    expect(buildClusterContext(REAL, index, JOBS)).not.toBeNull();
  });
});

describe('buildJunkRetirementHtml — 200 + noindex,follow → search hub', () => {
  it('emits noindex,follow (the removal signal), not a plain 200 page', () => {
    const html = buildJunkRetirementHtml('it');
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
  });

  it('canonicalizes and links to the locale search hub', () => {
    expect(buildJunkRetirementHtml('it')).toContain('href="https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca/"');
    expect(buildJunkRetirementHtml('en')).toContain('href="https://frontaliereticino.ch/en/find-jobs-ticino/search/"');
    expect(buildJunkRetirementHtml('de')).toContain('href="https://frontaliereticino.ch/de/jobs-im-tessin/suche/"');
    expect(buildJunkRetirementHtml('fr')).toContain('href="https://frontaliereticino.ch/fr/trouver-emploi-tessin/recherche/"');
  });

  it('carries the page language of the retired doorway', () => {
    expect(buildJunkRetirementHtml('de')).toContain('<html lang="de">');
  });
});
