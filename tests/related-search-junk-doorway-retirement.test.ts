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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertRetirementsDisjointFromPlan,
  buildClusterContext,
  buildJunkRetirementHtml,
  clusterKeywordFromCandidate,
  enumerateJunkRetirements,
  junkRetirementWrites,
  loadPreviouslyEmittedClusterKeys,
  restoredKeywordLandingPaths,
  TokenIndex,
} from '../build-plugins/relatedSearchClustersPlugin';
import { transformFlatRedirect } from '../build-plugins/flatHtmlRedirectPlugin';
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

/**
 * Publication evidence for the junk slug (issue #7753): the key a previous
 * build's cache manifest recorded, i.e. "this doorway was really emitted".
 * Without it — or without a GSC/GA4-observed URL — there is nothing to
 * withdraw and the enumerator must stay silent.
 */
const PUBLISHED = new Set(['it::ricerca-cookie-bern']);

const JOBS: RawJob[] = [
  { id: 'a', title: 'Infermiere', company: 'EOC', location: 'Lugano', canton: 'TI' },
  { id: 'b', title: 'Infermiere diplomato', company: 'Clinica', location: 'Lugano', canton: 'TI' },
  { id: 'c', title: 'Infermiere di sala', company: 'Moncucco', location: 'Lugano', canton: 'TI' },
];

describe('enumerateJunkRetirements — the already-published doorway gets a withdrawal', () => {
  it('lists the junk candidate and skips the real one', () => {
    const retirements = enumerateJunkRetirements([JUNK, REAL], new Map(), PUBLISHED);
    expect(retirements.map((r) => r.slug)).toEqual(['ricerca-cookie-bern']);
    expect(retirements[0].keyword.toLowerCase()).toBe('cookie');
  });

  it('covers the Svizzera aggregate canonical AND the legacy TI mirror', () => {
    const [retirement] = enumerateJunkRetirements([JUNK], new Map(), PUBLISHED);
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
    expect(
      enumerateJunkRetirements([JUNK, { ...JUNK, jobCount: 3 }], new Map(), PUBLISHED),
    ).toHaveLength(1);
  });

  it('classifies through the same helper the emit guard uses', () => {
    // Binding assertion: the two sides must never disagree about which
    // doorway is junk, or the withdrawal would land on a live page.
    const index = new TokenIndex(JOBS);
    expect(buildClusterContext(JUNK, index, JOBS)).toBeNull();
    expect(clusterKeywordFromCandidate(JUNK)?.keyword.toLowerCase()).toBe('cookie');
    expect(enumerateJunkRetirements([REAL], new Map(), new Set(['it::ricerca-infermiere-lugano']))).toEqual([]);
    expect(buildClusterContext(REAL, index, JOBS)).not.toBeNull();
  });
});

