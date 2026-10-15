/**
 * The hub renders must happen BEFORE the CDN offload (issue #5270).
 *
 * Why this is a test and not just a comment: the ordering was wrong for as
 * long as the archive re-render existed, and nothing caught it. The full build
 * is immune (there the offload runs after the whole build, archive included),
 * so the breakage only appeared after a fast publish and healed at the next
 * deploy — invisible to CI, invisible to a spot check made at the wrong time.
 *
 * What it broke: `articleHubPagesPlugin` emits `src="/assets/${entryJs}"` as
 * plain text, and the offload is the only pass that rewrites those to the CDN.
 * The deploy then DELETES `dist/assets`, so a page that misses the rewrite has
 * no working CSS, no SPA bundle and no AdSense loader. Measured live on
 * 2026-08-06: all four locales, both sections, 9 same-origin asset refs each,
 * all 404.
 *
 * The assertion is on source order rather than on a rendered dist because
 * running the real pipeline needs the whole corpus; the same deterministic
 * source-scan contract `scripts/ci/check-sibling-patterns.mjs` and
 * `check-below-floor-bridge.mjs` already use.
 *
 * WHERE THE ORDER LIVES NOW (issue #5432 point 2). The three steps were
 * extracted out of `scripts/publish-article-fast.mjs` into
 * `scripts/lib/render-and-push-hubs.mjs` so that a SECOND caller
 * (`scripts/rerender-article-hubs.mjs`) could re-render a section's hubs
 * without publishing an article — which is what gives a change to the hub
 * renderers any way at all of reaching the served pages.
 *
 * That extraction is what these assertions now guard, and it is why they are
 * split in two:
 *   - the ORDER is asserted in the library, the single place it is expressed;
 *   - the ABSENCE of the call sites is asserted in each caller, because the
 *     failure mode this file exists to prevent is not "someone reordered two
 *     lines", it is "someone grew a second copy of the pipeline". A copy would
 *     satisfy an order assertion of its own on the day it was written and
 *     drift afterwards — exactly how the corpus's own copy of
 *     publish-article-fast.mjs kept publishing the broken order for days after
 *     this repo fixed it (#5271).
 */

import fs from 'node:fs';
import np from 'node:path';
import { describe, it, expect } from 'vitest';

const readScript = (...rel: string[]) =>
  fs.readFileSync(np.resolve(__dirname, '..', ...rel), 'utf-8');

const LIB = readScript('scripts', 'lib', 'render-and-push-hubs.mjs');
const PUBLISHER = readScript('scripts', 'publish-article-fast.mjs');
const RERENDER = readScript('scripts', 'rerender-article-hubs.mjs');

