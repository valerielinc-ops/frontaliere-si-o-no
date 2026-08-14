/**
 * Regression test for the runaway-`generate-article.yml` cleanup (2026-08-06).
 *
 * A self-dispatching workflow wrote five articles straight into the site repo.
 * One (`rimborsi-730-sostituti-imposta`) was carried into the corpus and stays.
 * The other four are withdrawn — but the corpus mirror had already DELETED them
 * from both repos while the deployed shard kept serving them, so all 16 URLs
 * (4 articles x 4 locales) were live 200s with nothing left to rebuild them.
 *
 * This test pins all 16 redirects, i.e. the TARGET chosen for each. It is
 * deliberately hermetic (reads the plugin source, no Vite build, no network) —
 * the same idiom as `tests/router-locale-slugs.test.ts`'s Cluster B block.
 *
 * IT DOES NOT PROVE THE 16 URLS ARE DEINDEXED, and it never did.
 * ─────────────────────────────────────────────────────────────
 * Its first version said "without an entry in `legacyRedirectsPlugin`'s table
 * the next shard deploy turns each one into a bare 404". There is no next shard
 * deploy from this build for these sections: they run with
 * `<SECTION>_BUILD_EMIT_SKIP=true` and deploy.yml excludes them from the
 * full-replace push, so the shard is append-only and the bridge this table
 * declares never reaches the serving path. All 20 assertions below stayed green
 * for the six days the 16 URLs answered 200 `index, follow` with a SELF
 * canonical (issue #5369 §4, measured 2026-08-14).
 *
 * The serving-path half is `tests/edge-retired-paths.test.ts`, which exercises
 * the Worker's `retiredEdgeResponse` for these same 16 URLs. Keep both: this
 * file is the authority on WHERE a retired URL should point, that one on
 * whether anything on the wire acts on it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_PATH = path.resolve(
  __dirname,
  '../build-plugins/legacyRedirectsPlugin.ts',
);

/**
 * Extract the `const redirects: Record<string, string> = { … };` object literal
 * from the plugin source and parse its `'<from>': '<to>'` entries into a Map.
 * Scoped to that one literal so unrelated objects in the file (SECTION_FALLBACKS
 * and friends) can never satisfy an assertion by accident.
 */
function parseRedirectTable(): Map<string, string> {
  const source = fs.readFileSync(PLUGIN_PATH, 'utf-8');

  const startMarker = 'const redirects: Record<string, string> = {';
  const start = source.indexOf(startMarker);
  expect(start, 'redirect table literal not found in legacyRedirectsPlugin.ts').toBeGreaterThan(-1);

  // Walk braces from the literal's opening `{` to its matching `}`.
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, 'unbalanced braces in redirect table literal').toBeGreaterThan(open);

  const body = source.slice(open + 1, end);
  const map = new Map<string, string>();
  const entryRx = /^[ \t]*'([^']+)'\s*:\s*'([^']+)'\s*,?[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRx.exec(body)) !== null) {
    const [, from, to] = m;
    expect(map.has(from), `duplicate redirect key ${from}`).toBe(false);
    map.set(from, to);
  }
  return map;
}

