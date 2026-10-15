/**
 * Regression — every `<url>` block in `public/sitemap-*.xml` that carries
 * hreflang `<xhtml:link>` alternates MUST have its `x-default` href equal to
 * its `it` href byte-for-byte.
 *
 * Why this exists: commit `67bb2f91c` ("fix(seo): self-canonical alias
 * pages") restored 3 alias `<url>` entries to `public/sitemap-pages.xml`
 * (`/about/`, `/contact/`, `/privacy-policy/`) but set `x-default = loc`
 * (the EN-slug alias) instead of the IT canonical, breaking the
 * `audit:hreflang` CI gate with 12 issues (the 3 alias pages × 4 locales
 * inheriting the broken default).
 *
 * The `build-plugins/shared/hreflang.ts` helper enforces the same invariant
 * at build time for plugin-emitted sitemap fragments — this test enforces
 * it at the source-of-truth XML level for any hand-maintained
 * `public/sitemap-*.xml` files.
 *
 * Failure mode: prints every offending `<url>` block with its loc, IT href,
 * and broken x-default href so the fix is obvious.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

interface UrlBlock {
  readonly sitemap: string;
  readonly loc: string;
  readonly itHref: string | null;
  readonly xDefaultHref: string | null;
}

function listSitemapFiles(): readonly string[] {
  if (!fs.existsSync(PUBLIC_DIR)) return [];
  return fs
    .readdirSync(PUBLIC_DIR)
    .filter((name) => /^sitemap-.*\.xml$/i.test(name))
    .map((name) => path.join(PUBLIC_DIR, name));
}

function parseUrlBlocks(filePath: string): readonly UrlBlock[] {
  const xml = fs.readFileSync(filePath, 'utf-8');
  const sitemapName = path.basename(filePath);
  const blocks: UrlBlock[] = [];
  // Greedy-safe block matcher — assumes no nested <url> tags (XML sitemap spec).
  const blockRegex = /<url\b[^>]*>([\s\S]*?)<\/url>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xml)) !== null) {
    const inner = match[1];
    const locMatch = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/.exec(inner);
    if (!locMatch) continue;
    const loc = locMatch[1].trim();

    const linkRegex =
      /<xhtml:link\b[^>]*\brel="alternate"[^>]*\bhreflang="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*\/>/g;
    let itHref: string | null = null;
    let xDefaultHref: string | null = null;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(inner)) !== null) {
      const lang = linkMatch[1];
      const href = linkMatch[2];
      if (lang === 'it') itHref = href;
      else if (lang === 'x-default') xDefaultHref = href;
    }

    blocks.push({ sitemap: sitemapName, loc, itHref, xDefaultHref });
  }
  return blocks;
}

const SITEMAP_FILES = listSitemapFiles();

describe('sitemap x-default alignment with IT hreflang', () => {
  it('discovers at least one public/sitemap-*.xml file', () => {
    expect(SITEMAP_FILES.length).toBeGreaterThan(0);
  });

  it('every <url> block with hreflang alternates has x-default === it', () => {
    const mismatches: Array<{
      sitemap: string;
      loc: string;
      itHref: string | null;
      xDefaultHref: string | null;
      reason: string;
    }> = [];

    for (const file of SITEMAP_FILES) {
      const blocks = parseUrlBlocks(file);
      for (const block of blocks) {
        const hasAnyHreflang =
          block.itHref !== null || block.xDefaultHref !== null;
        if (!hasAnyHreflang) continue;

        if (block.itHref === null) {
          mismatches.push({
            ...block,
            reason: 'has x-default but no it hreflang',
          });
          continue;
        }
        if (block.xDefaultHref === null) {
          mismatches.push({
            ...block,
            reason: 'has it hreflang but no x-default',
          });
          continue;
        }
        if (block.xDefaultHref !== block.itHref) {
          mismatches.push({
            ...block,
            reason: 'x-default does not match it hreflang',
          });
        }
      }
    }

    if (mismatches.length > 0) {
      const report = mismatches
        .map(
          (m) =>
            `  - [${m.sitemap}] <loc>${m.loc}</loc>\n` +
            `      it        = ${m.itHref ?? '(missing)'}\n` +
            `      x-default = ${m.xDefaultHref ?? '(missing)'}\n` +
            `      reason    = ${m.reason}`,
        )
        .join('\n');
      throw new Error(
        `Found ${mismatches.length} sitemap <url> block(s) where x-default does not match the IT hreflang:\n${report}\n\n` +
          'Fix: in each <url> block, set the x-default <xhtml:link> href to the same value as the it <xhtml:link> href.',
      );
    }

    expect(mismatches).toHaveLength(0);
  });
});
