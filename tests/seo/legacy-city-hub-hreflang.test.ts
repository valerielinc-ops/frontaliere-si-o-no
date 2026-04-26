/**
 * Regression — legacy city-hub duplicate URLs (`ricerca-<city>` /
 * `search-<city>` / `suche-<city>` / `recherche-<city>`) must NOT emit
 * hreflang tags.
 *
 * Background: every geo-hub city (Lugano, Locarno, Bellinzona, …) is
 * served on two URLs — the clean canonical (`/cerca-lavoro-ticino/lugano/`)
 * and the legacy editorial URL (`/cerca-lavoro-ticino/ricerca-lugano/`).
 * Both pages are kept live for backward-compat + external links. The
 * canonical points at the clean URL.
 *
 * Semrush flags the legacy duplicate with two issues when it carries
 * hreflang tags pointing at the clean URLs:
 *   - "Conflicting hreflang and rel=canonical" — page URL ≠ any hreflang.
 *   - "No self-referencing hreflang" — no hreflang for the page's own URL.
 *
 * Fix in `build-plugins/jobsSeoPagesPlugin.ts`: strip the alternates block
 * when writing the legacy variant. Canonical alone consolidates equity
 * onto the clean URL.
 *
 * Build-output-level (opt-in): skipped cleanly when `dist/` is absent.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');

const distExists = fs.existsSync(DIST);
const describeBuild = distExists ? describe : describe.skip;

function readHtml(relPath: string): string | null {
  const abs = path.join(DIST, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf-8');
}

const LEGACY_CITY_HUB_PATHS: ReadonlyArray<{
  description: string;
  legacyPath: string;
  canonicalPath: string;
}> = [
  {
    description: 'IT — ricerca-lugano',
    legacyPath: 'cerca-lavoro-ticino/ricerca-lugano/index.html',
    canonicalPath: 'https://frontaliereticino.ch/cerca-lavoro-ticino/lugano/',
  },
  {
    description: 'EN — search-lugano',
    legacyPath: 'en/find-jobs-ticino/search-lugano/index.html',
    canonicalPath: 'https://frontaliereticino.ch/en/find-jobs-ticino/lugano/',
  },
  {
    description: 'DE — suche-lugano',
    legacyPath: 'de/jobs-im-tessin/suche-lugano/index.html',
    canonicalPath: 'https://frontaliereticino.ch/de/jobs-im-tessin/lugano/',
  },
  {
    description: 'FR — recherche-lugano',
    legacyPath: 'fr/trouver-emploi-tessin/recherche-lugano/index.html',
    canonicalPath: 'https://frontaliereticino.ch/fr/trouver-emploi-tessin/lugano/',
  },
];

const HREFLANG_RE = /<link\s+rel="alternate"\s+hreflang=/i;
const CANONICAL_RE = /<link\s+rel="canonical"\s+href="([^"]+)"/i;

describeBuild('legacy city-hub duplicates — no hreflang on canonicalized pages', () => {
  for (const { description, legacyPath, canonicalPath } of LEGACY_CITY_HUB_PATHS) {
    it(`${description} — emits canonical to clean URL and zero hreflang tags`, () => {
      const html = readHtml(legacyPath);
      if (!html) return;

      const canonicalMatch = CANONICAL_RE.exec(html);
      expect(canonicalMatch, `${legacyPath} missing canonical`).not.toBeNull();
      expect(canonicalMatch![1]).toBe(canonicalPath);

      expect(
        HREFLANG_RE.test(html),
        `${legacyPath} must NOT emit hreflang — canonical points at ${canonicalPath}`,
      ).toBe(false);
    });
  }
});
