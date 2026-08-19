/**
 * The build→SPA seed for related-search cluster landings.
 *
 * Why it exists: the emitter matches jobs against their DESCRIPTION, the slim
 * index JobBoard loads carries none, so hydration could only ever re-find a
 * subset of what the page prints. Measured on
 * /cerca-lavoro-svizzera/ricerca-offerte-lavoro-assistente-psicologo/: 30 jobs
 * emitted, 6 surviving the client matcher, with on-intent losses
 * ("Psicologo-psicoterapeuta in Psicologia"). The seed hands over the answer
 * the build already computed.
 *
 * Two things are guarded here, and both are about a payload that ships
 * **156.032 times**:
 *
 *  1. The FIELD SET. At 429 B/record the family costs ~1,87 GB of dist. The
 *     failure mode is not a bug, it is a shrug — someone notices a missing
 *     field and reaches for SLIM_INDEX_FIELDS, which is 30 fields instead of
 *     15 and would add another ~1,3 GB. `url` is the specific one to keep out:
 *     it was 19% of the payload on its own and no listing card reads it.
 *  2. The STALE-SEED class. The inline script is never cleared by SPA
 *     navigation, so without a pathname check one cluster page's results
 *     follow the visitor onto the next route.
 *
 * Emitter wiring and the JobBoard tier are asserted against source: importing
 * relatedSearchClustersPlugin pulls a module-scope chain of data/ files, which
 * is the documented "red in a sparse worktree, green in CI" trap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderClusterPage } from '../build-plugins/relatedSearchClustersPlugin';
import { SPA_ENTRY_JS_FILENAME, SPA_ENTRY_CSS_FILENAME } from '../build-plugins/shared/spaEntryFilenames';
import {
  CLUSTER_SEARCH_SEED_FIELDS,
  CLUSTER_SEARCH_SEED_GLOBAL,
  buildClusterSearchSeed,
  pickClusterSeedJob,
  readClusterSearchSeed,
} from '../services/clusterSearchSeed';

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** A record shaped like a real slim-index entry, with realistic field lengths. */
function realisticJob(n: number): Record<string, unknown> {
  return {
    id: `job-${String(n).padStart(8, '0')}`,
    slug: `assistente-psicologo-in-neuropsicologia-stadtspital-zurich-${n}`,
    title: `Assistente psicologo in Neuropsicologia ${n}`,
    company: 'Psychiatrische Universitätsklinik Zürich',
    companyDomain: 'pukzh.ch',
    companyLogo: '',
    location: 'Zürich',
    canton: 'ZH',
    category: 'healthcare',
    contract: 'full-time',
    featured: false,
    postedDate: '2026-08-14',
    salaryMin: 85000,
    salaryMax: 105000,
    currency: 'CHF',
    // Fields that must NOT reach the seed:
    url: 'https://jobs.pukzh.ch/vacancies/12345/assistente-psicologo-neuropsicologia-80-100',
    description: 'x'.repeat(4000),
    qualityScore: 0.82,
    source: 'ats-crawler',
  };
}

describe('cluster search seed — payload shape', () => {
  it('keeps the external apply url and the description out of the payload', () => {
    const picked = pickClusterSeedJob(realisticJob(1));
    // `url` is the external ATS link. buildJobPath() derives the internal href
    // from slug + canton, and the detail view fetches the full record from
    // /data/job-detail/<id>.json when it opens — so 156k copies of it buy
    // nothing. It was 19% of the payload.
    expect(picked).not.toHaveProperty('url');
    expect(picked).not.toHaveProperty('description');
    expect(picked).not.toHaveProperty('qualityScore');
    expect(picked).not.toHaveProperty('source');
  });

  it('drops falsy values instead of serializing them as null', () => {
    const picked = pickClusterSeedJob(realisticJob(1));
    // companyLogo '' and featured false carry no information a card can use.
    expect(picked).not.toHaveProperty('companyLogo');
    expect(picked).not.toHaveProperty('featured');
    expect(pickClusterSeedJob({ ...realisticJob(1), featured: true })).toHaveProperty('featured', true);
  });

  it('pins the field set — this payload ships 156.032 times', () => {
    // Deliberately an exact list, not a subset check: growing it is a real
    // decision (each ~30 B/record field is ~140 MB of dist), so it should
    // require editing this line and reading why.
    expect([...CLUSTER_SEARCH_SEED_FIELDS].sort()).toEqual([
      'canton', 'category', 'company', 'companyDomain', 'companyLogo',
      'contract', 'currency', 'featured', 'id', 'location',
      'postedDate', 'salaryMax', 'salaryMin', 'slug', 'title',
    ]);
  });

  it('stays inside the per-record byte budget measured on the live corpus', () => {
    const seed = buildClusterSearchSeed(
      '/cerca-lavoro-svizzera/ricerca-offerte-lavoro-assistente-psicologo/',
      'assistente psicologo',
      Array.from({ length: 30 }, (_, i) => realisticJob(i)),
    );
    const perRecord = JSON.stringify(seed).length / seed.j.length;
    // 429 B/record measured on the 30 real jobs of that page. The ceiling is
    // the ratchet: at 156.032 pages every extra 100 B/record is ~470 MB.
    expect(perRecord).toBeLessThan(600);
  });
});

