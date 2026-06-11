import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression gate for the seoMap key-form bug (June 2026).
 *
 * Hand-written SEO entries store canonicalPath WITH a trailing slash
 * ('/tasse-e-pensione/festivita-ticino/'), but the emit loop looked up
 * `url.path` (no trailing slash) and the dynamic glossary/border entries
 * inserted slash-less keys. Result: ~3.8k curated title/description/
 * structuredData entries were silently shadowed by the URL-derived
 * fallback ("Informazioni utili per frontalieri Svizzera-Italia: …"),
 * tanking SERP CTR on the highest-impression info pages (GSC: 19.5k
 * impressions / 48 clicks on the school-calendar page alone).
 *
 * Contract enforced here:
 *  1. Every seoMap.set/get/has call site goes through seoKey() so the
 *     key form can never diverge again.
 *  2. The entry-start regex accepts the 1-space indentation used by the
 *     space-compressed services/seo/*.ts files.
 *  3. End-to-end on the real source files: the parse regexes recover the
 *     curated entries for known high-impression pages.
 */

const ROOT = path.resolve(__dirname, '..');
const pluginSource = readFileSync(path.resolve(ROOT, 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');

describe('staticPagesPlugin seoMap key normalization', () => {
  it('routes every seoMap set/get/has through seoKey()', () => {
    const calls = pluginSource.match(/seoMap\.(?:set|get|has)\([^)\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    const unnormalized = calls.filter(c => !c.includes('seoKey('));
    expect(unnormalized).toEqual([]);
  });

  it('seoKey helper exists and yields trailing-slash form', () => {
    expect(pluginSource).toContain('const seoKey = (p: string): string =>');
  });

  it('entry-start regex accepts 1-space indentation (space-compressed seo files)', () => {
    expect(pluginSource).toMatch(/entryStartRx = \/\^\\s\{1,8\}/);
  });
});

describe('llmsTxtPlugin seo lookup key normalization', () => {
  // Same slash-divergence class: parseSitemapUrls strips trailing slashes,
  // so parseSeoEntries must key the map in the same slash-less form or every
  // hand-written entry (canonicalPath WITH slash) misses at lookup and the
  // llms.txt page index degrades to slug-derived labels.
  it('parseSeoEntries keys the map in strip-slash form', () => {
    const llmsSource = readFileSync(path.resolve(ROOT, 'build-plugins', 'llmsTxtPlugin.ts'), 'utf-8');
    expect(llmsSource).toContain("map.set(cp.replace(/\\/+$/, '') || '/', { title, desc });");
    expect(llmsSource).not.toMatch(/map\.set\(cp,/);
  });
});

describe('seo source files parse contract (real files)', () => {
  // Mirror of the plugin's entry scanner — keep in sync with
  // build-plugins/staticPagesPlugin.ts entryStartRx/NON_ENTRY_KEYS.
  const NON_ENTRY_KEYS = new Set([
    'structuredData', 'acceptedAnswer', 'areaServed', 'potentialAction',
    'target', 'offers', 'logo', 'creator', 'spatialCoverage', 'step',
    'itemListElement', 'mainEntity', 'author', 'publisher', 'image',
  ]);

  const parseEntries = (src: string): Map<string, { title: string; desc: string }> => {
    const entryStartRx = /^\s{1,8}(?:'([^']+)'|([a-zA-Z_]\w*)):\s*\{/gm;
    const starts: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = entryStartRx.exec(src)) !== null) {
      const key = m[1] ?? m[2];
      if (NON_ENTRY_KEYS.has(key)) continue;
      starts.push(m.index);
    }
    const map = new Map<string, { title: string; desc: string }>();
    for (let i = 0; i < starts.length; i++) {
      const block = src.substring(starts[i], i + 1 < starts.length ? starts[i + 1] : src.length);
      const cp = block.match(/canonicalPath:\s*'([^']+)'/)?.[1];
      if (!cp) continue;
      const matchStr = (key: string): string => {
        const rx = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`);
        return block.match(rx)?.[1] ?? '';
      };
      const title = matchStr('title');
      if (title) map.set(cp.replace(/\/+$/, '') + '/', { title, desc: matchStr('description') });
    }
    return map;
  };

  it('recovers curated entries for known high-impression pages', () => {
    const src = readFileSync(path.resolve(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
    const entries = parseEntries(src);

    // High-impression pages that shipped fallback meta while the bug was live.
    const mustHave = [
      '/vita-in-ticino/vacanze-scolastiche-ticino-2026/',
      '/tasse-e-pensione/festivita-ticino/',
      '/vivere-in-ticino/comuni-di-frontiera/',
      '/tasse-e-pensione/ristorni-fiscali/',
    ];
    for (const cp of mustHave) {
      const entry = entries.get(cp);
      expect(entry, `missing curated entry for ${cp}`).toBeTruthy();
      // The curated title must NOT be the URL-derived fallback shape
      // ("Vacanze Scolastiche Ticino 2026 | Frontaliere Ticino" built from the slug).
      expect(entry!.desc, `curated description for ${cp} must not be the generic fallback`)
        .not.toMatch(/^Informazioni utili per frontalieri/);
      expect(entry!.desc.length, `curated description for ${cp} should be substantive`).toBeGreaterThan(60);
    }
  });

  it('parses a substantial share of hand-written canonicalPath entries', () => {
    const src = readFileSync(path.resolve(ROOT, 'services', 'seo', 'seo-pages.ts'), 'utf-8');
    const entries = parseEntries(src);
    const cpCount = (src.match(/canonicalPath:\s*'/g) ?? []).length;
    // Every canonicalPath belongs to exactly one entry; allow a small slack
    // for entries without a single-quoted title (template-literal titles).
    expect(entries.size).toBeGreaterThanOrEqual(Math.floor(cpCount * 0.95));
  });
});
