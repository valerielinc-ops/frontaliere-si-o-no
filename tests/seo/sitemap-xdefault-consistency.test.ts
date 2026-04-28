/**
 * Gate B — fast pre-build regression check.
 *
 * For every `<url>` block in every `public/sitemap-*.xml` file, the
 * `x-default` xhtml:link href MUST equal the `it` xhtml:link href.
 * Trailing slashes are normalised before comparison.
 *
 * Why: Italian is the canonical / default locale of the site. Search
 * engines treat `x-default` as the fallback locale, which is also the
 * canonical locale here. If `x-default` and `it` diverge, Google receives
 * conflicting signals about which URL is canonical and ranking suffers.
 *
 * This caught the regression in commit `67bb2f91c` where `/about/`,
 * `/contact/`, and `/privacy-policy/` had `x-default` pointing to
 * /en/... while `it` pointed to /it/... .
 *
 * Note: another agent in this same wave is writing a similar test at
 * `tests/seo/sitemap-xdefault-matches-it.test.ts`. The orchestrator will
 * deduplicate after merge — see comment in task brief.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const SITEMAP_DIR = path.join(ROOT, 'public');

interface UrlBlock {
  readonly loc: string;
  readonly itHref: string | null;
  readonly xDefaultHref: string | null;
}

function listSitemaps(): readonly string[] {
  if (!fs.existsSync(SITEMAP_DIR)) return [];
  return fs
    .readdirSync(SITEMAP_DIR)
    .filter((f) => /^sitemap-.*\.xml$/.test(f))
    .map((f) => path.join(SITEMAP_DIR, f));
}

/**
 * Normalise a URL by collapsing the trailing slash difference. We treat
 * `https://example.com/foo` and `https://example.com/foo/` as equal.
 */
function normaliseHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed === '') return trimmed;
  return trimmed.replace(/\/+$/, '');
}

/**
 * Parse a single <url>...</url> block. Returns null if no <loc> found.
 *
 * We use a regex-based parser rather than a full XML parser for speed —
 * the sitemaps are large (sitemap-blog.xml is ~1.4 MB) and the structure
 * is consistent. We only need three fields per block.
 */
function parseUrlBlock(block: string): UrlBlock | null {
  const locMatch = block.match(/<loc>([^<]+)<\/loc>/);
  if (!locMatch) return null;
  const loc = locMatch[1].trim();

  // hreflang values are sometimes lowercase, sometimes mixed-case in other
  // sitemaps. Match case-insensitively to be safe.
  const itMatch = block.match(
    /<xhtml:link\b[^>]*\bhreflang=["']it["'][^>]*\bhref=["']([^"']+)["'][^>]*\/>/i,
  );
  // Also accept href before hreflang (XML attribute order is arbitrary).
  const itMatchAlt = itMatch
    ? null
    : block.match(
        /<xhtml:link\b[^>]*\bhref=["']([^"']+)["'][^>]*\bhreflang=["']it["'][^>]*\/>/i,
      );

  const xDefaultMatch = block.match(
    /<xhtml:link\b[^>]*\bhreflang=["']x-default["'][^>]*\bhref=["']([^"']+)["'][^>]*\/>/i,
  );
  const xDefaultMatchAlt = xDefaultMatch
    ? null
    : block.match(
        /<xhtml:link\b[^>]*\bhref=["']([^"']+)["'][^>]*\bhreflang=["']x-default["'][^>]*\/>/i,
      );

  return {
    loc,
    itHref: (itMatch?.[1] ?? itMatchAlt?.[1] ?? null),
    xDefaultHref: (xDefaultMatch?.[1] ?? xDefaultMatchAlt?.[1] ?? null),
  };
}

function extractBlocks(xml: string): readonly UrlBlock[] {
  const blocks: UrlBlock[] = [];
  // Match every <url>...</url> block. The `s` flag (dotAll) lets `.` match
  // newlines, which sitemaps use heavily.
  const re = /<url>([\s\S]*?)<\/url>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const parsed = parseUrlBlock(m[1]);
    if (parsed) blocks.push(parsed);
  }
  return blocks;
}

interface Mismatch {
  readonly sitemap: string;
  readonly loc: string;
  readonly itHref: string;
  readonly xDefaultHref: string;
}

describe('Gate B — sitemap x-default href consistency', () => {
  it('every <url> block: x-default href equals it href (trailing-slash normalised)', () => {
    const sitemaps = listSitemaps();
    expect(sitemaps.length, 'expected at least one sitemap-*.xml in public/').toBeGreaterThan(0);

    const mismatches: Mismatch[] = [];
    for (const sitemap of sitemaps) {
      const xml = fs.readFileSync(sitemap, 'utf8');
      const blocks = extractBlocks(xml);
      for (const block of blocks) {
        // Skip blocks that don't carry locale alternates at all (e.g.
        // news / image-only entries that legitimately have no <xhtml:link>).
        if (block.itHref === null && block.xDefaultHref === null) continue;
        // If only one is present, that's a different kind of bug — flag it.
        if (block.itHref === null || block.xDefaultHref === null) {
          mismatches.push({
            sitemap: path.relative(ROOT, sitemap),
            loc: block.loc,
            itHref: block.itHref ?? '<MISSING>',
            xDefaultHref: block.xDefaultHref ?? '<MISSING>',
          });
          continue;
        }
        if (normaliseHref(block.itHref) !== normaliseHref(block.xDefaultHref)) {
          mismatches.push({
            sitemap: path.relative(ROOT, sitemap),
            loc: block.loc,
            itHref: block.itHref,
            xDefaultHref: block.xDefaultHref,
          });
        }
      }
    }

    const formatted = mismatches.map(
      (m) => `${m.sitemap} | ${m.loc} | it=${m.itHref} | x-default=${m.xDefaultHref}`,
    );
    expect(formatted).toEqual([]);
  });
});
