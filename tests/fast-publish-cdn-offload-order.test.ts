/**
 * The archive render must happen BEFORE the CDN offload in the fast-publish
 * pipeline (issue #5270).
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
 */

import fs from 'node:fs';
import np from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = fs.readFileSync(
  np.resolve(__dirname, '..', 'scripts', 'publish-article-fast.mjs'),
  'utf-8',
);

describe('fast-publish pipeline order', () => {
  it('renders the article-hub archive before running the CDN offload', () => {
    const archiveAt = SRC.indexOf('await renderArticleHubPages(');
    const offloadAt = SRC.indexOf("'offload-generated-images-cdn.mjs'");

    // Non-vacuity: if either call site is renamed away, this test must fail
    // loudly rather than silently pass on two -1s.
    expect(archiveAt, 'renderArticleHubPages call site not found').toBeGreaterThan(-1);
    expect(offloadAt, 'offload-generated-images-cdn.mjs spawn not found').toBeGreaterThan(-1);

    expect(
      archiveAt,
      'the archive must be rendered BEFORE the CDN offload, or its /assets refs stay same-origin and 404 (issue #5270)',
    ).toBeLessThan(offloadAt);
  });

  it('still emits the archive pages into the same scratch dist the offload walks', () => {
    // The offload rewrites whatever is under `dist`; the archive render must
    // target that same directory or the reorder above buys nothing.
    const call = SRC.slice(
      SRC.indexOf('await renderArticleHubPages('),
      SRC.indexOf('await renderArticleHubPages(') + 220,
    );
    expect(call).toMatch(/distDir/);
  });

  // The topic hubs (#5001) joined this pipeline after the archive did, and they
  // carry the SAME hardcoded `/assets/...` refs for the same reason — so they
  // inherit the #5270 constraint verbatim. Guarded separately rather than by
  // widening the archive assertion: the two renders can be reordered
  // independently, and a guard that only checks one of them would go quiet
  // exactly when the other moved.
  it('renders the topic-cluster hubs before running the CDN offload', () => {
    const topicAt = SRC.indexOf('await renderTopicClusterHubPages(');
    const offloadAt = SRC.indexOf("'offload-generated-images-cdn.mjs'");

    expect(topicAt, 'renderTopicClusterHubPages call site not found').toBeGreaterThan(-1);
    expect(offloadAt, 'offload-generated-images-cdn.mjs spawn not found').toBeGreaterThan(-1);

    expect(
      topicAt,
      'the topic hubs must be rendered BEFORE the CDN offload, or their /assets refs stay same-origin and 404 (issue #5270)',
    ).toBeLessThan(offloadAt);
  });

  it('emits the topic hubs into the same scratch dist the offload walks', () => {
    const at = SRC.indexOf('await renderTopicClusterHubPages(');
    expect(SRC.slice(at, at + 220)).toMatch(/distDir/);
  });

  it('forwards the topic-hub relpaths to the shard push', () => {
    // The hubs are written into the scratch dist, but the deploy only pushes
    // what `shards[].paths` lists. Rendering them without listing them writes
    // files nobody ships — the silent half of the same orphan bug.
    expect(SRC).toMatch(/topicHubResult\.pathsByLocale\[locale\]/);
  });
});
