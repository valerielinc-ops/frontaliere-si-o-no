/**
 * The article view must not fetch the jobs listing index on the critical path
 * (issue #5001 punto 3).
 *
 * Measured 2026-08-06 on a real article page, Lighthouse mobile: the fetch
 * fired immediately on mount at High priority, 3,4 MB transferred / 27,8 MB
 * decoded — 40% of the page's 8,1 MB — while the page was still painting.
 * FCP 12,7 s, LCP 26,5 s, performance score 35. Nothing above the fold needs
 * it: `relatedJobs` only feeds a sidebar and a below-content block, both of
 * which render nothing until the data lands.
 *
 * This is a source-shape assertion rather than a render test because mounting
 * BlogArticles pulls the whole article corpus and its providers; the property
 * worth protecting is "the fetch is inside the idle deferral", which is
 * exactly what a reviewer would eyeball and exactly what a well-meaning
 * refactor would undo.
 */

import fs from 'node:fs';
import np from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = fs.readFileSync(
  np.resolve(__dirname, '..', 'components', 'community', 'BlogArticles.tsx'),
  'utf-8',
);

describe('jobs index fetch on article view', () => {
  it('is deferred behind requestIdleCallback, not fired on mount', () => {
    const fetchAt = SRC.indexOf('/data/jobs-${locale}-index.json');
    expect(fetchAt, 'jobs index fetch call site not found').toBeGreaterThan(-1);

    // Walk back to the enclosing effect and require the idle shim between the
    // effect boundary and the fetch.
    const effectAt = SRC.lastIndexOf('useEffect(', fetchAt);
    expect(effectAt).toBeGreaterThan(-1);
    const between = SRC.slice(effectAt, fetchAt);

    expect(
      between,
      'the jobs index fetch must sit inside the requestIdleCallback deferral (issue #5001 punto 3)',
    ).toMatch(/requestIdleCallback/);
    expect(between, 'the idle callback must actually wrap the fetch').toMatch(/ric\(/);
  });

  it('cancels the pending idle callback on unmount', () => {
    // Without this an article-to-article navigation leaves a queued fetch that
    // resolves into a stale component.
    expect(SRC).toMatch(/cancelIdleCallback/);
  });
});
