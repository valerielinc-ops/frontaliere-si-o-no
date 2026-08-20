/**
 * Guard for the ONE definition of "a non-self canonical that is CORRECT"
 * (scripts/lib/canonicalExemptions.mjs).
 *
 * Regression context — post-deploy run 32261742920: three gates over the same
 * corpus disagreed about the same page. `validate:canonical` reported
 * "1 previousSlug bridge page(s) skipped (canonical → current slug is
 * correct)" and PASSED, while `audit:sitemap-canonicals` — whose header said
 * "no bridge logic at all", verbatim — reported the identical page as its only
 * offender out of 245'886 URLs and hard-FAILED. The consolidated
 * `validate:sitemap-pages`, which re-implements the audit inline, failed with
 * it. Two of the four red gates on that run, from one missing rule that
 * re-fires on every job slug rename.
 *
 * The point of this file is that the exemptions and, just as much, the shapes
 * that are NOT exempt, keep one meaning across all three callers.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCanonicalMismatch,
  isLegitJobCanonicalConsolidation,
  isLegitLegacyAliasCanonicalization,
  isPreviousSlugBridgePage,
  isThinBridgePage,
  toPath,
} from '../../scripts/lib/canonicalExemptions.mjs';

const H = 'https://frontaliereticino.ch';

describe('canonical exemptions — legitimate non-self canonicals', () => {
  it('exempts the run 32261742920 offender (same-section job slug rename)', () => {
    expect(
      classifyCanonicalMismatch({
        url: `${H}/fr/trouver-emploi-zurich/chef-sushi-zenbu-two-spice-ag-dietlikon/`,
        canonical: `${H}/fr/trouver-emploi-zurich/chef-de-sushi-zenbu-two-spice-ag-dietlikon/`,
        html: '',
      }),
    ).toBe('job-consolidation');
  });

  it('exempts a full-content previousSlug bridge by its build marker', () => {
    expect(
      classifyCanonicalMismatch({
        url: `${H}/blog/vecchio-slug/`,
        canonical: `${H}/blog/nuovo-slug/`,
        html: '<head><script>__BRIDGE_TARGET_SLUG__</script></head>',
      }),
    ).toBe('previous-slug-bridge');
    expect(isPreviousSlugBridgePage('__BRIDGE_TARGET_SLUG__')).toBe(true);
    expect(isPreviousSlugBridgePage('<head></head>')).toBe(false);
  });

  it('exempts the legacy root aliases, and only the mapped targets', () => {
    expect(isLegitLegacyAliasCanonicalization(`${H}/about/`, `${H}/en/about-us/`)).toBe(true);
    expect(isLegitLegacyAliasCanonicalization(`${H}/about`, `${H}/en/about-us/`)).toBe(true);
    // Right alias, wrong target — not an exemption.
    expect(isLegitLegacyAliasCanonicalization(`${H}/about/`, `${H}/en/contact-us/`)).toBe(false);
    // Unmapped path — not an exemption.
    expect(isLegitLegacyAliasCanonicalization(`${H}/chi-siamo/`, `${H}/en/about-us/`)).toBe(false);
  });

  it('treats a trailing-slash-only difference as equal', () => {
    expect(classifyCanonicalMismatch({ url: `${H}/blog/x/`, canonical: `${H}/blog/x`, html: '' })).toBe(
      'trailing-slash',
    );
  });

  it('accepts consolidation across every canton section prefix', () => {
    const pairs: [string, string][] = [
      [`${H}/cerca-lavoro-ticino/a/`, `${H}/cerca-lavoro-ticino/b/`],
      [`${H}/en/find-jobs-geneva/a/`, `${H}/en/find-jobs-geneva/b/`],
      [`${H}/de/jobs-im-tessin/a/`, `${H}/de/jobs-im-tessin/b/`],
    ];
    for (const [url, canonical] of pairs) {
      expect(isLegitJobCanonicalConsolidation(url, canonical), `${url} → ${canonical}`).toBe(true);
    }
  });
});

describe('canonical exemptions — shapes that stay hard offenders', () => {
  it('does NOT exempt canonical → the section listing root', () => {
    // The one BAD case the original predicate carved out, preserved verbatim:
    // a job page canonicalising onto its own listing page is a real defect.
    expect(
      classifyCanonicalMismatch({
        url: `${H}/fr/trouver-emploi-zurich/chef-sushi-zenbu/`,
        canonical: `${H}/fr/trouver-emploi-zurich/`,
        html: '',
      }),
    ).toBeNull();
  });

  it('does NOT exempt consolidation across two different sections', () => {
    expect(
      classifyCanonicalMismatch({
        url: `${H}/fr/trouver-emploi-zurich/a/`,
        canonical: `${H}/fr/trouver-emploi-tessin/a/`,
        html: '',
      }),
    ).toBeNull();
  });

  it('does NOT exempt an unrelated page-to-page canonical', () => {
    expect(
      classifyCanonicalMismatch({ url: `${H}/blog/a/`, canonical: `${H}/blog/b/`, html: '' }),
    ).toBeNull();
  });

  it('keeps the thin "Versione canonica" stub identifiable — it is the defect, not an exemption', () => {
    expect(isThinBridgePage('<p>Versione canonica disponibile</p>')).toBe(true);
    expect(
      classifyCanonicalMismatch({
        url: `${H}/blog/a/`,
        canonical: `${H}/blog/b/`,
        html: '<p>Versione canonica disponibile</p>',
      }),
    ).toBeNull();
  });
});

describe('toPath', () => {
  it('reduces absolute URLs and bare paths to the same pathname', () => {
    expect(toPath(`${H}/a/b/`)).toBe('/a/b/');
    expect(toPath('/a/b/')).toBe('/a/b/');
    expect(toPath('a/b/')).toBe('/a/b/');
    // A different host must not silently survive as part of the "path".
    expect(toPath('https://example.com/a/b/')).toBe('/a/b/');
  });
});
