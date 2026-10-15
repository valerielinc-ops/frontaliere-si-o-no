/**
 * Gate A — fast pre-build regression check.
 *
 * Bans `'@type': 'WebApplication'` and `'@type': 'SoftwareApplication'`
 * declarations from the source-code SEO definition modules.
 *
 * Why: Schema.org's "Software App" rich result requires `aggregateRating`
 * + `review` on the same node to be eligible. The project does not have a
 * verifiable third-party review feed, and Google's structured-data
 * guidelines forbid fabricated review data. The policy decision (commit
 * `ffb2eedf9`) is to use `WebPage` (or one of its subtypes) for every
 * ordinary landing page instead.
 *
 * The four canonical infrastructure files that legitimately *reference*
 * the type names — type registry, translator dispatcher, normaliser,
 * inLanguage whitelist — are excluded from the scan. Those modules name
 * the strings to operate on them, but never declare a schema with that
 * type.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

// Files / globs that legitimately reference the type names without
// declaring an offending schema. These are infrastructure, not SEO data.
const ALLOWLIST = new Set<string>([
  path.join('services', 'seo', 'schema-translators.ts'),
  path.join('services', 'seo', 'entity-translations.ts'),
  path.join('services', 'seo', 'inlanguage-whitelist.ts'),
  path.join('services', 'seo', 'schema-normalizers.ts'),
]);

// Files that must be scanned. Globbing is intentionally narrow — the four
// SEO modules called out by the policy plus index.html.
function collectScanTargets(): readonly string[] {
  const targets: string[] = [];

  // Every ts file directly under services/seo/ that is NOT in the allowlist
  const seoDir = path.join(ROOT, 'services', 'seo');
  for (const entry of fs.readdirSync(seoDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    const rel = path.relative(ROOT, path.join(seoDir, entry.name));
    if (ALLOWLIST.has(rel)) continue;
    targets.push(path.join(seoDir, entry.name));
  }

  // services/seoService.ts
  targets.push(path.join(ROOT, 'services', 'seoService.ts'));

  // index.html
  targets.push(path.join(ROOT, 'index.html'));

  return targets.filter((p) => fs.existsSync(p));
}

// Match `'@type': 'WebApplication'` and `"@type": "SoftwareApplication"`
// in either single- or double-quoted form, with arbitrary whitespace
// around the colon. Also matches the JSON-string form embedded in
// index.html's inline `<script type="application/ld+json">` blocks.
const OFFENDER_RE =
  /['"]@type['"]\s*:\s*['"](WebApplication|SoftwareApplication)['"]/g;

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

function scanFile(file: string): readonly Hit[] {
  const src = fs.readFileSync(file, 'utf8');
  const hits: Hit[] = [];
  let match: RegExpExecArray | null;
  OFFENDER_RE.lastIndex = 0;
  while ((match = OFFENDER_RE.exec(src)) !== null) {
    const before = src.slice(0, match.index);
    const line = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = src.indexOf('\n', match.index);
    const snippet = src
      .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      .trim();
    hits.push({ file: path.relative(ROOT, file), line, snippet });
  }
  return hits;
}

describe('Gate A — no WebApplication / SoftwareApplication in SEO source', () => {
  it('zero declarations of @type WebApplication or SoftwareApplication outside the type registry', () => {
    const allHits: Hit[] = [];
    for (const file of collectScanTargets()) {
      allHits.push(...scanFile(file));
    }
    const formatted = allHits.map(
      (h) => `${h.file}:${h.line} — ${h.snippet}`,
    );
    expect(formatted).toEqual([]);
  });
});
