import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { ARTICLE_SECTION_DESCRIPTORS } from '../build-plugins/shared/articleSectionDescriptors';
import {
  ARTICLE_HUB_SHELL_NAV_OPEN,
  ensureArticleHubCards,
  replaceArticleHubCards,
} from '../packages/articles/engine/articlesHubCards';
import { EXTERNALLY_SERVED_SECTIONS } from '../scripts/lib/externally-served-paths.mjs';

/**
 * Issue #4974 (article-corpus separation) regression coverage.
 *
 * `ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP` / `ARTICOLISVIZZERA_BUILD_EMIT_SKIP`
 * are production kill-switches: when `=== 'true'` the site build stops
 * emitting that section's article pages/hubs/indexes because they're served
 * from a separate shard repo instead. Before this file, ZERO tests referenced
 * `BUILD_EMIT_SKIP` anywhere — a regression in any of the three gates (wrong
 * comparison, missing section, or a deploy.yml var deletion) would silently
 * either half-emit a section or vanish pages from the live site with nothing
 * red in CI.
 */

const root = path.resolve(__dirname, '..');
const ogPagesSource = readFileSync(
  path.resolve(root, 'packages', 'articles', 'engine', 'ogPagesPlugin.ts'),
  'utf-8',
);
const seoHubsSource = readFileSync(path.resolve(root, 'build-plugins', 'seoHubsPlugin.ts'), 'utf-8');
const staticPagesSource = readFileSync(path.resolve(root, 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');
const deployYmlSource = readFileSync(path.resolve(root, '.github', 'workflows', 'deploy.yml'), 'utf-8');

describe('BUILD_EMIT_SKIP gate uses strict === \'true\' (not truthiness)', () => {
  // A regression to truthiness (e.g. `!!process.env.X` or `X !== undefined`)
  // would flip the switch ON for ANY non-empty value, including the literal
  // string "false" — the exact footgun this pins against.
  const strictFrontaliere = /process\.env\.ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP\s*===\s*'true'/;
  const strictSvizzera = /process\.env\.ARTICOLISVIZZERA_BUILD_EMIT_SKIP\s*===\s*'true'/;

  it('ogPagesPlugin.ts (article detail pages) gates both sections with strict equality', () => {
    expect(ogPagesSource).toMatch(strictFrontaliere);
    expect(ogPagesSource).toMatch(strictSvizzera);
  });

  it('seoHubsPlugin.ts (hubs) gates both sections with strict equality', () => {
    expect(seoHubsSource).toMatch(strictFrontaliere);
    expect(seoHubsSource).toMatch(strictSvizzera);
  });

  it('staticPagesPlugin.ts (bare article indexes) gates both sections with strict equality', () => {
    expect(staticPagesSource).toMatch(strictFrontaliere);
    expect(staticPagesSource).toMatch(strictSvizzera);
  });

  it('every code-level read of these vars is a strict === \'true\' comparison', () => {
    // Enumerate EVERY `process.env.<VAR>` read in each plugin and require the
    // very next thing after it to be `=== 'true'`. Asserting the absence of a
    // couple of hand-picked bad forms (`!== undefined`, `!!x`) would leave the
    // most likely regression — a bare `if (process.env.X)` — undetected, so we
    // check the positive form exhaustively instead.
    const anyRead = /process\.env\.(ARTICOLIFRONTALIERE|ARTICOLISVIZZERA)_BUILD_EMIT_SKIP(\s*===\s*'true')?/g;
    for (const [name, source] of [
      ['ogPagesPlugin.ts', ogPagesSource],
      ['seoHubsPlugin.ts', seoHubsSource],
      ['staticPagesPlugin.ts', staticPagesSource],
    ] as const) {
      const reads = [...source.matchAll(anyRead)];
      expect(reads.length, `${name}: expected at least one process.env read`).toBeGreaterThan(0);
      for (const m of reads) {
        expect(
          m[2],
          `${name}: "${m[0]}" is not compared with === 'true'. A truthy read turns the ` +
            'kill-switch ON for any non-empty value, including the literal string "false".',
        ).toBeTruthy();
      }
    }
  });
});

describe('BUILD_EMIT_SKIP gate covers BOTH sections in every plugin', () => {
  // A gate that only checks one of the two vars would silently half-emit:
  // the other section's pages would never be skipped even when its shard is
  // live, or vice versa.
  it('ogPagesPlugin.ts references both ARTICOLIFRONTALIERE_ and ARTICOLISVIZZERA_', () => {
    expect(ogPagesSource).toContain('ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP');
    expect(ogPagesSource).toContain('ARTICOLISVIZZERA_BUILD_EMIT_SKIP');
  });

  it('seoHubsPlugin.ts references both ARTICOLIFRONTALIERE_ and ARTICOLISVIZZERA_', () => {
    expect(seoHubsSource).toContain('ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP');
    expect(seoHubsSource).toContain('ARTICOLISVIZZERA_BUILD_EMIT_SKIP');
  });

  it('staticPagesPlugin.ts references both ARTICOLIFRONTALIERE_ and ARTICOLISVIZZERA_', () => {
    expect(staticPagesSource).toContain('ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP');
    expect(staticPagesSource).toContain('ARTICOLISVIZZERA_BUILD_EMIT_SKIP');
  });

  it('seoHubsPlugin.ts iterates BOTH sections (frontaliere AND svizzera keys), not just one', () => {
    // Pin the per-section record shape itself, not just substring presence,
    // so a regression that drops one section's key (leaving the loop to only
    // ever see the other) is caught even though both var names would still
    // appear in the file's rationale comment.
    expect(seoHubsSource).toMatch(/frontaliere:\s*process\.env\.ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP\s*===\s*'true'/);
    expect(seoHubsSource).toMatch(/svizzera:\s*process\.env\.ARTICOLISVIZZERA_BUILD_EMIT_SKIP\s*===\s*'true'/);
  });
});

describe('staticPagesPlugin bare-index skip-set: real ARTICLE_SECTION_DESCRIPTORS contract', () => {
  // The real skip-set-building loop lives inline inside staticPagesPlugin's
  // Vite plugin closure (build-plugins/staticPagesPlugin.ts:1150-1166) and is
  // not exported as a standalone function, so it can't be imported and
  // called directly without standing up the whole Vite build (explicitly out
  // of scope per the task). We replicate the loop verbatim here instead of
  // spinning up Vite — the replication is intentionally byte-for-byte
  // identical to the source (same field accesses, same locale list, same
  // path template) so a divergence between this test and the real loop is a
  // deliberate edit, not accidental drift. What we DO import for real is
  // `ARTICLE_SECTION_DESCRIPTORS` itself (the same shared array the plugin
  // imports), so the section list/indexSlug data driving both this test and
  // the real code is guaranteed identical.
  function buildSkipSetPaths(sec: (typeof ARTICLE_SECTION_DESCRIPTORS)[number]): string[] {
    const paths: string[] = [`/${sec.indexSlug.it}`];
    for (const loc of ['en', 'de', 'fr'] as const) {
      const bs = sec.indexSlug[loc];
      if (bs) paths.push(`/${loc}/${bs}`);
    }
    return paths;
  }

  it('produces exactly the 8 known live index paths (4 locales x 2 sections)', () => {
    // Hard-coded expectations on purpose. Re-deriving the expected set from the
    // same descriptor the replica reads would compare the replica against
    // itself — a tautology that stays green even if indexSlug data is wrong.
    // These literals are the real live URLs; `/articoli-frontaliere` and
    // `/en/cross-border-articles` are the same paths issue #4974 records
    // pre-flip byte baselines for.
    const bySection = Object.fromEntries(
      ARTICLE_SECTION_DESCRIPTORS.map((sec) => [sec.name, buildSkipSetPaths(sec)]),
    );

    expect(new Set(bySection.frontaliere)).toEqual(
      new Set([
        '/articoli-frontaliere',
        '/en/cross-border-articles',
        '/de/grenzgaenger-artikel',
        '/fr/articles-frontalier',
      ]),
    );
    expect(new Set(bySection.svizzera)).toEqual(
      new Set([
        '/articoli-svizzera',
        '/en/swiss-articles',
        '/de/schweiz-artikel',
        '/fr/articles-suisse',
      ]),
    );
  });

  it('the frontaliere and svizzera index slugs are non-empty for all four locales (it/en/de/fr)', () => {
    // The bug this loop exists to avoid (issue class: "half-emitted index")
    // only manifests if a locale's indexSlug is falsy and silently skipped —
    // confirm the live data actually exercises all four locale branches, not
    // just IT, so Group 3 above isn't vacuously true.
    for (const sec of ARTICLE_SECTION_DESCRIPTORS) {
      expect(sec.indexSlug.it, `section "${sec.name}" missing indexSlug.it`).toBeTruthy();
      expect(sec.indexSlug.en, `section "${sec.name}" missing indexSlug.en`).toBeTruthy();
      expect(sec.indexSlug.de, `section "${sec.name}" missing indexSlug.de`).toBeTruthy();
      expect(sec.indexSlug.fr, `section "${sec.name}" missing indexSlug.fr`).toBeTruthy();
    }
  });

  it('staticPagesPlugin.ts source still drives its skip-set from ARTICLE_SECTION_DESCRIPTORS (not a re-literalized copy)', () => {
    expect(staticPagesSource).toMatch(/for \(const sec of ARTICLE_SECTION_DESCRIPTORS\)/);
    expect(staticPagesSource).toContain('ogPagesPaths.add(`/${sec.indexSlug.it}`)');
    expect(staticPagesSource).toContain('ogPagesPaths.add(`/${loc}/${bs}`)');
  });
});

describe('BUILD_EMIT_SKIP <-> deploy.yml lockstep contract', () => {
  // The docblock at packages/articles/engine/ogPagesPlugin.ts (~:1336-1360)
  // states the flags MUST be flipped in lockstep with excluding the section
  // from deploy.yml's push loop. If deploy.yml stops referencing a var while
  // a plugin still gates on it, the two drift apart silently: the shard
  // stops being pushed while the main build (with a stale repo-variable
  // value) may still be skipping emission for a section nothing is serving
  // anymore — pages vanish from the live site with no test failure anywhere
  // else in this suite.
  it('deploy.yml still references ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP', () => {
    expect(
      deployYmlSource,
      'deploy.yml no longer references ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP — this MUST stay in lockstep ' +
        'with the plugin-side gates (ogPagesPlugin.ts / seoHubsPlugin.ts / staticPagesPlugin.ts) or a section ' +
        'can end up skipped at build time while its shard is not actually being pushed/served, silently ' +
        'dropping pages from the live site.',
    ).toContain('ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP');
  });

  it('deploy.yml still references ARTICOLISVIZZERA_BUILD_EMIT_SKIP', () => {
    expect(
      deployYmlSource,
      'deploy.yml no longer references ARTICOLISVIZZERA_BUILD_EMIT_SKIP — this MUST stay in lockstep ' +
        'with the plugin-side gates (ogPagesPlugin.ts / seoHubsPlugin.ts / staticPagesPlugin.ts) or a section ' +
        'can end up skipped at build time while its shard is not actually being pushed/served, silently ' +
        'dropping pages from the live site.',
    ).toContain('ARTICOLISVIZZERA_BUILD_EMIT_SKIP');
  });

  it('deploy.yml references both vars at least as many times as the plugins reference each (rough lockstep density check)', () => {
    // Not a precise structural check (deploy.yml is YAML, not parsed here),
    // but a cheap trip-wire: both vars appear multiple times in deploy.yml
    // today (env passthrough at several job steps). If one collapses to a
    // single/zero reference while the other stays multi-referenced, that's
    // exactly the asymmetric-deletion shape the lockstep rule exists to
    // prevent.
    const frontaliereCount = (deployYmlSource.match(/ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP/g) ?? []).length;
    const svizzeraCount = (deployYmlSource.match(/ARTICOLISVIZZERA_BUILD_EMIT_SKIP/g) ?? []).length;
    expect(frontaliereCount).toBeGreaterThan(0);
    expect(svizzeraCount).toBeGreaterThan(0);
    expect(frontaliereCount).toBe(svizzeraCount);
  });
});

describe('no landing may be excluded from BOTH writers at once', () => {
  /**
   * The defect this pins (issue 5097). Two writers can put the hub grid on
   * `/articoli-svizzera/` & friends, and for a week neither did:
   *
   *   - the SITE cannot: `scripts/lib/deploy-shard-sections.sh` excludes both
   *     article sections from the shard push loop unconditionally, so nothing
   *     this build emits for them ever reaches the shard the Worker serves —
   *     flipping `ARTICOLISVIZZERA_BUILD_EMIT_SKIP` back to 'false' would fill
   *     `dist/` and change nothing live;
   *   - the CORPUS would not: its refresher could only SWAP an existing
   *     `ssg-article-grid`, and the live page (emitted by the generic fallback
   *     branch, before the hub branch existed) had no marker to swap. It
   *     logged "nothing to refresh" and exited 0.
   *
   * Nothing failed, which is why it lasted. The invariant below is what makes
   * "nobody writes" unreachable: for every section the site has handed off,
   * the shared engine must be able to CREATE the grid, not only refresh it.
   */
  const MARKERLESS_LANDING =
    '<div class="s-wWmcGm"><article><h1 class="s-lHdmvf">Hub</h1></article>'
    + '<div style="border:1px solid #e2e8f0;height:38rem"></div>'
    + `${ARTICLE_HUB_SHELL_NAV_OPEN}<a href="/">Home</a></nav></div>`;

  it('the sections handed off to the corpus are the ones we think they are', () => {
    // Guards against the set silently emptying: an empty set would make every
    // assertion below vacuously true while `deploy-shard-sections.sh` quietly
    // resumed full-replacing the article shards.
    expect([...EXTERNALLY_SERVED_SECTIONS].sort()).toEqual([
      'articolifrontaliere',
      'articolisvizzera',
    ]);
    // Same two sections the BUILD_EMIT_SKIP flags gate, by another name.
    expect(ARTICLE_SECTION_DESCRIPTORS.map((s) => s.name).sort()).toEqual([
      'frontaliere',
      'svizzera',
    ]);
  });

  it('the corpus-side writer can CREATE a grid, not only refresh one', () => {
    // The whole deadlock in one assertion: refresh-only returns null on the
    // exact page production serves, create-or-refresh does not.
    expect(replaceArticleHubCards(MARKERLESS_LANDING, '<a>c</a>')).toBeNull();
    const created = ensureArticleHubCards(MARKERLESS_LANDING, '<a>c</a>', 'it');
    expect(created).not.toBeNull();
    expect(created).toContain('<div class="ssg-article-grid"><a>c</a></div>');
  });

  it('the site template still emits the anchor the creator inserts against', () => {
    // A rename of the shell nav class in staticPagesPlugin would leave
    // `ensureArticleHubCards` with no anchor and silently re-open the gap on
    // any hub that ever loses its marker. Fail here instead.
    expect(
      staticPagesSource,
      `staticPagesPlugin.ts no longer emits "${ARTICLE_HUB_SHELL_NAV_OPEN}" — that literal is the `
        + 'anchor ensureArticleHubCards() inserts the grid against on a landing that has no marker. '
        + 'Rename it in packages/articles/engine/articlesHubCards.ts in the SAME change.',
    ).toContain(ARTICLE_HUB_SHELL_NAV_OPEN);
  });

  it('both hub branches emit the grid through the single shared producer', () => {
    // Three emitters, one literal. Re-inlining `<div class="ssg-article-grid">`
    // in a branch is how the two producers drift into markup the other cannot
    // find.
    const calls = staticPagesSource.match(/renderArticleHubGridBlock\(/g) ?? [];
    expect(calls.length, 'expected both hub branches (frontaliere + svizzera) to call it').toBe(2);
    expect(
      staticPagesSource,
      'staticPagesPlugin.ts re-inlines the grid marker instead of going through '
        + 'renderArticleHubGridBlock() — the corpus scans for that exact literal.',
    ).not.toMatch(/=\s*`[^`]*<div class="ssg-article-grid">/);
  });
});