/** The four retired articles, with the target chosen for each and why. */
const RETIRED: Array<{
  article: string;
  reason: string;
  urls: Array<[from: string, to: string]>;
}> = [
  {
    article: 'prezzi-proprieta-svizzera-aumentano',
    reason: 'fabricated Swiss laws — no equivalent exists, so: section root',
    urls: [
      ['/articoli-frontaliere/prezzi-proprieta-svizzera-aumentano/', '/articoli-frontaliere/'],
      ['/en/cross-border-articles/swiss-property-prices-rise/', '/en/cross-border-articles/'],
      ['/de/grenzgaenger-artikel/schweizer-immobilienpreise-steigen/', '/de/grenzgaenger-artikel/'],
      ['/fr/articles-frontalier/prix-immobilier-suisse-augmentent/', '/fr/articles-frontalier/'],
    ],
  },
  {
    article: 'caldo-torrido-lavoro-ticino',
    reason: 'duplicate of the corpus caldo-lavoro-frontalieri-ticino (same source)',
    urls: [
      [
        '/articoli-frontaliere/caldo-torrido-lavoro-ticino/',
        '/articoli-frontaliere/caldo-lavoro-frontalieri-ticino/',
      ],
      [
        '/en/cross-border-articles/hot-weather-work-ticino/',
        '/en/cross-border-articles/heat-work-cross-border-ticino/',
      ],
      [
        '/de/grenzgaenger-artikel/heisses-wetter-arbeit-tessin/',
        '/de/grenzgaenger-artikel/hitze-arbeitsgrenze-tessin/',
      ],
      [
        '/fr/articles-frontalier/chaleur-torrida-travail-tessin/',
        '/fr/articles-frontalier/chaleur-travail-frontalier-tessin/',
      ],
    ],
  },
  {
    article: 'lavoro-forzato-catene-svizzere',
    // The EN pair differs by ONE letter (labour → labor); a typo here would
    // silently produce a redirect to a 404, hence the explicit pinning.
    reason: 'duplicate of the corpus lavoro-forzato-svizzera (same source)',
    urls: [
      ['/articoli-svizzera/lavoro-forzato-catene-svizzere/', '/articoli-svizzera/lavoro-forzato-svizzera/'],
      [
        '/en/swiss-articles/forced-labour-swiss-supply-chains/',
        '/en/swiss-articles/forced-labor-swiss-supply-chains/',
      ],
      [
        '/de/schweiz-artikel/zwangsarbeit-schweizer-lieferketten/',
        '/de/schweiz-artikel/zwangsarbeit-in-schweizer-lieferketten/',
      ],
      [
        '/fr/articles-suisse/travail-force-chaines-approvisionnement-suisse/',
        '/fr/articles-suisse/travail-force-dans-les-chaines-dapprovisionnement-suisses/',
      ],
    ],
  },
  {
    article: 'vivere-maslianico-lavorare-ticino-frontaliere',
    reason: 'IRPEF/imposta-alla-fonte error — intent still served by the municipality page',
    urls: [
      [
        '/articoli-frontaliere/vivere-maslianico-lavorare-ticino-frontaliere/',
        '/vivere-in-ticino/comuni-di-frontiera/maslianico/',
      ],
      [
        '/en/cross-border-articles/live-maslianico-work-ticino-cross-border/',
        '/en/living-in-ticino/border-municipalities/maslianico/',
      ],
      [
        '/de/grenzgaenger-artikel/in-maslianico-wohnen-arbeiten-tessin-grenzganger/',
        '/de/leben-im-tessin/grenzgemeinden/maslianico/',
      ],
      [
        '/fr/articles-frontalier/vivre-maslianico-travailler-tessin-frontalier/',
        '/fr/vivre-au-tessin/communes-frontiere/maslianico/',
      ],
    ],
  },
];

const ALL_RETIRED_URLS = RETIRED.flatMap((r) => r.urls);

describe('runaway-workflow articles — retirement redirects', () => {
  const table = parseRedirectTable();

  it('covers all 16 URLs (4 articles x 4 locales)', () => {
    expect(ALL_RETIRED_URLS).toHaveLength(16);
  });

  for (const { article, reason, urls } of RETIRED) {
    describe(`${article} — ${reason}`, () => {
      for (const [from, to] of urls) {
        it(`redirects ${from}`, () => {
          expect(table.get(from)).toBe(to);
        });
      }
    });
  }

  it('never redirects a retired URL to another retired URL', () => {
    const retiredSet = new Set(ALL_RETIRED_URLS.map(([from]) => from));
    for (const [from, to] of ALL_RETIRED_URLS) {
      expect(retiredSet.has(to), `${from} chains into retired ${to}`).toBe(false);
    }
  });

  it('never redirects a retired URL to a path that is itself redirected away', () => {
    // A → B where B is also a redirect key would emit a bridge that lands on a
    // second bridge: crawlers discount chained hops and users see two refreshes.
    for (const [from, to] of ALL_RETIRED_URLS) {
      expect(table.has(to), `${from} → ${to}, but ${to} is itself a redirect key`).toBe(false);
    }
  });

  it('keeps every retired URL out of the live article registries', () => {
    // The mirror already deleted these four from packages/articles/content. If one
    // ever comes back, the bridge would shadow a real page (or vice versa) — fail loud.
    const registries = [
      '../packages/articles/content/routerBlogData.ts',
      '../packages/articles/content/routerSwissData.ts',
    ].map((rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8'));

    for (const { article } of RETIRED) {
      for (const source of registries) {
        expect(source.includes(`'${article}'`), `${article} is back in an article registry`).toBe(false);
      }
    }
  });
});
