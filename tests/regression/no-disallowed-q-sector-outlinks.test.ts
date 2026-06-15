/**
 * Regression guard: the sector hubs must never emit internal `?q=` outlinks.
 *
 * robots.txt disallows `/*?q=*`, so an internal `<a>` pointing at a `?q=`
 * keyword-search URL is a "disallowed outlink" (flagged by SearchAtlas / GSC).
 * `rel="nofollow"` is NOT an escape hatch — it is banned on internal links by
 * `tests/no-internal-nofollow.test.tsx`. The fix routes sector chips to
 * crawlable canonical pages (per-canton sector landing where one exists, else
 * the canton / TI job-board root) instead of `?q=`.
 *
 * This guards `seoHubsPlugin.ts` (the canton `settori` hub + the TI `settori`
 * hub), which build static HTML that can't be exercised cheaply in a unit test.
 * The footer (App.tsx) is covered behaviourally by
 * `tests/regression/footer-canton-scoped-seo-hubs.test.tsx`.
 *
 * Scope note: the employer / role `?q=` fallbacks in `weeklyEmployersPlugin`,
 * `jobMarketSnapshotPlugin` and the `*LandingsPlugin` files are intentionally
 * NOT covered here — those have no canonical page alternative and are mandated
 * by `tests/weekly-employers.test.ts`. They are a separate, deliberate decision.
 *
 * The pattern matched is the template-literal emission `?q=${…}`, so the
 * `?q=` tokens inside explanatory comments do not trip the guard.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

describe('sector hubs emit no robots-disallowed ?q= outlinks', () => {
  it('seoHubsPlugin.ts builds no `?q=${…}` href', () => {
    const src = readFileSync(path.join(ROOT, 'build-plugins', 'seoHubsPlugin.ts'), 'utf8');
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /[?&]q=\$\{/.test(line));
    expect(
      offenders.map((o) => `  seoHubsPlugin.ts:${o.n} → ${o.line.trim()}`),
      'seoHubsPlugin.ts emits an internal ?q= outlink (use a crawlable canonical/hub URL instead)',
    ).toEqual([]);
  });
});
