// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `tests/seo-description-length.test.ts` hard-fails the whole repo when any
 * SEO_METADATA description exceeds 170 characters. On 2026-08-08 a digest
 * shipped one of 265 and turned `tests` red on every branch at once.
 *
 * The cap was not missing — it was in the WRONG PLACE. `truncateAtWordBoundary(desc, 160)`
 * lived inside the AI flow's enrichment step, so only articles created through
 * `main()` received it. Three other producers reach the registry without ever
 * passing through it:
 *
 *   publish-journalist-article.mjs
 *   generate-events-digest-article.mjs
 *   generate-border-wait-ranking-article.mjs
 *
 * All four funnel through `registerArticleFiles`, which is where the rule now
 * lives. These assertions read the source rather than executing the writer:
 * `registerArticleFiles` mutates the repo's registries by design, so calling it
 * from a test would write real files.
 */
const SRC = readFileSync(resolve(__dirname, '..', 'scripts', 'create-article.mjs'), 'utf8');

describe('the SEO description cap lives at the shared write path', () => {
  it('registerArticleFiles clamps before touching any registry', () => {
    const body = SRC.slice(SRC.indexOf('export async function registerArticleFiles'));
    const clamp = body.indexOf('clampSeoDescriptions(data)');
    const firstWrite = Math.min(
      ...['modifyRouterTs(data)', 'modifySeoService(data)', 'modifyBlogArticlesTsx(data)']
        .map((w) => body.indexOf(w))
        .filter((i) => i > -1),
    );
    expect(clamp, 'registerArticleFiles does not call clampSeoDescriptions').toBeGreaterThan(-1);
    // Order matters: clamping after a writer would persist the long value.
    expect(clamp).toBeLessThan(firstWrite);
  });

  it('keeps one budget constant instead of a literal per call site', () => {
    expect(SRC).toMatch(/const SEO_DESCRIPTION_MAX = 160;/);
    // A re-introduced literal is how the two call sites drifted apart before.
    const enrich = SRC.slice(SRC.indexOf('data.seo.description = truncateAtWordBoundary'));
    expect(enrich.slice(0, 400)).not.toMatch(/truncateAtWordBoundary\([^)]*,\s*1[0-9][0-9]\)/);
  });

  it('clamps ogDescription too, not just description', () => {
    const fn = SRC.slice(SRC.indexOf('function clampSeoDescriptions'));
    expect(fn.slice(0, 900)).toMatch(/'description',\s*'ogDescription'/);
  });

  it('stays under the bound that seo-description-length enforces', () => {
    const hardMax = Number(
      /const HARD_MAX = (\d+)/.exec(
        readFileSync(resolve(__dirname, 'seo-description-length.test.ts'), 'utf8'),
      )?.[1],
    );
    const budget = Number(/const SEO_DESCRIPTION_MAX = (\d+)/.exec(SRC)?.[1]);
    expect(hardMax).toBeGreaterThan(0);
    expect(budget, 'the generator budget must sit under the gate it feeds').toBeLessThan(hardMax);
  });
});
