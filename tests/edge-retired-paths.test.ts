/**
 * A retired article must stop being indexable — and must STAY that way.
 *
 * THE DEFECT THIS GUARDS (issue #5369 §4)
 * ───────────────────────────────────────
 * The two article sections are served by an append-only shard this build cannot
 * force-replace, so the bridge `legacyRedirectsPlugin` writes for a retired URL
 * never reaches the serving path. Measured live on 2026-08-14, bare apex URLs,
 * no `-L`:
 *
 *   16/16 URLs of the four articles retired on 2026-08-06 answered **200** with
 *         `robots: index, follow, max-snippet:-1, …` and a canonical pointing at
 *         THEMSELVES. Google was being told to index four withdrawn articles in
 *         four locales, one of which the source declares unpublishable for citing
 *         five Swiss laws that do not exist.
 *   20/21 `data/legacy-aliases.json` orphans under the same prefixes answered
 *         **200** with a soft-landing page carrying NO robots meta and NO
 *         canonical — a soft-404, i.e. still a candidate for indexing.
 *
 * Every one of those URLs was correctly declared retired IN THE BUILD. That is
 * why this file does not check the build: a source-level assertion on the
 * redirect table would have been green throughout the six days the defect was
 * live. What was missing was a layer on the SERVING path, and the only one this
 * repo owns for those prefixes is the Cloudflare Worker.
 *
 * WHAT THIS FILE ASSERTS, AND WHY IT IS NOT VACUOUS
 * ────────────────────────────────────────────────
 * `EDGE_RETIRED_PATHS` is not read as a list to be trusted. It is RE-DERIVED
 * here from the three places the repo declares a URL dead —
 *
 *   1. `build-plugins/legacyRedirectsPlugin.ts`'s own object literal,
 *   2. `data/article-redirects.json` (merged into that same map at closeBundle),
 *   3. `data/legacy-aliases.json`'s orphanPaths,
 *
 * minus everything the corpus still publishes (`BLOG_SLUGS` / `SWISS_SLUGS`) —
 * and the two sets must match EXACTLY, in both directions. So:
 *
 *   • declaring the next retirement in the build without adding it here → RED;
 *   • listing a URL here that the corpus still publishes → RED.
 *
 * The response tests then run the real `retiredEdgeResponse` for every entry, so
 * a table that is complete but wired to nothing fails too.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import { EDGE_RETIRED_PATHS, retiredEdgeResponse } from '../infra/cloudflare-worker/locale-router.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain .mjs module, no type declarations.
import { EXTERNALLY_SERVED_PREFIXES } from '../scripts/lib/externally-served-paths.mjs';

const REPO = path.resolve(__dirname, '..');
const APEX = 'https://frontaliereticino.ch';

const PREFIXES: readonly string[] = EXTERNALLY_SERVED_PREFIXES;

const RETIRED_TABLE = EDGE_RETIRED_PATHS as Record<string, string | null>;

/** Segment-boundary prefix match — the same rule as isExternallyServedPath(). */
function underSectionPrefix(p: string): boolean {
  return PREFIXES.some(
    (prefix) => p === prefix || p === `${prefix}/` || p === `${prefix}.html` || p.startsWith(`${prefix}/`),
  );
}

/** True for a section ROOT (or its flat twin) — never a document. */
function isSectionRoot(p: string): boolean {
  return PREFIXES.some((prefix) => p === prefix || p === `${prefix}/` || p === `${prefix}.html`);
}

const lastSegment = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? '';

/**
 * Walk braces from `marker`'s opening `{` to its match and return the body.
 * Scoped to one literal so unrelated objects in the same file can never satisfy
 * an assertion by accident — the idiom of
 * tests/retired-runaway-articles-redirects.test.ts.
 */
function objectLiteralBody(source: string, marker: string, label: string): string {
  const start = source.indexOf(marker);
  expect(start, `${label}: literal not found`).toBeGreaterThan(-1);
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
  expect(end, `${label}: unbalanced braces`).toBeGreaterThan(open);
  return source.slice(open + 1, end);
}