describe('cluster search seed — stale-seed guard', () => {
  const seed = buildClusterSearchSeed('/cerca-lavoro-svizzera/ricerca-x/', 'x y', [realisticJob(1)]);

  function withGlobal<T>(value: unknown, fn: () => T): T {
    const g = globalThis as unknown as Record<string, unknown>;
    const hadWindow = 'window' in g;
    const prevWindow = g.window;
    g.window = { [CLUSTER_SEARCH_SEED_GLOBAL]: value };
    try {
      return fn();
    } finally {
      if (hadWindow) g.window = prevWindow;
      else delete g.window;
    }
  }

  it('reads a seed that belongs to the current pathname', () => {
    const got = withGlobal(seed, () => readClusterSearchSeed('/cerca-lavoro-svizzera/ricerca-x/'));
    expect(got?.j).toHaveLength(1);
    expect(got?.q).toBe('x y');
  });

  it('refuses a seed emitted for a different page (SPA navigation)', () => {
    // The inline script is never cleared on a soft navigation, so presence
    // alone must never be enough — otherwise one cluster page's results follow
    // the visitor onto the next route.
    expect(withGlobal(seed, () => readClusterSearchSeed('/cerca-lavoro-svizzera/ricerca-altro/'))).toBeNull();
  });

  it('refuses malformed or empty payloads rather than rendering junk', () => {
    expect(withGlobal(undefined, () => readClusterSearchSeed('/x/'))).toBeNull();
    expect(withGlobal({ p: '/x/', q: 'a', j: [] }, () => readClusterSearchSeed('/x/'))).toBeNull();
    expect(withGlobal({ p: '/x/', q: '', j: [{ id: 'a', slug: 'b' }] }, () => readClusterSearchSeed('/x/'))).toBeNull();
    // Entries without id/slug cannot produce a href or a dedup key.
    expect(withGlobal({ p: '/x/', q: 'a', j: [{ title: 'no id' }] }, () => readClusterSearchSeed('/x/'))).toBeNull();
  });
});

describe('cluster search seed — wiring', () => {
  const PLUGIN = read('build-plugins/relatedSearchClustersPlugin.ts');
  const BOARD = read('components/community/JobBoard.tsx');

  it('emits the seed into the head, not into the body React replaces', () => {
    // bodyHtml is the <main class="cluster-seo-prose"> that index.tsx moves
    // into #root and React then replaces; the seed has to be readable before
    // that happens.
    expect(PLUGIN).toContain('extraHeadHtml: seedScript');
    expect(PLUGIN).toContain(`window.\${CLUSTER_SEARCH_SEED_GLOBAL}=`);
    // Inlined through the shared escaper, like every other build-seeded global.
    expect(PLUGIN).toContain('inlineScriptJson(');
  });

  it('derives the seeded query with the same function that prefills the search box', () => {
    // If these two ever diverge the seed silently stops applying — the tier
    // compares `deferredSearchQuery` to `clusterSeed.q`.
    expect(PLUGIN).toContain('parseSearchSlugFilter(candidate.slug)');
    expect(BOARD).toContain('deferredSearchQuery.trim() === clusterSeed.q.trim()');
  });

  it('seeds from the same job list the page prints', () => {
    // A different source here would publish a set the visible list contradicts.
    expect(PLUGIN).toContain('buildClusterSearchSeed(urlPath, seedQuery, ctx.matchingJobs');
    expect(PLUGIN).toContain('const jobLinksHtml = ctx.matchingJobs');
  });

  it('gates the JobBoard tier on the query and the company/location views', () => {
    const decl = /const clusterSeedApplies = [\s\S]{0,400}?;/.exec(BOARD);
    expect(decl, 'clusterSeedApplies must be declared').not.toBeNull();
    const text = decl![0];
    expect(text).toContain('!companySlugFilter');
    expect(text).toContain('!locationSlugFilter');
  });

  it('does not hold the loading skeleton once the seed applies', () => {
    // This is the line that turns the seed into a first-paint result set
    // instead of just a correctness fix: `resultsResolving` otherwise holds
    // the skeleton on `fullLoadPending` until the canton shards land (~2,8 s
    // measured), which would spend the entire win on an animation.
    expect(BOARD).toContain('&& !clusterSeedApplies');
  });

  it('still applies facet filters to the seeded set', () => {
    // Ticking "ultime 24h" must narrow the seeded results, not discard them
    // and fall through to the client-recomputed (smaller) set.
    expect(BOARD).toContain('clusterSeedJobs.filter((job) => passingNonSearchFilters(job, now, cutoff))');
  });
});

