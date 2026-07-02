// @vitest-environment node
/**
 * Unit tests for scripts/ci/check-seo-pages-syntax.mjs — the pre-commit
 * parse gate added for issue #2834 (hotfixed by PR #2833: a prior in-place
 * edit left a missing-comma ItemList array in services/seo/seo-pages.ts
 * that reached `main` unvalidated and red-gated vitest for every branch).
 *
 * Spawns the real script against a temp directory containing minimal
 * fixture files at the exact relative paths it checks, so we can prove:
 *  (a) it exits 0 on valid files,
 *  (b) it exits 1 — fast, with the exact incident's error signature — on a
 *      deliberately broken seo-pages.ts fixture reproducing the #2834 shape
 *      (two ListItem entries joined by `} {`, no comma).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/ci/check-seo-pages-syntax.mjs');

const VALID_SEO_PAGES = `const BASE_URL = 'https://frontaliereticino.ch';
export const SEO_PAGES = [
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Articoli Frontaliere",
 "numberOfItems": 2,
 "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Uno", "url": \`\${BASE_URL}/articoli-frontaliere/uno\` },
          { "@type": "ListItem", "position": 2, "name": "Due", "url": \`\${BASE_URL}/articoli-frontaliere/due\` }
 ]
 },
];
`;

// Reproduces the #2834 incident exactly: two ListItem entries with the
// trailing comma removed between them — "} {" — a hard esbuild parse error.
const BROKEN_SEO_PAGES = VALID_SEO_PAGES.replace(
  '"url": `${BASE_URL}/articoli-frontaliere/uno` },',
  '"url": `${BASE_URL}/articoli-frontaliere/uno` }',
);

const VALID_SEO_SERVICE = `export function getAllSeoMetadata() {
  return {};
}
`;

let dir: string;

function run(cwd: string) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' });
}

function writeFixtures(seoPagesSrc: string) {
  mkdirSync(join(dir, 'services', 'seo'), { recursive: true });
  writeFileSync(join(dir, 'services', 'seo', 'seo-pages.ts'), seoPagesSrc);
  writeFileSync(join(dir, 'services', 'seoService.ts'), VALID_SEO_SERVICE);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-seo-pages-syntax-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-seo-pages-syntax', () => {
  it('exits 0 when seo-pages.ts and seoService.ts both parse cleanly', () => {
    writeFixtures(VALID_SEO_PAGES);
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('parses cleanly');
  }, 30_000);

  it('exits 1 and reports the exact esbuild error on the #2834 missing-comma shape', () => {
    writeFixtures(BROKEN_SEO_PAGES);
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Expected "\]" but found "\{"/);
    expect(result.stderr).toContain('aborting');
  }, 30_000);
});
