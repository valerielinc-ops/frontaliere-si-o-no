/**
 * Regression: employer link-generation bugs #3, #4, #7, #8
 *
 * Before the fix:
 *   #3 — weeklyEmployersPlugin fell back to `?q=Name` even when an
 *        `/cerca-lavoro-ticino/azienda-{slug}/` page existed.
 *   #4 — newcomersHtml rendered plain `<strong>Name</strong>` with no link.
 *   #7 — jobMarketSnapshotPlugin always rendered plain text employer names.
 *   #8 — top-roles lists had no links at all.
 *
 * The fix introduced `build-plugins/shared/employerLinks.ts` with two
 * exported helpers verified here.
 */

import { describe, it, expect } from 'vitest';
import { slugifyEmployer, employerCanonicalHref } from '../../build-plugins/shared/employerLinks';

// ---------------------------------------------------------------------------
// slugifyEmployer
// ---------------------------------------------------------------------------

describe('slugifyEmployer — basic transformations', () => {
  it('lowercases the name', () => {
    expect(slugifyEmployer('ReleWant')).toBe('relewant');
  });

  it('strips accents via NFD normalisation', () => {
    // è → e, é → e
    expect(slugifyEmployer('Élan Suisse')).toBe('elan-suisse');
  });

  it("replaces apostrophe + adjacent chars with a single dash (McDonald's)", () => {
    expect(slugifyEmployer("McDonald's Switzerland")).toBe('mcdonald-s-switzerland');
  });

  it('collapses dots and spaces in initials (S.A.)', () => {
    // "Bracco Suisse S.A." → dots become dashes, trailing dash stripped
    expect(slugifyEmployer('Bracco Suisse S.A.')).toBe('bracco-suisse-s-a');
  });

  it('handles an already-slug string unchanged', () => {
    expect(slugifyEmployer('relewant')).toBe('relewant');
  });

  it('collapses multiple consecutive non-alnum chars to a single dash', () => {
    expect(slugifyEmployer('A  &  B')).toBe('a-b');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugifyEmployer('  -Firma- ')).toBe('firma');
  });

  it('handles empty string gracefully', () => {
    expect(slugifyEmployer('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// employerCanonicalHref
// ---------------------------------------------------------------------------

describe('employerCanonicalHref — slug lookup', () => {
  const knownSlugs: Set<string> = new Set(['relewant', 'mcdonald-s-switzerland', 'coop']);

  it('returns canonical href when slug is in knownSlugs', () => {
    expect(employerCanonicalHref('ReleWant', knownSlugs)).toBe(
      '/cerca-lavoro-ticino/azienda-relewant/',
    );
  });

  it('returns canonical href for mcdonald-s-switzerland', () => {
    expect(employerCanonicalHref("McDonald's Switzerland", knownSlugs)).toBe(
      '/cerca-lavoro-ticino/azienda-mcdonald-s-switzerland/',
    );
  });

  it('returns canonical href for a simple name in registry', () => {
    expect(employerCanonicalHref('Coop', knownSlugs)).toBe(
      '/cerca-lavoro-ticino/azienda-coop/',
    );
  });

  it('returns null for an employer NOT in knownSlugs', () => {
    expect(employerCanonicalHref('Unknown Corp AG', knownSlugs)).toBeNull();
  });

  it('returns null for an empty employer name', () => {
    expect(employerCanonicalHref('', knownSlugs)).toBeNull();
  });

  it('returns null when knownSlugs is empty', () => {
    expect(employerCanonicalHref('ReleWant', new Set())).toBeNull();
  });
});