/** `legacyRedirectsPlugin`'s hand-authored map, plus data/article-redirects.json. */
function declaredRedirects(): Map<string, string> {
  const source = fs.readFileSync(path.join(REPO, 'build-plugins/legacyRedirectsPlugin.ts'), 'utf-8');
  const body = objectLiteralBody(
    source,
    'const redirects: Record<string, string> = {',
    'legacyRedirectsPlugin redirect table',
  );
  const map = new Map<string, string>();
  const entryRx = /^[ \t]*'([^']+)'\s*:\s*'([^']+)'\s*,?[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRx.exec(body)) !== null) map.set(m[1], m[2]);
  expect(map.size, 'redirect table parsed empty').toBeGreaterThan(100);

  // legacyRedirectsPlugin merges this file into the SAME map at closeBundle
  // (issue #5352), so a rename declared there is just as inert on the shard as
  // one declared in the literal above — and must be edge-served for the same
  // reason. A `from` in the literal wins, matching the plugin's own precedence.
  const fromFile = JSON.parse(
    fs.readFileSync(path.join(REPO, 'data/article-redirects.json'), 'utf-8'),
  ) as Record<string, string>;
  for (const [from, to] of Object.entries(fromFile)) if (!map.has(from)) map.set(from, to);

  return map;
}

/** Every slug the corpus still publishes, all locales, both article sections. */
function liveCorpusSlugs(): Set<string> {
  const out = new Set<string>();
  const sources: Array<[file: string, marker: string]> = [
    ['packages/articles/content/routerBlogData.ts', 'export const BLOG_SLUGS'],
    ['packages/articles/content/routerSwissData.ts', 'export const SWISS_SLUGS'],
  ];
  for (const [rel, marker] of sources) {
    const body = objectLiteralBody(fs.readFileSync(path.join(REPO, rel), 'utf-8'), marker, rel);
    const rowRx = /^\s*'[^']+':\s*\{([^}]*)\}\s*,?\s*$/gm;
    let row: RegExpExecArray | null;
    while ((row = rowRx.exec(body)) !== null) {
      const slugRx = /\b(?:it|en|de|fr)\s*:\s*'([^']+)'/g;
      let s: RegExpExecArray | null;
      while ((s = slugRx.exec(row[1])) !== null) out.add(s[1]);
    }
  }
  expect(out.size, 'corpus slug registries parsed empty').toBeGreaterThan(1000);
  return out;
}

/** `data/legacy-aliases.json` orphanPaths under a section prefix. */
function declaredAliasOrphans(): string[] {
  const file = JSON.parse(fs.readFileSync(path.join(REPO, 'data/legacy-aliases.json'), 'utf-8')) as {
    aliases: Array<{ orphanPath: string }>;
  };
  return file.aliases.map((a) => a.orphanPath).filter(underSectionPrefix);
}

/**
 * The table `EDGE_RETIRED_PATHS` must equal.
 *
 * The verb is derived, not chosen per URL by hand: a declared target that is a
 * section ROOT is not a substitute — redirecting to a hub is a soft-404 to
 * Google and keeps the URL alive — so those become 410, and everything with a
 * real target becomes a 301. Alias orphans never had a document at all, so they
 * are always 410.
 */
function deriveExpected(): Map<string, string | null> {
  const live = liveCorpusSlugs();
  const expected = new Map<string, string | null>();

  for (const [from, to] of declaredRedirects()) {
    if (!underSectionPrefix(from)) continue; // this build ships it — no edge entry
    expected.set(from, isSectionRoot(to) ? null : to);
  }

  for (const orphan of declaredAliasOrphans()) {
    // A stale alias row: the corpus has since published an article at that slug,
    // so the URL is not an orphan and must not be answered 410. This is what
    // keeps /articoli-frontaliere/kebab-case-3-5-words-max-40-chars/ alive.
    if (live.has(lastSegment(orphan))) continue;
    if (!expected.has(orphan)) expected.set(orphan, null);
  }

  return expected;
}

const expected = deriveExpected();
const actualKeys = Object.keys(RETIRED_TABLE).sort();
const expectedKeys = [...expected.keys()].sort();