describe('cluster search seed — rendered page', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function makeDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cluster-seed-'));
    tmpDirs.push(dir);
    const assetsDir = join(dir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, SPA_ENTRY_JS_FILENAME), 'console.log(1)', 'utf8');
    writeFileSync(join(assetsDir, SPA_ENTRY_CSS_FILENAME), 'body{}', 'utf8');
    return dir;
  }

  function render() {
    return renderClusterPage({
      distDir: makeDist(),
      dateStamp: '2026-08-19',
      ctx: {
        candidate: {
          slug: 'ricerca-offerte-lavoro-assistente-psicologo',
          locale: 'it',
          jobCount: 3,
          sampleTerms: ['offerte lavoro assistente psicologo'],
          editorialCollision: null,
        },
        keyword: 'assistente psicologo',
        city: null,
        matchingJobs: [
          { id: 'a1', title: 'Assistente psicologo in Neuropsicologia', company: 'Stadtspital', location: 'Zürich', canton: 'ZH', slug: 'assistente-psicologo-neuropsicologia', url: 'https://ats.example/apply/a1', description: 'x'.repeat(3000) },
          { id: 'a2', title: 'Psicologo-psicoterapeuta in Psicologia', company: 'CNP', location: 'Neuchâtel', canton: 'NE', slug: 'psicologo-psicoterapeuta', url: 'https://ats.example/apply/a2', description: 'y'.repeat(3000) },
          { id: 'a3', title: 'Pedopsichiatra - Ambulatorio della Crisi', company: 'CNP', location: 'Neuchâtel', canton: 'NE', slug: 'pedopsichiatra-ambulatorio', url: 'https://ats.example/apply/a3', description: 'z'.repeat(3000) },
        ],
        topCompanies: ['CNP'],
        cantonGroup: '_AGGREGATE_',
        legacyCantonGroup: 'ZH',
      } as never,
      enriched: undefined,
      hreflang: [],
      related: [],
    });
  }

  it('inlines the seed with the page path, the slug-derived query and every printed job', () => {
    const { html, urlPath } = render();
    const m = /window\.__SEARCH_SEED__=(\{.*?\});<\/script>/s.exec(html);
    expect(m, 'seed script must be present').not.toBeNull();
    const seed = JSON.parse(m![1]) as { p: string; q: string; j: Array<Record<string, unknown>> };
    expect(seed.p).toBe(urlPath);
    // parseSearchSlugFilter strips the `ricerca-` prefix AND the
    // "offerte lavoro" boilerplate — which is exactly what the live page
    // prefills into its search box, so `deferredSearchQuery === seed.q`
    // holds on the first frame and the tier applies.
    expect(seed.q).toBe('assistente psicologo');
    // The seed carries the SAME jobs the page prints — including the two the
    // client matcher would drop (their titles lack "assistente").
    expect(seed.j.map((j) => j.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('does not ship the external apply url or the description it matched on', () => {
    const { html } = render();
    const m = /window\.__SEARCH_SEED__=(\{.*?\});<\/script>/s.exec(html)!;
    // The descriptions are 3 KB each here: leaking them would be ~9 KB per page
    // across 156.032 pages. This is the assertion that keeps the family from
    // silently gaining a gigabyte.
    expect(m[1]).not.toContain('ats.example');
    expect(m[1]).not.toContain('xxx');
    expect(m[1].length).toBeLessThan(1200);
  });

  it('puts the seed in the head, before the main React replaces', () => {
    const { html } = render();
    const seedAt = html.indexOf('__SEARCH_SEED__');
    const mainAt = html.indexOf('cluster-seo-prose');
    expect(seedAt).toBeGreaterThan(-1);
    expect(mainAt).toBeGreaterThan(-1);
    expect(seedAt).toBeLessThan(mainAt);
  });
});
