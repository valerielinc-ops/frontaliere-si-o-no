/**
 * Regression test for issue #3302 (adversarial follow-up of #3300).
 *
 * `scripts/build-search-cluster-301-map.mjs`'s `nationalSlugBody()` decides
 * whether a legacy cluster URL's slug body is "specific" (candidate for a
 * live per-role cluster redirect) or should fall through to the city/board
 * fallback. The pre-#3300 `LEADING_BOILERPLATE` logic explicitly emptied the
 * body when it was EXACTLY one boilerplate word (`body === p → body = ''`),
 * so a legacy `/ricerca-lavoro/` slug fell through to the fallback instead of
 * being treated as a "specific" role.
 *
 * The #3300 refactor swapped that per-word loop for the shared, multi-locale
 * `stripSearchQueryBoilerplate()` — which deliberately NEVER empties its
 * input (it's shared with display-facing callers that must never blank a
 * search box, see tests/related-search-clusters.test.ts's "never empties a
 * query that is only boilerplate" case). That left `nationalSlugBody()`
 * treating an all-boilerplate body (e.g. "lavoro") as unchanged-and-specific
 * instead of empty, silently regressing redirect-target correctness for that
 * boundary case on a future map regeneration.
 */

import { describe, it, expect } from 'vitest';
import { nationalSlugBody } from '../scripts/build-search-cluster-301-map.mjs';

describe('nationalSlugBody — all-boilerplate body must resolve to null (#3302)', () => {
  it('IT: a body that is EXACTLY one boilerplate word empties to null', () => {
    expect(nationalSlugBody('/cerca-lavoro-ticino/ricerca-lavoro/', 'it')).toBeNull();
  });

  it('EN: a body that is EXACTLY one boilerplate word empties to null', () => {
    expect(nationalSlugBody('/en/find-jobs-ticino/search-jobs/', 'en')).toBeNull();
  });

  it('DE: a body that is EXACTLY one boilerplate word empties to null', () => {
    expect(nationalSlugBody('/de/jobs-in-zuerich/suche-stellen/', 'de')).toBeNull();
  });

  it('FR: a body that is EXACTLY one boilerplate word empties to null', () => {
    expect(nationalSlugBody('/fr/trouver-emploi-geneve/recherche-emploi/', 'fr')).toBeNull();
  });

  it('a body that is entirely boilerplate PHRASE words (multi-word) also empties to null', () => {
    // "offerte di lavoro" — every token ("offerte", "di", "lavoro") is a
    // boilerplate word, so there is no specific-role signal left.
    expect(nationalSlugBody('/cerca-lavoro-ticino/ricerca-offerte-di-lavoro/', 'it')).toBeNull();
  });

  it('a boilerplate word MIXED with real content keeps stripping only the boilerplate part', () => {
    // Must NOT regress: "lavoro cuoco" still correctly strips the leading
    // "lavoro" and keeps the real content word "cuoco" as the specific body.
    expect(nationalSlugBody('/cerca-lavoro-ticino/ricerca-lavoro-cuoco/', 'it')).toBe('cuoco');
  });

  it('a non-boilerplate body is left untouched', () => {
    expect(nationalSlugBody('/cerca-lavoro-ticino/ricerca-infermiere/', 'it')).toBe('infermiere');
  });

  it('a trailing "-svizzera" nation suffix is stripped before the boilerplate check', () => {
    expect(nationalSlugBody('/cerca-lavoro-ticino/ricerca-lavoro-svizzera/', 'it')).toBeNull();
  });
});