describe('EDGE_RETIRED_PATHS covers every retirement the build declares', () => {
  it('has no declared retirement missing from the edge table', () => {
    const missing = expectedKeys.filter((k) => !(k in RETIRED_TABLE));
    expect(
      missing,
      `Declared dead in the build but still served by the shard.\n`
        + `Add to EDGE_RETIRED_PATHS in infra/cloudflare-worker/locale-router.js:\n`
        + missing.map((k) => `  '${k}': ${expected.get(k) === null ? 'null' : `'${expected.get(k)}'`},`).join('\n'),
    ).toEqual([]);
  });

  it('has no edge entry the build does not declare', () => {
    const extra = actualKeys.filter((k) => !expected.has(k));
    expect(
      extra,
      `Answered 301/410 at the edge with nothing in the build declaring it dead — `
        + `if the corpus publishes it again this silently deletes a live page:\n${extra.join('\n')}`,
    ).toEqual([]);
  });

  it('uses the derived verb for every entry (410 when the only target is a hub)', () => {
    for (const [p, want] of expected) {
      expect(RETIRED_TABLE[p], `${p}: wrong retirement verb`).toBe(want);
    }
  });

  it('never lists a URL the corpus still publishes', () => {
    const live = liveCorpusSlugs();
    const resurrected = actualKeys.filter((k) => live.has(lastSegment(k)));
    expect(
      resurrected,
      `These slugs are back in BLOG_SLUGS/SWISS_SLUGS — the edge is deleting live pages:\n${resurrected.join('\n')}`,
    ).toEqual([]);
  });

  it('pins the measured shape of the 2026-08-14 repair', () => {
    const gone = actualKeys.filter((k) => RETIRED_TABLE[k] === null);
    const moved = actualKeys.filter((k) => RETIRED_TABLE[k] !== null);
    // 4 retired-with-no-substitute + 20 alias orphans; 34 declared redirects
    // under the eight prefixes + 15 from data/article-redirects.json (the 3
    // prompt-leak renames, plus 12 for the nanako#356 cross-section duplicate
    // retirements added the same day).
    expect({ total: actualKeys.length, gone: gone.length, moved: moved.length }).toEqual({
      total: 73,
      gone: 24,
      moved: 49,
    });
  });
});

describe('the 16 retired-article URLs of 2026-08-06', () => {
  // Verbatim from tests/retired-runaway-articles-redirects.test.ts, which pins
  // the build side of the same four articles. Restated rather than imported so
  // that deleting either file cannot silently drop the other's coverage.
  const RETIRED_16 = [
    '/articoli-frontaliere/prezzi-proprieta-svizzera-aumentano/',
    '/en/cross-border-articles/swiss-property-prices-rise/',
    '/de/grenzgaenger-artikel/schweizer-immobilienpreise-steigen/',
    '/fr/articles-frontalier/prix-immobilier-suisse-augmentent/',
    '/articoli-frontaliere/caldo-torrido-lavoro-ticino/',
    '/en/cross-border-articles/hot-weather-work-ticino/',
    '/de/grenzgaenger-artikel/heisses-wetter-arbeit-tessin/',
    '/fr/articles-frontalier/chaleur-torrida-travail-tessin/',
    '/articoli-svizzera/lavoro-forzato-catene-svizzere/',
    '/en/swiss-articles/forced-labour-swiss-supply-chains/',
    '/de/schweiz-artikel/zwangsarbeit-schweizer-lieferketten/',
    '/fr/articles-suisse/travail-force-chaines-approvisionnement-suisse/',
    '/articoli-frontaliere/vivere-maslianico-lavorare-ticino-frontaliere/',
    '/en/cross-border-articles/live-maslianico-work-ticino-cross-border/',
    '/de/grenzgaenger-artikel/in-maslianico-wohnen-arbeiten-tessin-grenzganger/',
    '/fr/articles-frontalier/vivre-maslianico-travailler-tessin-frontalier/',
  ];

  it('is 16 URLs', () => {
    expect(RETIRED_16).toHaveLength(16);
  });

  for (const p of RETIRED_16) {
    it(`${p} is no longer indexable`, () => {
      const resp = retiredEdgeResponse(new URL(APEX + p)) as Response | null;
      expect(resp, `${p}: the edge still hands this to the shard`).not.toBeNull();
      expect([301, 410]).toContain(resp!.status);
    });
  }

  it('the fabricated-laws article is 410, not a redirect to its hub', () => {
    // Five Swiss laws that do not exist: there is no equivalent to send anyone
    // to, and a 301 to /articoli-frontaliere/ would read as a soft-404.
    for (const p of RETIRED_16.slice(0, 4)) {
      expect(RETIRED_TABLE[p], `${p} must be Gone, not moved`).toBeNull();
    }
  });

  it('the twelve with an equivalent are 301s onto a real document', () => {
    for (const p of RETIRED_16.slice(4)) {
      const to = RETIRED_TABLE[p];
      expect(to, `${p} must move to its substitute`).not.toBeNull();
      expect(isSectionRoot(to as string), `${p} → ${to} is a hub, not a document`).toBe(false);
    }
  });
});

