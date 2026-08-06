import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression cover for the `audit:hreflang` failure on post-deploy run
 * 31096435063:
 *
 *   comparatori/lamal-vs-cmi/index.html: has only 3 hreflang entries
 *   (need 4 locales + x-default)
 *
 * What actually happens
 * ---------------------
 * `/comparatori/lamal-vs-cmi/` is a legacy bridge emitted by
 * legacyRedirectsPlugin toward the article
 * `/articoli-frontaliere/lamal-vs-cmi-frontaliere/`. It is born with the full
 * 5-entry block copied from `public/sitemap-blog.xml` (verified: 5 entries at
 * the build sha a7b0c923). The post-walk hreflang pass then strips the `it`
 * and `x-default` entries — the two pointing at that article — because the
 * article has no file in `dist/`.
 *
 * It has none because `ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP=true` (repo
 * variable, set 2026-07-29): article pages are rendered and served by the
 * articles repo's shards. They answer 200 at the apex. The alternates were
 * never broken — the existence check's premise was.
 *
 * en/de/fr survive because the Pages artifact is the `BUILD_LOCALE=it` shard
 * build (deploy.yml uploads `github-pages` under `if: matrix.locale == 'it'`),
 * where non-owned locales skip the existence check entirely. That is why the
 * page lands on exactly 3 and not 0 — and 3 is what `audit:hreflang` reports.
 *
 * `scripts/audit-hreflang.mjs` already exempts these URLs in `targetExists()`.
 * These tests pin the emit side to the same rule, and pin the two call sites
 * that actually run in a build to using it.
 */

const BASE = 'https://frontaliereticino.ch';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/**
 * `transformHreflang` reads EMIT_ALL_LOCALES from BUILD_LOCALE once at module
 * load, so each scenario sets the env var and re-imports.
 */
async function loadEngine(buildLocale: string | undefined) {
  vi.resetModules();
  const prev = process.env.BUILD_LOCALE;
  if (buildLocale === undefined) delete process.env.BUILD_LOCALE;
  else process.env.BUILD_LOCALE = buildLocale;
  try {
    return await import('../packages/articles/engine/hreflangPostprocess.ts');
  } finally {
    if (prev === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = prev;
  }
}

/** The <head> of the bridge, byte-shaped like the live page. */
function bridgeHtml(): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="it">',
    ' <head>',
    `  <link rel="canonical" href="${BASE}/articoli-frontaliere/lamal-vs-cmi-frontaliere/">`,
    `  <link rel="alternate" hreflang="it" href="${BASE}/articoli-frontaliere/lamal-vs-cmi-frontaliere/">`,
    `  <link rel="alternate" hreflang="en" href="${BASE}/en/cross-border-articles/lamal-vs-nhs-cross-border/">`,
    `  <link rel="alternate" hreflang="de" href="${BASE}/de/grenzgaenger-artikel/kvg-vs-nhs-grenzgaenger/">`,
    `  <link rel="alternate" hreflang="fr" href="${BASE}/fr/articles-frontalier/lamal-vs-cmu-frontalier/">`,
    `  <link rel="alternate" hreflang="x-default" href="${BASE}/articoli-frontaliere/lamal-vs-cmi-frontaliere/">`,
    ' </head>',
    ' <body></body>',
    '</html>',
  ].join('\n');
}

function countAlternates(html: string): string[] {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)"/g)].map((m) => m[1]);
}

let dist: string;
const PAGE_REL = 'comparatori/lamal-vs-cmi/index.html';

beforeEach(() => {
  // A dist that holds the bridge itself and nothing else — exactly the shape
  // an `it` shard build has once the article sections stop being emitted.
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'hreflang-ext-'));
  fs.mkdirSync(path.join(dist, 'comparatori', 'lamal-vs-cmi'), { recursive: true });
  fs.writeFileSync(path.join(dist, PAGE_REL), bridgeHtml());
});
afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
  vi.resetModules();
});

