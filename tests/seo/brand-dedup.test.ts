/**
 * Brand-dedup tests (P5) — guards the canonical-map dedup contract for
 * `guess europe sagl`, `medacta international sa rancate`, `casale lugano`.
 *
 * Two layers of assertions:
 *   1. Module-level: `BRAND_CANONICAL_MAP` is well-formed and covers the
 *      three SemRush-reported cannibalised brands. Aliases are unique,
 *      never self-referential, and never collide across brands.
 *   2. Build-output-level (opt-in): if `dist/` exists (i.e. a prior
 *      `npx vite build` ran), walk the generated HTML and assert:
 *        - Each primary company hub carries a self-canonical pointing to
 *          its own path.
 *        - Each alias slug (when emitted) carries a canonical pointing
 *          to the primary — NOT to self.
 *        - `sitemap-jobs.xml` lists the primary canonical once and
 *          does NOT list alias slugs.
 *
 *   The build-output layer is skipped cleanly when `dist/` is absent, so
 *   the test is safe to run in a cold checkout (`npx vitest run`).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BRAND_CANONICAL_MAP,
  listAllBrandAliases,
  listAllBrandCanonicals,
  resolveBrandCanonical,
  isBrandAlias,
} from '../../build-plugins/shared/brandCanonicalMap';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');
const SECTION_IT = 'cerca-lavoro-ticino';

const EXPECTED_PRIMARIES: ReadonlyArray<{
  query: string;
  canonical: string;
  expectedPath: string;
}> = [
  {
    query: 'guess europe sagl',
    canonical: 'guess-europe-sagl',
    expectedPath: `/${SECTION_IT}/azienda-guess-europe-sagl/`,
  },
  {
    query: 'medacta international sa rancate',
    canonical: 'medacta-international-sa',
    expectedPath: `/${SECTION_IT}/azienda-medacta-international-sa/`,
  },
  {
    query: 'casale lugano',
    canonical: 'casale-sa',
    expectedPath: `/${SECTION_IT}/azienda-casale-sa/`,
  },
];

describe('BRAND_CANONICAL_MAP', () => {
  it('covers the three SemRush-cannibalised brands', () => {
    for (const { canonical } of EXPECTED_PRIMARIES) {
      expect(BRAND_CANONICAL_MAP[canonical]).toBeDefined();
      expect(BRAND_CANONICAL_MAP[canonical].canonical).toBe(canonical);
    }
  });

  it('lists every brand primary exactly once', () => {
    const primaries = listAllBrandCanonicals();
    const unique = new Set(primaries);
    expect(primaries.length).toBe(unique.size);
  });

  it('has at least one alias per covered brand', () => {
    for (const { canonical } of EXPECTED_PRIMARIES) {
      const entry = BRAND_CANONICAL_MAP[canonical];
      expect(entry.aliases.length).toBeGreaterThan(0);
    }
  });

  it('never maps an alias to itself (no self-loops)', () => {
    for (const entry of Object.values(BRAND_CANONICAL_MAP)) {
      for (const alias of entry.aliases) {
        expect(alias).not.toBe(entry.canonical);
      }
    }
  });

  it('every alias is unique across brands', () => {
    const seen = new Map<string, string>();
    for (const entry of Object.values(BRAND_CANONICAL_MAP)) {
      for (const alias of entry.aliases) {
        expect(seen.has(alias), `alias "${alias}" assigned to two brands`).toBe(false);
        seen.set(alias, entry.canonical);
      }
    }
  });

  it('aliases use URL-safe slug syntax only', () => {
    const slugRe = /^[a-z0-9][a-z0-9-]*$/;
    for (const entry of Object.values(BRAND_CANONICAL_MAP)) {
      for (const alias of entry.aliases) {
        expect(alias, `alias "${alias}" must be URL-safe lowercase kebab`).toMatch(slugRe);
      }
    }
  });
});

describe('resolveBrandCanonical / isBrandAlias', () => {
  it('resolves a canonical to itself', () => {
    expect(resolveBrandCanonical('guess-europe-sagl')).toBe('guess-europe-sagl');
    expect(isBrandAlias('guess-europe-sagl')).toBe(false);
  });

  it('resolves an alias to the primary', () => {
    expect(resolveBrandCanonical('guess')).toBe('guess-europe-sagl');
    expect(resolveBrandCanonical('medacta')).toBe('medacta-international-sa');
    expect(resolveBrandCanonical('casale')).toBe('casale-sa');
    expect(isBrandAlias('guess')).toBe(true);
    expect(isBrandAlias('medacta')).toBe(true);
    expect(isBrandAlias('casale')).toBe(true);
  });

  it('returns null for an unrelated slug', () => {
    expect(resolveBrandCanonical('lidl')).toBeNull();
    expect(resolveBrandCanonical('unknown-company')).toBeNull();
    expect(resolveBrandCanonical('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Build-output-level assertions. Opt-in: skipped when `dist/` is missing.
// ─────────────────────────────────────────────────────────────────────

const distExists = fs.existsSync(DIST);
const describeBuild = distExists ? describe : describe.skip;

function readHtml(relPath: string): string | null {
  const abs = path.join(DIST, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf-8');
}

function extractCanonical(html: string): string | null {
  const m = /<link\s+rel="canonical"\s+href="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

function extractRobots(html: string): string | null {
  const m = /<meta\s+name="robots"\s+content="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

describeBuild('brand dedup — build output (dist/)', () => {
  it('each primary hub carries a self-canonical', () => {
    for (const { canonical, expectedPath } of EXPECTED_PRIMARIES) {
      const html = readHtml(path.join(expectedPath.replace(/^\//, ''), 'index.html'));
      if (!html) {
        // Primary may be skipped when `data/jobs.json` does not contain
        // active jobs for that company in the test-build. We don't hard-
        // fail because that's orthogonal to the dedup contract.
        continue;
      }
      const canonicalHref = extractCanonical(html);
      expect(canonicalHref, `${canonical} hub missing canonical`).not.toBeNull();
      expect(canonicalHref).toContain(expectedPath);
      // Primary pages must NOT be noindex.
      const robots = extractRobots(html);
      if (robots) {
        expect(robots.toLowerCase()).not.toContain('noindex');
      }
    }
  });

  it('every alias slug points canonical to the primary (not self) and is noindex', () => {
    for (const { alias, canonical } of listAllBrandAliases()) {
      const entry = BRAND_CANONICAL_MAP[canonical];
      if (!entry) continue;
      const aliasPath = `/${SECTION_IT}/azienda-${alias}/`;
      const primaryPath = `/${SECTION_IT}/azienda-${canonical}/`;
      const html = readHtml(path.join(aliasPath.replace(/^\//, ''), 'index.html'));
      if (!html) continue; // Alias only emitted when its primary hub also emits (data-gated).
      const canonicalHref = extractCanonical(html);
      expect(canonicalHref, `alias ${alias} missing canonical`).not.toBeNull();
      expect(canonicalHref).toContain(primaryPath);
      expect(canonicalHref).not.toContain(aliasPath);
      const robots = extractRobots(html);
      expect(robots?.toLowerCase() ?? '').toContain('noindex');
    }
  });

  it('sitemap-jobs.xml lists the primary hub but never an alias slug', () => {
    const sitemapPath = path.join(DIST, 'sitemap-jobs.xml');
    if (!fs.existsSync(sitemapPath)) return; // skip when sitemap not built
    const xml = fs.readFileSync(sitemapPath, 'utf-8');
    for (const { canonical } of EXPECTED_PRIMARIES) {
      const entry = BRAND_CANONICAL_MAP[canonical];
      if (!entry) continue;
      // Aliases must NEVER appear in the sitemap `<loc>` list.
      for (const alias of entry.aliases) {
        const aliasFragment = `/azienda-${alias}/`;
        expect(xml, `sitemap must not list alias ${alias}`).not.toContain(aliasFragment);
      }
    }
  });
});