describe('enumerateJunkRetirements — no withdrawal without evidence of publication (issue #7753)', () => {
  it('emits NOTHING for a junk candidate no build ever published', () => {
    // The defect: the two synthetic paths (aggregate canonical + TI mirror)
    // were added before any source was consulted, so every junk candidate the
    // append-only audit adds (`MIN_JOB_COUNT = 1`) grew two brand-new thin
    // `noindex` pages at URLs that never existed — creating the doorway
    // instead of retiring it.
    expect(enumerateJunkRetirements([JUNK])).toEqual([]);
    expect(enumerateJunkRetirements([JUNK], new Map(), new Set())).toEqual([]);
  });

  it('does not accept another slug’s evidence for this one', () => {
    expect(enumerateJunkRetirements([JUNK], new Map(), new Set(['it::ricerca-owner-zurich']))).toEqual([]);
    // Same slug, different locale: the key is the pair, not the slug.
    expect(enumerateJunkRetirements([JUNK], new Map(), new Set(['de::ricerca-cookie-bern']))).toEqual([]);
  });

  it('withdraws on manifest evidence alone, canonical AND legacy mirror', () => {
    // A doorway the emit loop published wrote both paths, so once the pair is
    // known to exist neither is a guess — the path set stays what it was.
    const [retirement] = enumerateJunkRetirements([JUNK], new Map(), PUBLISHED);
    expect(retirement.paths).toEqual([
      '/cerca-lavoro-svizzera/ricerca-cookie-bern/',
      '/cerca-lavoro-ticino/ricerca-cookie-bern/',
    ]);
  });

  it('withdraws on GSC/GA4 evidence alone, with no manifest', () => {
    // `data/indexed-cluster-urls.json` only knows the URLs still SEEN; a
    // manifest is the plugin's own record. Either one answers the question.
    const indexed = new Map<string, string[]>([
      ['it::ricerca-cookie-bern', ['/cerca-lavoro-zurigo/ricerca-cookie-bern']],
    ]);
    const [retirement] = enumerateJunkRetirements([JUNK], indexed, new Set());
    expect(retirement.paths).toContain('/cerca-lavoro-zurigo/ricerca-cookie-bern/');
    expect(retirement.paths).toContain('/cerca-lavoro-svizzera/ricerca-cookie-bern/');
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

describe('restoredKeywordLandingPaths — cache HIT must not re-plan a withdrawal', () => {
  const CLUSTER = 'cerca-lavoro-svizzera/ricerca-infermiere-lugano/index.html';
  const RETIRED = 'cerca-lavoro-svizzera/ricerca-cookie-bern/index.html';

  it('keeps real cluster landings in the plan', () => {
    expect(restoredKeywordLandingPaths([CLUSTER])).toEqual([
      '/cerca-lavoro-svizzera/ricerca-infermiere-lugano',
    ]);
  });

  it('excludes retired doorways, so hreflang strips their alternates', () => {
    // The emit path never pushes a retirement into `plannedPaths`; that absence
    // is what makes transformHreflang drop alternates pointing at it. A cache
    // HIT rebuilds the plan from the manifest and must reproduce the absence,
    // or the two build paths signal the opposite thing for the same URL.
    const plan = restoredKeywordLandingPaths([CLUSTER, RETIRED], [RETIRED]);
    expect(plan).toEqual(['/cerca-lavoro-svizzera/ricerca-infermiere-lugano']);
    expect(plan).not.toContain('/cerca-lavoro-svizzera/ricerca-cookie-bern');
  });

  it('still restores the retirement as a FILE — only the plan excludes it', () => {
    // Guards the other half of the bug: dropping retirements from `files` would
    // resurrect the junk doorway on every cache-hit build.
    const files = [CLUSTER, RETIRED];
    expect(files).toContain(RETIRED);
    expect(restoredKeywordLandingPaths(files, [RETIRED])).toHaveLength(1);
  });
});

describe('junkRetirementWrites — the flat sibling is withdrawn too (issue #7751)', () => {
  const PATH = '/cerca-lavoro-svizzera/ricerca-cookie-bern/';
  const HTML = buildJunkRetirementHtml('it');

  it('emits BOTH halves of the pair the doorway was published as', () => {
    // The per-cluster loop emits `<path>/index.html` AND the flat
    // `<path>.html` bridge. Writing only the index left the no-slash URL —
    // the one Google indexed — serving the original doorway bytes.
    expect(junkRetirementWrites(PATH, HTML).map((w) => w.rel)).toEqual([
      'cerca-lavoro-svizzera/ricerca-cookie-bern/index.html',
      'cerca-lavoro-svizzera/ricerca-cookie-bern.html',
    ]);
  });

  it('keeps the withdrawal document itself on the index half', () => {
    const [index] = junkRetirementWrites(PATH, HTML);
    expect(index.html).toBe(HTML);
    expect(index.html).toContain('href="https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca/"');
  });

  it('serves noindex,follow on the flat half, canonicalized to the withdrawal', () => {
    const flat = junkRetirementWrites(PATH, HTML)[1];
    expect(flat.html).toContain('<meta name="robots" content="noindex,follow">');
    expect(flat.html).toContain(
      '<link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-svizzera/ricerca-cookie-bern/">',
    );
    // The old doorway markup is gone — that is the whole point.
    expect(flat.html).not.toContain('ricerca-cookie-bern"');
  });

  it('is byte-identical to what the post-walk would build from the sibling', () => {
    // Binding assertion: the pre-emitted bridge must match
    // `transformFlatRedirect` exactly, or postWalkCoordinator's
    // `html === original` guard misses and rewrites every retirement again.
    const flat = junkRetirementWrites(PATH, HTML)[1];
    const viaPostWalk = transformFlatRedirect({
      filePath: '/dist/cerca-lavoro-svizzera/ricerca-cookie-bern.html',
      distDir: '/dist',
      trimmedBase: 'https://frontaliereticino.ch',
      readSibling: () => HTML,
    });
    expect(flat.html).toBe(viaPostWalk);
  });

  it('normalizes the path form, with or without slashes', () => {
    const bare = junkRetirementWrites('cerca-lavoro-ticino/ricerca-cookie-bern', HTML);
    expect(bare.map((w) => w.rel)).toEqual([
      'cerca-lavoro-ticino/ricerca-cookie-bern/index.html',
      'cerca-lavoro-ticino/ricerca-cookie-bern.html',
    ]);
  });

  it('never produces a `.html` dotfile for an empty path', () => {
    // `dist/.html` would be served for the DIRECTORY URL as
    // application/octet-stream, masking the real index.html.
    expect(junkRetirementWrites('/', HTML)).toEqual([]);
    expect(junkRetirementWrites('', HTML)).toEqual([]);
  });

  it('tags both halves as retired, so a cache HIT re-plans neither', () => {
    // `landingPathFromDistRelative` maps `<path>.html` and
    // `<path>/index.html` to the SAME landing path: an untagged flat would
    // put the withdrawal back into the keyword-landing plan on every hit.
    const rels = junkRetirementWrites(PATH, HTML).map((w) => w.rel);
    expect(restoredKeywordLandingPaths(rels, rels)).toEqual([]);
    expect(restoredKeywordLandingPaths(rels, [rels[0]])).toEqual([
      '/cerca-lavoro-svizzera/ricerca-cookie-bern',
    ]);
  });
});

describe('assertRetirementsDisjointFromPlan — a withdrawal never lands on a live cluster (issue #7752)', () => {
  const RETIREMENTS = enumerateJunkRetirements([JUNK], new Map(), PUBLISHED);
  const LIVE_PLAN = [
    '/cerca-lavoro-svizzera/ricerca-infermiere-lugano/',
    '/cerca-lavoro-ticino/ricerca-infermiere-lugano/',
  ];

  it('throws and NAMES the path when a retirement overlaps a planned landing', () => {
    // The defect this guards: both sets feed `collector.add`, so an overlap
    // was resolved by write order (retirements first, clusters after) — the
    // withdrawal silently lost on the emit path and silently won on a cache
    // HIT, where the rel is tagged retired and the LIVE landing drops out of
    // the plan.
    const colliding = [...LIVE_PLAN, '/cerca-lavoro-svizzera/ricerca-cookie-bern/'];
    expect(() => assertRetirementsDisjointFromPlan(RETIREMENTS, colliding)).toThrow(
      /\/cerca-lavoro-svizzera\/ricerca-cookie-bern \(it::ricerca-cookie-bern\)/,
    );
  });

  it('compares the two path shapes normalized, not verbatim', () => {
    // `plannedPaths` takes the indexed-URL entries straight from the data
    // file; `enumerateJunkRetirements` re-slashes them. A collision must not
    // hide behind a missing trailing slash.
    expect(() =>
      assertRetirementsDisjointFromPlan(RETIREMENTS, ['/cerca-lavoro-ticino/ricerca-cookie-bern']),
    ).toThrow(/issue #7752/);
  });

  it('passes silently on the disjoint sets a healthy build produces', () => {
    // `buildClusterContext` returns null for a junk keyword, so no surviving
    // context shares a (locale, slug) with a retirement: the empty
    // intersection is the normal case, and the guard must not cost a build.
    expect(() => assertRetirementsDisjointFromPlan(RETIREMENTS, LIVE_PLAN)).not.toThrow();
    expect(() => assertRetirementsDisjointFromPlan([], LIVE_PLAN)).not.toThrow();
    expect(() => assertRetirementsDisjointFromPlan(RETIREMENTS, [])).not.toThrow();
  });
});

describe('restoredKeywordLandingPaths — a poisoned manifest fails the cache HIT (issue #7752)', () => {
  const LIVE = 'cerca-lavoro-svizzera/ricerca-infermiere-lugano/index.html';
  const RETIRED = 'cerca-lavoro-svizzera/ricerca-cookie-bern/index.html';
  const RETIRED_FLAT = 'cerca-lavoro-svizzera/ricerca-cookie-bern.html';

  it('throws when a retired rel was written twice — a second writer produced it', () => {
    // `computeCacheKey` hashes the data inputs, not this plugin, so a manifest
    // from a build that predates the emit-path guard is still restorable.
    expect(() => restoredKeywordLandingPaths([LIVE, RETIRED, RETIRED], [RETIRED])).toThrow(
      /ricerca-cookie-bern/,
    );
  });

  it('does NOT fail the half-tagged pair of issue #7751 — that one re-plans by design', () => {
    // A flat sibling left out of `retiredFiles` shares the retired landing
    // path but is not a second writer: the documented behaviour is to put the
    // landing back in the plan, and this guard must not change it.
    expect(restoredKeywordLandingPaths([LIVE, RETIRED_FLAT], [RETIRED])).toContain(
      '/cerca-lavoro-svizzera/ricerca-cookie-bern',
    );
  });

  it('leaves the healthy manifest exactly as it was', () => {
    expect(restoredKeywordLandingPaths([LIVE, RETIRED, RETIRED_FLAT], [RETIRED, RETIRED_FLAT])).toEqual([
      '/cerca-lavoro-svizzera/ricerca-infermiere-lugano',
    ]);
  });
});

describe('loadPreviouslyEmittedClusterKeys — the manifests are the emit record (issue #7753)', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsc-cache-'));
  const cacheDir = path.join(rootDir, '.cache', 'related-search-clusters', 'abc123');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      files: [
        'cerca-lavoro-svizzera/ricerca-cookie-bern/index.html',
        'cerca-lavoro-svizzera/ricerca-cookie-bern.html',
        'fr/trouver-emploi-tessin/recherche-infirmier-lugano/index.html',
        'index.html',
        'sitemap-search-clusters.xml',
      ],
    }),
  );
  afterAll(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  it('counts the Svizzera AGGREGATE canonical, which the mirror parser skips', () => {
    // `parseClusterPathKey` excludes the aggregator on purpose (it is the
    // canonical, never a mirror). The publication question is the opposite
    // one, and the aggregate is where every cluster canonicalizes since #4400.
    expect(loadPreviouslyEmittedClusterKeys(rootDir)).toEqual(
      new Set(['it::ricerca-cookie-bern', 'fr::recherche-infirmier-lugano']),
    );
  });

  it('answers empty — never throws — when there is no cache to read', () => {
    // No evidence from this source is the conservative direction: the
    // candidate simply gets no withdrawal.
    expect(loadPreviouslyEmittedClusterKeys(path.join(rootDir, 'nope'))).toEqual(new Set());
  });

  it('ignores a manifest it cannot parse', () => {
    const broken = path.join(rootDir, '.cache', 'related-search-clusters', 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'manifest.json'), '{ not json');
    expect(loadPreviouslyEmittedClusterKeys(rootDir).has('it::ricerca-cookie-bern')).toBe(true);
  });
});
