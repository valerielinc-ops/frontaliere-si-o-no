/**
 * Dist-driven gate for the related-search cluster pages emitted by
 * `build-plugins/relatedSearchClustersPlugin.ts`.
 *
 * Inspects every page under `dist/{section}/{prefix}-*` (across all four
 * locale-localized section/prefix combos) and verifies the contracts the
 * plugin promises:
 *   - mobile-first source order (job list before <details> filler)
 *   - exactly one <h1>, one canonical, ≥1 hreflang link
 *   - <title> length ≤66 chars + no `(#abcdef12)` disambiguator
 *   - JSON-LD ItemList + BreadcrumbList present
 *   - non-empty FAQPage when present (no thin/fake content)
 *   - per-locale hub linked from section landing
 *   - no `dark:` color classes leaked into emitted HTML
 *   - text-to-HTML ratio ≥10 % (Semrush gate)
 *   - ImageObject license-fields quartet (zero tolerance)
 *   - cluster slug round-trips through parseSearchSlugFilter
 *
 * Skipped silently unless `RUN_DIST_GATES=1` is set (matches
 * `tests/seo/image-object-license-fields.test.ts`). Also short-circuits
 * when `SKIP_RELATED_SEARCH_CLUSTERS=1` left the dist clean of cluster
 * pages.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseSearchSlugFilter,
  getSearchSlugPrefix,
  getJobBoardSectionSlug,
} from '@/services/relatedSearchClusters';
import type { Locale } from '@/services/i18n';

const DIST_DIR = resolve(__dirname, '..', '..', 'dist');
const RUN_DIST_GATES = process.env.RUN_DIST_GATES === '1';

const LOCALES: ReadonlyArray<Locale> = ['it', 'en', 'de', 'fr'];

const LOCALE_PREFIX: Record<Locale, string> = {
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
};

interface ClusterPage {
  locale: Locale;
  file: string;
  slug: string;
  html: string;
}

function listClusterDirs(locale: Locale): string[] {
  const section = getJobBoardSectionSlug(locale);
  const prefix = getSearchSlugPrefix(locale);
  const sectionDir = join(DIST_DIR, LOCALE_PREFIX[locale].replace(/^\//, ''), section);
  if (!existsSync(sectionDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(sectionDir)) {
    if (!entry.startsWith(`${prefix}-`)) continue;
    const full = join(sectionDir, entry);
    if (!statSync(full).isDirectory()) continue;
    const html = join(full, 'index.html');
    if (!existsSync(html)) continue;
    out.push(html);
  }
  return out;
}

function loadClusterPages(locale: Locale, limit?: number): ClusterPage[] {
  const files = listClusterDirs(locale);
  const slice = typeof limit === 'number' ? files.slice(0, limit) : files;
  const prefixHyphen = `${getSearchSlugPrefix(locale)}-`;
  return slice.map((file) => {
    const dirName = file.split('/').slice(-2)[0];
    const slug = dirName.startsWith(prefixHyphen) ? dirName : '';
    return {
      locale,
      file,
      slug,
      html: readFileSync(file, 'utf-8'),
    };
  });
}

function extractTag(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function countMatches(html: string, re: RegExp): number {
  const m = html.match(re);
  return m ? m.length : 0;
}

function extractLdJson(html: string): unknown[] {
  const blocks: string[] = [];
  const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks
    .map((body) => {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return null;
      }
    })
    .filter((v): v is unknown => v !== null);
}

function findByType(nodes: unknown[], type: string): Record<string, unknown> | null {
  for (const node of nodes) {
    const found = walkFindType(node, type);
    if (found) return found;
  }
  return null;
}

function walkFindType(node: unknown, type: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = walkFindType(child, type);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (obj['@type'] === type) return obj;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = walkFindType(v, type);
      if (found) return found;
    }
  }
  return null;
}

function walkAllImageObjects(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkAllImageObjects(child, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj['@type'] === 'ImageObject') out.push(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') walkAllImageObjects(v, out);
  }
}

function extractVisibleText(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function ratio(html: string): number {
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  const text = extractVisibleText(html);
  const textBytes = Buffer.byteLength(text, 'utf8');
  return textBytes / Math.max(htmlBytes, 1);
}

function totalClusterCount(): number {
  let n = 0;
  for (const loc of LOCALES) n += listClusterDirs(loc).length;
  return n;
}

const HAS_DIST = existsSync(DIST_DIR);
const HAS_PAGES = HAS_DIST && totalClusterCount() > 0;

describe.skipIf(!RUN_DIST_GATES || !HAS_DIST || !HAS_PAGES)(
  'dist HTML — related-search cluster landings',
  () => {
    it('emits at least one cluster page across the four locales', () => {
      const counts: Record<Locale, number> = { it: 0, en: 0, de: 0, fr: 0 };
      let total = 0;
      for (const loc of LOCALES) {
        counts[loc] = listClusterDirs(loc).length;
        total += counts[loc];
      }
      // The plugin can emit a locale 0 if its slice was filtered out, so we
      // do not require all 4 to be non-zero — only the global total.
      expect(total).toBeGreaterThan(0);
      // Console-level info on per-locale distribution for triage.
      for (const loc of LOCALES) {
        if (counts[loc] === 0) {
          // eslint-disable-next-line no-console
          console.warn(`[related-search-clusters dist] locale ${loc}: 0 pages emitted`);
        }
      }
    });

    it('mobile-fold: <section class="job-list"> precedes any <details> in source order', () => {
      const offenders: string[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 50)) {
          const jobListIdx = page.html.indexOf('class="job-list"');
          const detailsIdx = page.html.indexOf('<details');
          if (jobListIdx === -1) {
            offenders.push(`${page.file} — no <section class="job-list"> found`);
            continue;
          }
          if (detailsIdx !== -1 && detailsIdx < jobListIdx) {
            offenders.push(
              `${page.file} — <details> appears at offset ${detailsIdx} BEFORE <section class="job-list"> at offset ${jobListIdx}`,
            );
          }
        }
      }
      expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
    });

    it('every page has exactly one <h1>, one canonical, and ≥1 hreflang alternate', () => {
      const offenders: string[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 50)) {
          const h1Count = extractTag(page.html, 'h1').length;
          if (h1Count !== 1) offenders.push(`${page.file} — <h1> count = ${h1Count}`);

          const canonicalCount = countMatches(
            page.html,
            /<link\s+rel=["']canonical["']\s+href=["'][^"']+["']/gi,
          );
          if (canonicalCount !== 1) {
            offenders.push(`${page.file} — canonical count = ${canonicalCount}`);
          }

          const hreflangCount = countMatches(
            page.html,
            /<link\s+rel=["']alternate["']\s+hreflang=["'][^"']+["']/gi,
          );
          if (hreflangCount < 1) {
            offenders.push(`${page.file} — hreflang count = ${hreflangCount}`);
          }
        }
      }
      expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
    });

    it('every <title> is ≤66 chars and contains no `(#abcdef12)` disambiguator', () => {
      const offenders: string[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc)) {
          const titles = extractTag(page.html, 'title');
          if (titles.length === 0) continue;
          const title = titles[0].trim();
          // Spread to count code points (matches build-plugins/shared/titleSuffix.ts).
          const len = [...title].length;
          if (len > 66) {
            offenders.push(`${page.file} — title length ${len}: "${title}"`);
          }
          if (/\(#[0-9a-f]{8}\)/i.test(title)) {
            offenders.push(`${page.file} — title contains hash disambiguator: "${title}"`);
          }
        }
      }
      expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
    });

    it('JSON-LD: every page emits ItemList + BreadcrumbList', () => {
      const offenders: string[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 50)) {
          const nodes = extractLdJson(page.html);
          if (!findByType(nodes, 'ItemList')) {
            offenders.push(`${page.file} — missing ItemList JSON-LD`);
          }
          if (!findByType(nodes, 'BreadcrumbList')) {
            offenders.push(`${page.file} — missing BreadcrumbList JSON-LD`);
          }
        }
      }
      expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
    });

    it('FAQPage (when present) has ≥1 mainEntity with non-empty name + acceptedAnswer.text', () => {
      const offenders: string[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc)) {
          const nodes = extractLdJson(page.html);
          const faq = findByType(nodes, 'FAQPage');
          if (!faq) continue;
          const main = faq['mainEntity'];
          if (!Array.isArray(main) || main.length === 0) {
            offenders.push(`${page.file} — FAQPage with no mainEntity`);
            continue;
          }
          for (const entry of main as Array<Record<string, unknown>>) {
            const name = String(entry?.name ?? '').trim();
            const accepted = entry?.acceptedAnswer as Record<string, unknown> | undefined;
            const text = String(accepted?.text ?? '').trim();
            if (!name || !text) {
              offenders.push(`${page.file} — FAQ entry empty (name="${name}" text-len=${text.length})`);
              break;
            }
          }
        }
      }
      expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
    });

    it('section landing links to the per-locale hub (when section landing exists)', () => {
      for (const loc of LOCALES) {
        if (listClusterDirs(loc).length === 0) continue;
        const section = getJobBoardSectionSlug(loc);
        const sectionPath = join(
          DIST_DIR,
          LOCALE_PREFIX[loc].replace(/^\//, ''),
          section,
          'index.html',
        );
        if (!existsSync(sectionPath)) {
          // eslint-disable-next-line no-console
          console.warn(`[related-search-clusters dist] section landing missing for ${loc}, skipping hub-link check`);
          continue;
        }
        const html = readFileSync(sectionPath, 'utf-8');
        const prefix = getSearchSlugPrefix(loc);
        const hubMarker = new RegExp(`/${section}/${prefix}/`);
        const hasHubLink =
          /data-related-search-hub-link="1"/.test(html) || hubMarker.test(html);
        expect(hasHubLink, `${sectionPath} does not link to /${section}/${prefix}/`).toBe(true);
      }
    });

    it('hub index lists every cluster directory on disk (±5 tolerance for pagination)', () => {
      // Pick the locale with the most clusters to get a meaningful signal.
      const counts = LOCALES.map((loc) => ({ loc, n: listClusterDirs(loc).length }));
      counts.sort((a, b) => b.n - a.n);
      const target = counts[0];
      if (!target || target.n === 0) return;
      const loc = target.loc;
      const section = getJobBoardSectionSlug(loc);
      const prefix = getSearchSlugPrefix(loc);
      const hubBase = join(
        DIST_DIR,
        LOCALE_PREFIX[loc].replace(/^\//, ''),
        section,
        prefix,
      );
      if (!existsSync(hubBase)) {
        // eslint-disable-next-line no-console
        console.warn(`[related-search-clusters dist] hub base missing for ${loc}; skipping count check`);
        return;
      }

      // Aggregate hrefs across all hub pages (page-1 = root, page-N for N≥2).
      const hubFiles: string[] = [];
      const root = join(hubBase, 'index.html');
      if (existsSync(root)) hubFiles.push(root);
      for (const entry of readdirSync(hubBase)) {
        if (!entry.startsWith('page-')) continue;
        const full = join(hubBase, entry, 'index.html');
        if (existsSync(full)) hubFiles.push(full);
      }
      if (hubFiles.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(`[related-search-clusters dist] no hub html found for ${loc}; skipping count check`);
        return;
      }

      const hrefs = new Set<string>();
      const linkRe = new RegExp(`href=["']([^"']*${section}/${prefix}-[^"'/]+/)["']`, 'gi');
      for (const f of hubFiles) {
        const html = readFileSync(f, 'utf-8');
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(html)) !== null) hrefs.add(m[1]);
      }
      const expected = target.n;
      const tolerance = 5;
      expect(
        Math.abs(hrefs.size - expected),
        `hub link count (${hrefs.size}) deviates from on-disk count (${expected}) by more than ${tolerance}`,
      ).toBeLessThanOrEqual(tolerance);
    });

    it('no `dark:` color prefix classes leak into emitted cluster HTML', () => {
      // The repo policy forbids dark:bg-/dark:text-/dark:border-/etc in
      // emitted output (semantic tokens auto-switch). `dark:prose-invert`
      // is the only legal exception and the cluster plugin uses no prose
      // classes — so any ` dark:` here is a bug.
      const offenders: string[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc)) {
          const matches = page.html.match(/\sdark:[a-z-]+/g);
          if (matches && matches.length > 0) {
            offenders.push(`${page.file} — ${matches.length} dark: class(es): ${matches.slice(0, 3).join(', ')}`);
          }
        }
      }
      expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
    });

    it('text-to-HTML ratio ≥10 % across a sample of 30 pages', () => {
      const offenders: string[] = [];
      let sampled = 0;
      outer: for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 30)) {
          const r = ratio(page.html);
          if (r < 0.1) {
            offenders.push(`${page.file} — ratio ${(r * 100).toFixed(2)}%`);
          }
          sampled++;
          if (sampled >= 30) break outer;
        }
      }
      expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
    });

    it('every ImageObject in JSON-LD carries the four GSC license fields', () => {
      // The plugin emits no ImageObject by design — this should pass
      // trivially. If a future change adds inline images, the helper at
      // services/seo/imageObjectLd.ts MUST populate the quartet.
      const required = ['acquireLicensePage', 'copyrightNotice', 'license', 'creator'] as const;
      const offenders: string[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc)) {
          const nodes = extractLdJson(page.html);
          const images: Record<string, unknown>[] = [];
          for (const n of nodes) walkAllImageObjects(n, images);
          for (const img of images) {
            const missing = required.filter((f) => !(f in img));
            if (missing.length > 0) {
              offenders.push(`${page.file} — ImageObject missing: ${missing.join(', ')}`);
            }
          }
        }
      }
      expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
    });

    it('cluster slugs round-trip through parseSearchSlugFilter to non-empty queries', () => {
      const sample: ClusterPage[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 3)) sample.push(page);
        if (sample.length >= 10) break;
      }
      expect(sample.length).toBeGreaterThan(0);
      for (const page of sample.slice(0, 10)) {
        const query = parseSearchSlugFilter(page.slug);
        expect(query, `slug "${page.slug}" parsed to null`).not.toBeNull();
        expect(query!.length, `slug "${page.slug}" parsed to empty string`).toBeGreaterThan(0);
      }
    });
  },
);

// Surface skip-reason in the test output when running without RUN_DIST_GATES.
describe.skipIf(RUN_DIST_GATES && HAS_DIST && HAS_PAGES)(
  'dist HTML — related-search cluster landings (skipped)',
  () => {
    it('skipped: set RUN_DIST_GATES=1 after `npx vite build` to enable, ensure dist/ is non-empty and the plugin is not skipped via SKIP_RELATED_SEARCH_CLUSTERS', () => {
      // Marker test so vitest output names the gate even when skipped.
      expect(true).toBe(true);
    });
  },
);