describe('hreflang post-walk — externally-served article targets', () => {
  it('REPRODUCES the defect: a raw dist-only existence check strips it + x-default', async () => {
    // This is the pre-fix behaviour, kept as the negative case. If it ever
    // stops holding, the exemption below is no longer covering anything real.
    const engine = await loadEngine('it');
    const emitted = new Set<string>([path.join(dist, PAGE_REL)]);
    const r = engine.transformHreflang(
      bridgeHtml(),
      dist,
      BASE,
      (absPath: string) => emitted.has(absPath),
      PAGE_REL,
    );
    expect(r).not.toBeNull();
    expect(countAlternates(r!.html)).toEqual(['en', 'de', 'fr']);
    // …which is verbatim what audit:hreflang reported on run 31096435063.
    expect(countAlternates(r!.html).length).toBeLessThan(5);
  });

  it('keeps all 5 alternates when the check exempts externally-served sections', async () => {
    const { allowExternallyServedTargets } = await import('../scripts/lib/externally-served-paths.mjs');
    const engine = await loadEngine('it');
    const emitted = new Set<string>([path.join(dist, PAGE_REL)]);
    const r = engine.transformHreflang(
      bridgeHtml(),
      dist,
      BASE,
      allowExternallyServedTargets((absPath: string) => emitted.has(absPath), dist),
      PAGE_REL,
    );
    // null = nothing to drop, which is the desired outcome. If the transform
    // still rewrites, assert the surviving set is complete.
    const survived = r === null ? countAlternates(bridgeHtml()) : countAlternates(r.html);
    expect(survived).toEqual(['it', 'en', 'de', 'fr', 'x-default']);
  });

  it('still drops a genuinely broken alternate that is NOT externally served', async () => {
    // The exemption must not become a blanket "keep everything". A missing
    // IT-owned page outside the article sections is a real broken link.
    const { allowExternallyServedTargets } = await import('../scripts/lib/externally-served-paths.mjs');
    const engine = await loadEngine('it');
    const emitted = new Set<string>([path.join(dist, PAGE_REL)]);
    const html = [
      '<head>',
      `<link rel="alternate" hreflang="it" href="${BASE}/pagina-che-non-esiste/">`,
      `<link rel="alternate" hreflang="en" href="${BASE}/en/cross-border-articles/x/">`,
      '</head>',
    ].join('\n');
    const r = engine.transformHreflang(
      html,
      dist,
      BASE,
      allowExternallyServedTargets((absPath: string) => emitted.has(absPath), dist),
      PAGE_REL,
    );
    expect(r).not.toBeNull();
    // it → dropped (real 404); en → kept (article section, served elsewhere).
    expect(countAlternates(r!.html)).toEqual(['en']);
  });

  it('exempts every article-section prefix the Worker routes away, in all 4 locales', async () => {
    const mod = await import('../scripts/lib/externally-served-paths.mjs');
    const check = mod.allowExternallyServedTargets(() => false, dist);
    for (const prefix of mod.EXTERNALLY_SERVED_PREFIXES) {
      expect(check(path.join(dist, prefix.slice(1), 'slug', 'index.html'))).toBe(true);
      expect(check(path.join(dist, `${prefix.slice(1)}/slug.html`))).toBe(true);
    }
    // A path outside those prefixes is still governed by the wrapped check.
    expect(check(path.join(dist, 'compara-servizi', 'x', 'index.html'))).toBe(false);
    // …and a near-miss prefix must not match at a non-segment boundary.
    expect(check(path.join(dist, 'articoli-frontaliere-altro', 'x', 'index.html'))).toBe(false);
  });
});

describe('hreflang post-walk — the exemption is wired into both build call sites', () => {
  // transformHreflang is invoked from exactly two places in a real build: the
  // coordinator's single-threaded path and the worker thread. A functional
  // test on the helper proves the rule; these prove the rule is actually
  // reached. Without them the helper could be correct and unused — which is
  // the state this PR found the repo in.
  const CALL_SITES = [
    'build-plugins/postWalkCoordinatorPlugin.ts',
    'build-plugins/postWalkWorker.mjs',
  ] as const;

  for (const rel of CALL_SITES) {
    it(`${rel} builds its hreflang existence check through allowExternallyServedTargets`, () => {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf-8');
      expect(src).toContain('allowExternallyServedTargets');
      // The bare `existingHtmlSet.has` predicate must not reach
      // transformHreflang unwrapped.
      const wrapped = /allowExternallyServedTargets\(\s*\(absPath[^)]*\)\s*=>\s*existingHtmlSet\.has\(absPath\)/;
      expect(src).toMatch(wrapped);
    });
  }
});