describe('hub render / CDN offload order', () => {
  it('renders the article-hub archive before running the CDN offload', () => {
    const archiveAt = LIB.indexOf('await renderArticleHubPages(');
    const offloadAt = LIB.indexOf("'offload-generated-images-cdn.mjs'");

    // Non-vacuity: if either call site is renamed away, this test must fail
    // loudly rather than silently pass on two -1s.
    expect(archiveAt, 'renderArticleHubPages call site not found').toBeGreaterThan(-1);
    expect(offloadAt, 'offload-generated-images-cdn.mjs spawn not found').toBeGreaterThan(-1);

    expect(
      archiveAt,
      'the archive must be rendered BEFORE the CDN offload, or its /assets refs stay same-origin and 404 (issue #5270)',
    ).toBeLessThan(offloadAt);
  });

  // The topic hubs (#5001) joined this pipeline after the archive did, and they
  // carry the SAME hardcoded `/assets/...` refs for the same reason — so they
  // inherit the #5270 constraint verbatim. Guarded separately rather than by
  // widening the archive assertion: the two renders can be reordered
  // independently, and a guard that only checks one of them would go quiet
  // exactly when the other moved.
  it('renders the topic-cluster hubs before running the CDN offload', () => {
    const topicAt = LIB.indexOf('await renderTopicClusterHubPages(');
    const offloadAt = LIB.indexOf("'offload-generated-images-cdn.mjs'");

    expect(topicAt, 'renderTopicClusterHubPages call site not found').toBeGreaterThan(-1);
    expect(offloadAt, 'offload-generated-images-cdn.mjs spawn not found').toBeGreaterThan(-1);

    expect(
      topicAt,
      'the topic hubs must be rendered BEFORE the CDN offload, or their /assets refs stay same-origin and 404 (issue #5270)',
    ).toBeLessThan(offloadAt);
  });

  it('emits both hub families into the same scratch dist the offload walks', () => {
    // The offload rewrites whatever is under `dist`; the hub renders must
    // target that same directory or the ordering above buys nothing.
    for (const call of ['await renderArticleHubPages(', 'await renderTopicClusterHubPages(']) {
      const at = LIB.indexOf(call);
      expect(LIB.slice(at, at + 220), `${call} does not name distDir`).toMatch(/distDir/);
    }
    const offloadAt = LIB.indexOf("'offload-generated-images-cdn.mjs'");
    // The offload is spawned with cwd = a temp dir holding a `dist` symlink to
    // the very distDir the renders wrote into.
    expect(LIB.slice(Math.max(0, offloadAt - 400), offloadAt + 200)).toMatch(/symlinkSync\(distDir/);
  });

  it('exposes the three steps only as one composed call, never separately ordered by a caller', () => {
    // `renderHubsAndOffload` is the only exported entry point that both
    // renders and offloads. If a caller could get the pieces in an order of
    // its own choosing, the order assertions above would only describe the
    // library's internals and not what actually runs.
    const composed = LIB.indexOf('export async function renderHubsAndOffload');
    expect(composed, 'renderHubsAndOffload is not exported').toBeGreaterThan(-1);
    expect(LIB.slice(composed)).toMatch(/renderSectionHubs\([\s\S]*offloadGeneratedImagesCdn\(/);
  });
});

describe('the hub pipeline has exactly one implementation', () => {
  // Both callers must DELEGATE. A caller that re-imports the renderers or
  // re-spawns the offload has forked the pipeline, and the order assertions
  // above stop describing what it does.
  for (const [name, src] of [
    ['scripts/publish-article-fast.mjs', PUBLISHER],
    ['scripts/rerender-article-hubs.mjs', RERENDER],
  ] as const) {
    it(`${name} delegates to scripts/lib/render-and-push-hubs.mjs`, () => {
      expect(src, `${name} does not import the shared pipeline`).toMatch(
        /from '\.\.?\/(lib\/)?render-and-push-hubs\.mjs'/,
      );
      expect(src).toMatch(/renderHubsAndOffload\(/);
    });

    it(`${name} does not carry its own copy of the pipeline`, () => {
      expect(src, `${name} re-imports seoHubsPlugin directly`).not.toMatch(
        /import\(\s*'[^']*seoHubsPlugin\.ts'/,
      );
      expect(src, `${name} re-imports topicClusterHubsPlugin directly`).not.toMatch(
        /import\(\s*'[^']*topicClusterHubsPlugin\.ts'/,
      );
      expect(src, `${name} re-spawns the CDN offload`).not.toMatch(
        /'offload-generated-images-cdn\.mjs'/,
      );
    });
  }

  it('forwards the topic-hub relpaths to the shard push', () => {
    // The hubs are written into the scratch dist, but only what the caller
    // lists actually ships. Rendering them without listing them writes files
    // nobody pushes — the silent half of the same orphan bug.
    //
    // Both callers get that list from the SAME helper, so this asserts the
    // helper unions the two families rather than asserting a shape each
    // caller happens to build by hand.
    expect(LIB).toMatch(/topicHubResult\?\.pathsByLocale\?\.\[locale\]/);
    expect(PUBLISHER).toMatch(/topicHubResult\.pathsByLocale\[locale\]/);
    expect(RERENDER).toMatch(/hubPathsByLocale\(/);
  });
});