describe('the alias orphans stop being soft-404s', () => {
  const orphans = declaredAliasOrphans().filter((p) => !liveCorpusSlugs().has(lastSegment(p)));

  it('is the 20 measured on 2026-08-14', () => {
    expect(orphans).toHaveLength(20);
  });

  for (const p of orphans) {
    it(`${p} answers 410 AND noindex`, async () => {
      const resp = retiredEdgeResponse(new URL(APEX + p)) as Response | null;
      expect(resp, `${p}: still falls through to the shard soft-landing`).not.toBeNull();
      // The defect was a page that carried NEITHER signal. Both, or it is not fixed.
      expect(resp!.status).toBe(410);
      expect(resp!.headers.get('X-Robots-Tag')).toContain('noindex');
      const html = await resp!.text();
      expect(html).toMatch(/<meta name="robots" content="noindex[^"]*">/);
      expect(html).not.toMatch(/rel="canonical"/);
    });
  }
});

describe('retiredEdgeResponse behaviour', () => {
  it('301s carry the declared target, the query and the hash', () => {
    const from = '/articoli-frontaliere/caldo-torrido-lavoro-ticino/';
    const resp = retiredEdgeResponse(new URL(`${APEX}${from}?utm_source=gsc`)) as Response;
    expect(resp.status).toBe(301);
    expect(resp.headers.get('Location')).toBe(
      `${RETIRED_TABLE[from]}?utm_source=gsc`,
    );
    expect(resp.headers.get('Cache-Control')).toMatch(/max-age=/);
  });

  it('matches the two forms a crawler re-requests from memory', () => {
    const from = '/articoli-frontaliere/caldo-torrido-lavoro-ticino/';
    for (const variant of [from.replace(/\/$/, ''), `${from}index.html`]) {
      const resp = retiredEdgeResponse(new URL(APEX + variant)) as Response | null;
      expect(resp, `${variant} must resolve like ${from}`).not.toBeNull();
      expect(resp!.status).toBe(301);
      expect(resp!.headers.get('Location')).toBe(RETIRED_TABLE[from]);
    }
  });

  it('returns null for a live article, so nothing else changes', () => {
    for (const p of [
      '/articoli-frontaliere/caldo-lavoro-frontalieri-ticino/', // the substitute itself
      '/articoli-frontaliere/kebab-case-3-5-words-max-40-chars/', // stale alias row, live article
      '/en/cross-border-articles/gaggiolo-traffic/',
      '/cerca-lavoro-ticino/',
      '/',
    ]) {
      expect(retiredEdgeResponse(new URL(APEX + p)), `${p} must be untouched`).toBeNull();
    }
  });

  it('never inherits a match from Object.prototype', () => {
    for (const p of ['/articoli-frontaliere/constructor/', '/articoli-frontaliere/toString/']) {
      expect(retiredEdgeResponse(new URL(APEX + p))).toBeNull();
    }
  });

  it('never chains: no 301 target is itself retired', () => {
    for (const [from, to] of Object.entries(RETIRED_TABLE)) {
      if (to === null) continue;
      expect(to in RETIRED_TABLE, `${from} → ${to}, which is itself retired`).toBe(false);
    }
  });

  it('every 301 target is a live document or a page outside the article sections', () => {
    // A 301 into a 404 is worse than the defect it replaces. Under the article
    // prefixes the corpus registries are the authority; outside them (e.g. the
    // Maslianico municipality pages) this build serves the target itself.
    const live = liveCorpusSlugs();
    for (const [from, to] of Object.entries(RETIRED_TABLE)) {
      if (to === null) continue;
      if (!underSectionPrefix(to)) continue;
      expect(live.has(lastSegment(to)), `${from} → ${to}, absent from the corpus registries`).toBe(true);
    }
  });
});

describe('the Worker consults the table before dispatching to the shard', () => {
  const source = fs.readFileSync(path.join(REPO, 'infra/cloudflare-worker/locale-router.js'), 'utf-8');

  it('calls retiredEdgeResponse in fetch()', () => {
    expect(source).toMatch(/const retiredResponse = retiredEdgeResponse\(url\);/);
    expect(source).toMatch(/if \(retiredResponse\) return retiredResponse;/);
  });

  it('calls it BEFORE matchSection, or the shard answers first', () => {
    // Ordering is the whole fix: matchSection hands these paths to the
    // append-only shard, which still holds the withdrawn article.
    const call = source.indexOf('const retiredResponse = retiredEdgeResponse(url);');
    const dispatch = source.indexOf('const sec = matchSection(url.pathname);');
    expect(call).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(call, 'retiredEdgeResponse must run before the section dispatch').toBeLessThan(dispatch);
  });
});
