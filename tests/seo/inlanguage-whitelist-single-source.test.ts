/**
 * Regression — the `INLANGUAGE_WHITELIST` consumed by:
 *   1. services/seo/inlanguage-whitelist.ts (runtime emit-path + tests)
 *   2. scripts/validate-structured-data-completeness.mjs (CI dist scan gate)
 *
 * MUST come from a single source of truth (`inlanguage-whitelist.data.mjs`).
 *
 * Why this exists. Apr 2026: a `DigitalDocument:inLanguage` regression took
 * 4+ deploy cycles to fix because the validator script had a HARDCODED copy
 * of the whitelist that drifted from the TS one. The fix added DigitalDocument
 * to the TS whitelist but the validator gate kept failing because its
 * embedded copy still didn't know about DigitalDocument. The two lists are
 * now collapsed onto a shared `.mjs` data file. This test enforces it stays
 * that way.
 *
 * Failure mode: the test reads both files as strings and asserts that:
 *   - `inlanguage-whitelist.ts` does NOT redefine the type list (it only
 *     wraps the .mjs export in a Set)
 *   - `validate-structured-data-completeness.mjs` does NOT hardcode a Set
 *     of @type strings — it imports from the shared .mjs.
 *   - The shared data file exports an array that includes the
 *     "well-known canonical members" the project relies on (regression
 *     guard: catches accidental deletion of CreativeWork, WebPage, etc.).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TYPES_ACCEPT_IN_LANGUAGE_LIST } from '../../services/seo/inlanguage-whitelist.data.mjs';
import { TYPES_ACCEPT_IN_LANGUAGE } from '../../services/seo/inlanguage-whitelist';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TS_WHITELIST_PATH = path.join(REPO_ROOT, 'services/seo/inlanguage-whitelist.ts');
const MJS_VALIDATOR_PATH = path.join(REPO_ROOT, 'scripts/validate-structured-data-completeness.mjs');
const DATA_MJS_PATH = path.join(REPO_ROOT, 'services/seo/inlanguage-whitelist.data.mjs');

describe('inLanguage whitelist — single source of truth', () => {
  it('shared data file exists and exports a non-empty list', () => {
    expect(fs.existsSync(DATA_MJS_PATH)).toBe(true);
    expect(Array.isArray(TYPES_ACCEPT_IN_LANGUAGE_LIST as unknown as readonly string[])).toBe(true);
    expect((TYPES_ACCEPT_IN_LANGUAGE_LIST as readonly string[]).length).toBeGreaterThan(20);
  });

  it('TS whitelist matches the .mjs source byte-for-byte', () => {
    const sortedFromTs = [...TYPES_ACCEPT_IN_LANGUAGE].sort();
    const sortedFromMjs = [...(TYPES_ACCEPT_IN_LANGUAGE_LIST as readonly string[])].sort();
    expect(sortedFromTs).toEqual(sortedFromMjs);
  });

  it('TS module imports from .mjs (does not redefine the list)', () => {
    const ts = fs.readFileSync(TS_WHITELIST_PATH, 'utf-8');
    expect(ts).toMatch(/from\s+['"]\.\/inlanguage-whitelist\.data\.mjs['"]/);
    // Sanity: should NOT contain the original hardcoded `new Set([...])` block
    // (which had per-line @type literals like `'CreativeWork',\n 'WebPage',\n …`).
    // Allow the import line + ReadonlySet wrapper, but flag a verbatim list of
    // 20+ string literals separated by commas (the old hardcoded pattern).
    const literalMatches = ts.match(/^\s*'[A-Z][A-Za-z]+',$/gm) ?? [];
    expect(literalMatches.length).toBeLessThan(5);
  });

  it('validator script imports from .mjs (does not hardcode the list)', () => {
    const validator = fs.readFileSync(MJS_VALIDATOR_PATH, 'utf-8');
    expect(validator).toMatch(
      /import\s*\{\s*TYPES_ACCEPT_IN_LANGUAGE_LIST\s*\}\s*from\s*['"]\.\.\/services\/seo\/inlanguage-whitelist\.data\.mjs['"]/,
    );
    // Sanity: should NOT contain a multi-line hardcoded Set with @type literals.
    const literalMatches = validator.match(/^\s*'[A-Z][A-Za-z]+',$/gm) ?? [];
    expect(literalMatches.length).toBeLessThan(5);
  });

  it('contains all canonical CreativeWork descendants the project relies on', () => {
    const required = [
      'CreativeWork',
      'WebPage',
      'Article',
      'BlogPosting',
      'NewsArticle',
      'Dataset',
      'FAQPage',
      'WebSite',
      'Event',
      'JobPosting',
      'Product',
      // Apr 2026 additions:
      'DigitalDocument',
      'Map',
    ];
    for (const t of required) {
      expect(TYPES_ACCEPT_IN_LANGUAGE.has(t)).toBe(true);
    }
  });
});
