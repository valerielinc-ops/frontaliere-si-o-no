import { describe, expect, it } from 'vitest';

import {
  slugMatchesTitle,
  isLikelyUntranslated,
  buildSlug,
  slugify,
} from '../scripts/lib/regenerate-slugs-helpers.mjs';

describe('regenerate-slugs-helpers — slugMatchesTitle', () => {
  // Regression: the original Jaccard threshold (0.5 on whole-slug overlap)
  // false-positived when company+location+percentage shared enough tokens to
  // dominate the score. RhB Chur surfaced this — the DE-derived slug was
  // treated as "already matching" the EN title, blocking translated EN slug
  // regeneration and 404-ing the EN URL.
  it('returns false when the DE-derived slug shares only structural tokens with the EN title', () => {
    const slug = 'produktmanager-in-sortiment-und-preis-80-100-ferrovia-retica-rhb-chur';
    const title = 'Product Manager (80-100%)';
    expect(slugMatchesTitle(slug, title, 'Ferrovia Retica (RhB)', 'Chur')).toBe(false);
  });

  it('returns true when the slug encodes the locale title + the same company/location', () => {
    const slug = 'product-manager-80-100-ferrovia-retica-rhb-chur';
    const title = 'Product Manager (80-100%)';
    expect(slugMatchesTitle(slug, title, 'Ferrovia Retica (RhB)', 'Chur')).toBe(true);
  });

  it('returns true when the slug carries a stable disambiguator tail', () => {
    const slug = 'product-manager-80-100-ferrovia-retica-rhb-chur-abc123';
    const title = 'Product Manager (80-100%)';
    expect(
      slugMatchesTitle(slug, title, 'Ferrovia Retica (RhB)', 'Chur', 'abc123'),
    ).toBe(true);
  });

  it('returns false on title-portion divergence even when 6 noise tokens overlap', () => {
    // Engineer slug under same company/location/percentage — engineer ≠ manager
    const slug = 'engineer-80-100-ferrovia-retica-rhb-chur';
    const title = 'Product Manager (80-100%)';
    expect(slugMatchesTitle(slug, title, 'Ferrovia Retica (RhB)', 'Chur')).toBe(false);
  });

  it('returns false for empty slug or title', () => {
    expect(slugMatchesTitle('', 'Product Manager', 'Acme', 'Lugano')).toBe(false);
    expect(slugMatchesTitle('product-manager', '', 'Acme', 'Lugano')).toBe(false);
  });

  it('returns true when both sides reduce to no title tokens after noise subtraction', () => {
    // Pathological: title is only company+location words. Both reduce to empty
    // → treat as a degenerate match (cannot meaningfully disagree).
    expect(slugMatchesTitle('acme-lugano', 'Acme', 'Acme', 'Lugano')).toBe(true);
  });
});

describe('regenerate-slugs-helpers — isLikelyUntranslated', () => {
  it('flags an EN title that is byte-identical to the DE source', () => {
    expect(isLikelyUntranslated('Software Engineer', 'Software Engineer')).toBe(true);
  });

  it('flags a partial translation that only swapped one word (Jaccard > 0.5)', () => {
    // 4-token strings sharing 3 tokens → 3/5 = 0.6 > 0.5 → flagged.
    expect(
      isLikelyUntranslated(
        'Software Ingenieur Permanent Zurich',
        'Software Engineer Permanent Zurich',
      ),
    ).toBe(true);
  });

  it('does NOT flag a properly translated short title vs a longer source', () => {
    expect(
      isLikelyUntranslated('Product Manager (80-100%)', 'Produktmanager/in Sortiment und Preis (80-100%)'),
    ).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(isLikelyUntranslated('', 'foo')).toBe(false);
    expect(isLikelyUntranslated('foo', '')).toBe(false);
  });
});

describe('regenerate-slugs-helpers — buildSlug + slugify', () => {
  it('strips diacritics and lowercases', () => {
    expect(slugify('Zürich')).toBe('zurich');
    expect(slugify('Genève')).toBe('geneve');
  });

  it('joins title + company + location into a kebab slug', () => {
    expect(buildSlug('Product Manager (80-100%)', 'Ferrovia Retica (RhB)', 'Chur')).toBe(
      'product-manager-80-100-ferrovia-retica-rhb-chur',
    );
  });

  it('appends a disambiguator tail without exceeding MAX_SLUG_LENGTH', () => {
    const slug = buildSlug('Product Manager', 'Acme', 'Lugano', 'abc123');
    expect(slug.endsWith('-abc123')).toBe(true);
  });
});
