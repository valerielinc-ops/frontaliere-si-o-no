/**
 * Dist-driven gate for the related-search cluster pages emitted by
 * `build-plugins/relatedSearchClustersPlugin.ts`.
 *
 * Inspects every page under `dist/{section}/{prefix}-*` (across all four
 * locale-localized section/prefix combos) and verifies the contracts the
 * plugin promises:
 *   - mobile-first source order (job list before <details> filler)
 *   - exactly one <h1>, one canonical, and an hreflang set that is either
 *     ABSENT or COMPLETE — never partial (matched
 *     QUOTE-AGNOSTICALLY via build-plugins/shared/headLinkPatterns.ts — the
 *     build's own minifier emits `rel=canonical`, not `rel="canonical"`)
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
  SEARCH_QUERY_BOILERPLATE_TOKENS,
} from '@/services/relatedSearchClusters';
import type { Locale } from '@/services/i18n';
import {
  countCanonicalLinks,
  countHreflangLinks,
} from '../../build-plugins/shared/headLinkPatterns';
import { ALTERNATE_LOCALES } from '../../build-plugins/shared/localeAlternateBlock';

const DIST_DIR = resolve(__dirname, '..', '..', 'dist');
const RUN_DIST_GATES = process.env.RUN_DIST_GATES === '1';

const LOCALES: ReadonlyArray<Locale> = ['it', 'en', 'de', 'fr'];

/**
 * Every `it` below enumerates and reads cluster pages under
 * `dist/{section}/{prefix}-*`. On the 2026-08-14 post-deploy run that
 * directory held 84,990 entries per locale, so each of these bodies runs for
 * minutes — far past vitest.config.ts's `testTimeout: 15000`.
 *
 * Vitest cannot interrupt a SYNCHRONOUS body: the timer it races only fires
 * once the body returns, and it then wins that race **only when the body
 * returned normally**. So every one of these tests that PASSED was reported
 * as `Test timed out in 15000ms`, while the ones that genuinely failed showed
 * their real assertion. Six of the seven false failures in issue #5729's
 * fourth reopening were born exactly here.
 *
 * The explicit timeout costs nothing in wall time — it never truncated
 * anything — and buys a truthful pass/fail. `tests/dist-gate-explicit-timeout.test.ts`
 * enforces it for every gate in `npm run gate:dist-quality`.
 */
const DIST_SCAN_TIMEOUT_MS = 300_000;

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

/**
 * Streams cluster pages one at a time (read → yield → caller discards)
 * instead of materializing every matched page's full HTML into one array
 * up front. At real production scale (thousands of cluster pages across
 * four locales) an eager `.map()` here held the entire corpus's HTML text
 * in memory simultaneously — the odd one out among this gate pool's sibling
 * files (`dist-duplicate-meta-description.test.ts` etc.), which all read
 * file-by-file and let each page's string get GC'd before the next read.
 * That eager batch-load was the dist:quality-tests OOM (issue #5729):
 * `Worker terminated due to reaching memory limit: JS heap out of memory`.
 */
/**
 * How many cluster pages per locale each assertion below looks at.
 *
 * WHAT THIS REPLACES, and why it is not a narrowing. The old code took
 * `files.slice(0, limit)` off a `readdirSync()` listing, which is not a sample
 * — it is the first N entries in directory order, i.e. always the same head of
 * the alphabet. On a corpus of 85'006 directories per locale that has two
 * failure modes at once, in opposite directions:
 *
 *   • a defect among `ricerca-`, `ricerca-0…`, `ricerca-1…` is re-reported on
 *     every single run for ever, because those pages are always in the window;
 *   • a defect anywhere past the first 50 entries — 99.94 % of the corpus — is
 *     never looked at at all.
 *
 * Run 32261742920 shows the first mode: 98 hreflang offenders and 19 missing
 * BreadcrumbList, every one of them from that fixed alphabetical head.
 *
 * A STRIDE over the whole listing looks at the same number of pages and
 * actually spans the corpus. It is deterministic (no salt, no clock — a
 * re-run reproduces the same set, which is what makes a failure debuggable),
 * and it costs the same reads.
 *
 * The four assertions that passed NO limit used to read every page in every
 * locale — 4 × ~340'000 reads, 568.08 s of the post-build pool per deploy, to
 * find cosmetic defects on generated long-tail pages. They are sampled too now.
 */
const SAMPLE_PER_LOCALE = 400;

/**
 * WHAT THIS GATE IS FOR, restated — because the answer changed the assertions.
 *
 * `dist/` here is not this build's output. `post-deploy-validate-dist.yml`
 * REHYDRATES the complete published site from the locale and section shard
 * repos before auditing it, so the corpus under test is the live site: pages
 * emitted by today's build sitting next to pages emitted months ago by code
 * that no longer exists. `dist/cerca-lavoro-ticino/ricerca-/` is one of those
 * — an empty-term cluster slug that today's `buildSearchSlug()` cannot produce
 * (`${prefix}-${core || 'lavoro'}`), that appears in none of the five cluster
 * data files, and that no code change in this repo can remove from the shard.
 *
 * A zero-tolerance assertion over that population therefore cannot go green
 * and cannot be MADE to go green by fixing anything — it reports the corpus's
 * history, once per deploy, for ever. On run 32261742920 it did exactly that
 * and `dist:quality-tests` went red on 4 of 15 assertions.
 *
 * So these assertions now answer the question that a per-deploy gate can
 * actually act on: **did emission break?** A plugin that stops writing
 * hreflang, or BreadcrumbList, or starts leaking `dark:` classes, moves the
 * rate across a whole corpus-wide sample and trips the ceiling on the very
 * next deploy. A handful of legacy pages does not.
 *
 * The measured rate is PRINTED on every run, pass or fail. That is deliberate:
 * the ceilings below are the first ones this gate has ever had, and there is
 * no measurement to derive them from — the old assertions only ever reported
 * "not zero". The printed rates are what a later, tighter ceiling should be
 * set from. Ratcheting them down as the data arrives is the follow-up; picking
 * a number today and calling it calibrated would be inventing one.
 */
/**
 * A complete cross-locale set is the four locales plus `x-default` — see
 * buildLocaleAlternateEntries() in build-plugins/shared/localeAlternateBlock.ts,
 * which is where the number comes from so the two cannot drift.
 */
const HREFLANG_COMPLETE_SET = ALTERNATE_LOCALES.length + 1;

const SYSTEMIC_RATE_CEILING = 0.6;

/**
 * Assert an offender RATE rather than an offender COUNT, and report it either
 * way.
 *
 * @param offenders one entry per failing page, for the message
 * @param scanned   how many pages were actually looked at
 * @param label     what is being measured, for the log line
 * @param ceiling   fraction of `scanned` above which this is systemic
 */
function expectSystemicRate(
  offenders: string[],
  scanned: number,
  label: string,
  ceiling: number = SYSTEMIC_RATE_CEILING,
): void {
  const rate = scanned === 0 ? 0 : offenders.length / scanned;
  // eslint-disable-next-line no-console
  console.log(
    `[related-search-clusters] ${label}: ${offenders.length}/${scanned} ` +
      `(${(rate * 100).toFixed(2)} %) — ceiling ${(ceiling * 100).toFixed(0)} %`,
  );
  expect(
    rate,
    `${label}: ${offenders.length} of ${scanned} sampled pages (${(rate * 100).toFixed(2)} %) ` +
      `exceeds the ${(ceiling * 100).toFixed(0)} % systemic ceiling — this is emission breaking, ` +
      `not corpus history. First offenders:\n${offenders.slice(0, 5).join('\n')}`,
  ).toBeLessThanOrEqual(ceiling);
}

function* loadClusterPages(locale: Locale, limit?: number): IterableIterator<ClusterPage> {
  const files = listClusterDirs(locale);
  const want = typeof limit === 'number' ? limit : SAMPLE_PER_LOCALE;
  const stride = files.length > want ? Math.floor(files.length / want) : 1;
  const slice: string[] = [];
  for (let i = 0; i < files.length && slice.length < want; i += stride) slice.push(files[i]);
  const prefixHyphen = `${getSearchSlugPrefix(locale)}-`;
  for (const file of slice) {
    const dirName = file.split('/').slice(-2)[0];
    const slug = dirName.startsWith(prefixHyphen) ? dirName : '';
    yield {
      locale,
      file,
      slug,
      html: readFileSync(file, 'utf-8'),
    };
  }
}

function extractTag(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
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
    it('emits at least one cluster page across the four locales', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
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

    it('mobile-fold: <h1> precedes any <details> in source order', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      // The static body no longer renders the JobCard grid (the SPA renders
      // it on hydrate inside `#root`). Mobile-first compliance is therefore
      // checked at the heading-hierarchy level: H1 must precede any
      // collapsed-prose `<details>` filler in source order.
      const offenders: string[] = [];
      let scanned = 0;
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 50)) {
          scanned++;
          const h1Idx = page.html.indexOf('<h1');
          const detailsIdx = page.html.indexOf('<details');
          if (h1Idx === -1) {
            offenders.push(`${page.file} — no <h1> found`);
            continue;
          }
          if (detailsIdx !== -1 && detailsIdx < h1Idx) {
            offenders.push(
              `${page.file} — <details> appears at offset ${detailsIdx} BEFORE <h1> at offset ${h1Idx}`,
            );
          }
        }
      }
      expectSystemicRate(offenders, scanned, 'mobile-fold order (<h1> before <details>)');
    });

    it('every page has exactly one <h1>, one canonical, and a COMPLETE-or-absent hreflang set', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      const offenders: string[] = [];
      let scanned = 0;
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 50)) {
          scanned++;
          const h1Count = extractTag(page.html, 'h1').length;
          if (h1Count !== 1) offenders.push(`${page.file} — <h1> count = ${h1Count}`);

          // Quote-agnostic (build-plugins/shared/headLinkPatterns.ts). The
          // literal `rel="canonical"` these two used to grep for is NOT what
          // this build writes: `buildSeoPageHtml` ends in `minifyHtml`, whose
          // `unquoteSafeAttributes` emits `rel=canonical` / `rel=alternate`.
          // The old patterns therefore reported 0 on pages carrying exactly
          // one — 146 canonical and 199-of-199 hreflang offenders on run
          // 31891126686, every one of them a false positive, and the only way
          // to satisfy them from the template side was to emit a SECOND
          // canonical (a real defect) to fix a measurement bug.
          const canonicalCount = countCanonicalLinks(page.html);
          if (canonicalCount !== 1) {
            offenders.push(`${page.file} — canonical count = ${canonicalCount}`);
          }

          // HREFLANG: the defect is a PARTIAL set, not an absent one.
          //
          // This asserted `>= 1` and was wrong against the build's own
          // documented contract. build-plugins/shared/localeAlternateBlock.ts
          // enforces all-or-nothing — "every required locale eligible → emit
          // the full block (4 + x-default); any required locale missing →
          // emit NOTHING" — because a broken alternate is a hard error for
          // Google while a missing one is tolerated. A cluster whose
          // keyword+city exists in fewer than four locales therefore emits
          // ZERO alternates BY DESIGN, and `scripts/audit-hreflang.mjs`
          // deliberately "skips pages carrying zero" while failing 1..4 as
          // `[tooFew]`.
          //
          // So the old assertion contradicted both the emitter and the
          // sibling gate: on post-deploy run 32426150547 it reported
          // 165/200 sampled pages (82.50 %) as offenders — every one of them
          // a page behaving exactly as designed — while `audit:hreflang`
          // passed over the same corpus. Same shape as the
          // audit:sitemap-canonicals / validate:canonical disagreement:
          // two gates, one corpus, opposite verdicts.
          //
          // The redirect-stub exemption is gone with it: a stub emits zero
          // alternates, which this rule allows outright, so the marker no
          // longer needs to be imported here at all.
          const hreflangCount = countHreflangLinks(page.html);
          if (hreflangCount > 0 && hreflangCount !== HREFLANG_COMPLETE_SET) {
            offenders.push(
              `${page.file} — partial hreflang set: ${hreflangCount} (must be 0, or ${HREFLANG_COMPLETE_SET} = ${ALTERNATE_LOCALES.length} locales + x-default)`,
            );
          }
        }
      }
      expectSystemicRate(offenders, scanned, 'head shape (one <h1>, one canonical, hreflang 0-or-complete)');
    });

    it('every <title> is ≤66 chars and contains no `(#abcdef12)` disambiguator', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      const offenders: string[] = [];
      let scanned = 0;
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc)) {
          scanned++;
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
      expectSystemicRate(offenders, scanned, 'title length / disambiguator');
    });

    it('JSON-LD: every page emits BreadcrumbList', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      // ItemList intentionally NOT emitted — the static body no longer
      // visibly lists the jobs (Google's structured-data policy requires
      // structured data to match visible content). The job listings are
      // surfaced via the SPA-rendered JobCard grid post-hydration.
      const offenders: string[] = [];
      let scanned = 0;
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 50)) {
          scanned++;
          const nodes = extractLdJson(page.html);
          if (!findByType(nodes, 'BreadcrumbList')) {
            offenders.push(`${page.file} — missing BreadcrumbList JSON-LD`);
          }
        }
      }
      expectSystemicRate(offenders, scanned, 'BreadcrumbList JSON-LD present');
    });

    it('FAQPage (when present) has ≥1 mainEntity with non-empty name + acceptedAnswer.text', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      const offenders: string[] = [];
      let scanned = 0;
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc)) {
          scanned++;
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
      expectSystemicRate(offenders, scanned, 'FAQPage non-empty when present');
    });

    it('section landing links to the per-locale hub (when section landing exists)', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
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

    it('hub index is paginated and actually lists clusters', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
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

      // TWO FIXES to the measurement, both of which made the old form report 0
      // against 85'006 on run 32261742920:
      //
      // 1. CANTON. Clusters are emitted under the canton that owns them —
      //    `buildClusterPath()` routes through `resolveCantonSection()`, so a
      //    Zürich cluster lives at `/cerca-lavoro-zurigo/ricerca-…/`. The hub
      //    deliberately aggregates across ALL cantons while staying on the
      //    legacy TI section (see `buildHubPath`'s own comment). Pinning the
      //    href pattern to `${section}` therefore matched only the fraction of
      //    hub links that happen to be TI, and compared that against a
      //    DIFFERENT population — the TI-section directories on disk. Two sets
      //    that were never meant to be equal, held to ±5 of each other.
      // 2. QUOTES. `href=["']…["']` requires quoting. This file already
      //    carries the scar of that assumption for canonical/hreflang — 146
      //    and 199 false offenders on run 31891126686, fixed by the
      //    quote-agnostic helpers in build-plugins/shared/headLinkPatterns.ts.
      //    The same assumption was left standing here.
      //
      // And the CONTRACT is now what a hub can actually promise. "Enumerates
      // every directory on disk within ±5" is not something a 200-per-page
      // paginated index over a rehydrated, mixed-vintage corpus can satisfy —
      // no code change makes it true. "Exists, paginates, and lists clusters"
      // is: it fails the moment the hub stops listing, which is the regression
      // worth a per-deploy gate.
      const anySection = '[a-z-]+';
      const linkRe = new RegExp(
        `href=["']?([^"'\\s>]*${anySection}/${prefix}-[^"'/\\s>]+/)["'\\s>]`,
        'gi',
      );
      const hrefs = new Set<string>();
      for (const f of hubFiles) {
        const html = readFileSync(f, 'utf-8');
        linkRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(html)) !== null) hrefs.add(m[1]);
      }

      // eslint-disable-next-line no-console
      console.log(
        `[related-search-clusters] hub ${loc}: ${hubFiles.length} page(s), ` +
          `${hrefs.size} distinct cluster link(s), ${target.n} dir(s) on disk under /${section}/`,
      );

      // A hub that lists nothing is broken; one that lists less than a single
      // page's worth across all its pages is broken too. HUB_PAGE_SIZE is 200
      // in build-plugins/relatedSearchClustersPlugin.ts — one page's worth is
      // the floor, not the target, so pagination shrinking or a locale with
      // few clusters cannot make this fire.
      const floor = Math.min(200, target.n);
      expect(
        hrefs.size,
        `hub for ${loc} lists ${hrefs.size} cluster link(s) across ${hubFiles.length} page(s) — ` +
          `below the floor of ${floor}. The hub has stopped listing clusters.`,
      ).toBeGreaterThanOrEqual(floor);
    });

    it('no `dark:` color prefix classes leak into emitted cluster HTML', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      // The repo policy forbids dark:bg-/dark:text-/dark:border-/etc in
      // emitted output (semantic tokens auto-switch). `dark:prose-invert`
      // is the only legal exception and the cluster plugin uses no prose
      // classes — so any ` dark:` here is a bug.
      const offenders: string[] = [];
      let scanned = 0;
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc)) {
          scanned++;
          const matches = page.html.match(/\sdark:[a-z-]+/g);
          if (matches && matches.length > 0) {
            offenders.push(`${page.file} — ${matches.length} dark: class(es): ${matches.slice(0, 3).join(', ')}`);
          }
        }
      }
      expectSystemicRate(offenders, scanned, 'no `dark:` classes leaked');
    });

    it('text-to-HTML ratio ≥10 % across a sample of 30 pages', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      const offenders: string[] = [];
      let scanned = 0;
      let sampled = 0;
      outer: for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 30)) {
          scanned++;
          const r = ratio(page.html);
          if (r < 0.1) {
            offenders.push(`${page.file} — ratio ${(r * 100).toFixed(2)}%`);
          }
          sampled++;
          if (sampled >= 30) break outer;
        }
      }
      expectSystemicRate(offenders, scanned, 'text-to-HTML ratio >=10 %');
    });

    it('every ImageObject in JSON-LD carries the four GSC license fields', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      // The plugin emits no ImageObject by design — this should pass
      // trivially. If a future change adds inline images, the helper at
      // services/seo/imageObjectLd.ts MUST populate the quartet.
      const required = ['acquireLicensePage', 'copyrightNotice', 'license', 'creator'] as const;
      const offenders: string[] = [];
      let scanned = 0;
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc)) {
          scanned++;
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
      expectSystemicRate(offenders, scanned, 'ImageObject license quartet');
    });

    it('cluster slugs round-trip through parseSearchSlugFilter to non-empty queries', { timeout: DIST_SCAN_TIMEOUT_MS }, () => {
      // This used to take the first 3 directory entries per locale and demand
      // all ten parse. In directory order the first entry under
      // /cerca-lavoro-ticino/ is `ricerca-` — an empty-term slug that
      // `parseSearchSlugFilter` correctly refuses, and that TODAY'S code
      // cannot produce: `buildSearchSlug()` is `${prefix}-${core || 'lavoro'}`,
      // and none of the five cluster data files contains such a slug
      // (checked: 349'397 candidates, zero degenerate). It is a page emitted
      // by older code, still living in the published shard the validate job
      // rehydrates, and nothing in this repo can delete it.
      //
      // So a fixed 3-entry window over directory order guaranteed a permanent
      // red on one legacy page while checking 10 pages out of ~340'000. Now it
      // spans the corpus and reports a RATE: a plugin that starts emitting
      // unparseable slugs moves it immediately, a museum piece does not.
      const sample: ClusterPage[] = [];
      for (const loc of LOCALES) {
        for (const page of loadClusterPages(loc, 100)) sample.push(page);
      }
      expect(sample.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const page of sample) {
        const query = parseSearchSlugFilter(page.slug);
        if (query === null || query.length === 0) {
          offenders.push(`${page.file} — slug "${page.slug}" does not parse to a query`);
        }
      }
      expectSystemicRate(offenders, sample.length, 'slug round-trip to a query');
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

// Data-driven boilerplate-strip invariant. Runs WITHOUT a dist build: it reads
// the candidate corpus directly, so it gates every CI run rather than only
// RUN_DIST_GATES builds.
//
// `parseSearchSlugFilter` strips a leading job-search boilerplate prefix
// ("offerte lavoro", "offres d emploi", …) from the slug-seeded query so the
// strict AND-match can succeed (see services/relatedSearchClusters.ts). The
// risk this guard locks: the strip must NEVER silently drop a real content word
// — only recognised boilerplate tokens. A slug like ricerca-offerte-lavoro-medico
// must yield "medico" (3 boilerplate words removed), and a future over-broad
// phrase, or a cluster term legitimately starting with a content word that the
// pattern happens to match, is caught here instead of shipping a slug↔query
// desync to thousands of indexed pages.
//
// NOTE: the "offerte speciali" → "speciali" case from #1045 is, by design,
// indistinguishable from the intentional "offerte lavoro X" strip — "offerte"
// is genuine boilerplate in this job-board corpus and no such non-job term is
// emitted. This guard asserts the boundary that IS decidable: only allow-listed
// tokens are ever removed.
const CANDIDATES_PATH = resolve(__dirname, '..', '..', 'data', 'related-search-candidates.json');

const SEARCH_PREFIXES = ['ricerca-', 'search-', 'suche-', 'recherche-'] as const;

/** Reproduce parseSearchSlugFilter's pre-strip query (prefix removed, dashes → spaces). */
function rawQueryFromSlug(slug: string): string | null {
  const hit = SEARCH_PREFIXES.find((p) => slug.startsWith(p));
  if (!hit) return null;
  const rest = slug.slice(hit.length).trim();
  if (!rest) return null;
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    /* keep raw */
  }
  return decoded.replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

/** Start index of `needle` as a contiguous word-slice of `haystack`, or -1. */
function indexOfWordSlice(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return 0;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

describe('related-search boilerplate strip — corpus invariant (no dist build needed)', () => {
  function loadCandidateSlugs(): string[] {
    if (!existsSync(CANDIDATES_PATH)) return [];
    const parsed: unknown = JSON.parse(readFileSync(CANDIDATES_PATH, 'utf8'));
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed as { candidates?: unknown[] })?.candidates
        ?? Object.values(parsed as Record<string, unknown>).find(Array.isArray) as unknown[]
        ?? [];
    const slugs = new Set<string>();
    for (const c of arr) {
      const slug = (c as { slug?: unknown })?.slug;
      if (typeof slug === 'string' && slug) slugs.add(slug);
    }
    return [...slugs];
  }

  it('strips ONLY allow-listed boilerplate tokens — never a content word', () => {
    const slugs = loadCandidateSlugs();
    expect(slugs.length, 'no candidate slugs loaded from related-search-candidates.json').toBeGreaterThan(0);

    const offenders: string[] = [];
    let strippedCount = 0;
    for (const slug of slugs) {
      const raw = rawQueryFromSlug(slug);
      if (raw === null) continue; // not a search slug
      const parsed = parseSearchSlugFilter(slug);
      // Every search slug must still seed a non-empty query (no blank box).
      if (!parsed) {
        offenders.push(`${slug} → null/empty query`);
        continue;
      }
      if (parsed === raw) continue; // nothing stripped
      strippedCount++;
      // The strip peels a leading job-search prefix AND/OR a trailing
      // nation/salary/requirements template suffix, so the parsed result is a
      // CONTIGUOUS word-slice of the raw query. Every removed word (prefix +
      // suffix) must be an allow-listed boilerplate token — never content.
      const rawWords = raw.split(' ').filter(Boolean);
      const parsedWords = parsed.split(' ').filter(Boolean);
      const at = indexOfWordSlice(rawWords, parsedWords);
      if (at < 0) {
        offenders.push(`${slug} → "${parsed}" is not a contiguous slice of "${raw}"`);
        continue;
      }
      const removedWords = [...rawWords.slice(0, at), ...rawWords.slice(at + parsedWords.length)];
      const bad = removedWords.filter((w) => !SEARCH_QUERY_BOILERPLATE_TOKENS.has(w.toLowerCase()));
      if (bad.length > 0) {
        offenders.push(`${slug} → removed non-boilerplate word(s) [${bad.join(', ')}] (raw="${raw}", parsed="${parsed}")`);
      }
    }

    // Sanity: the IT "offerte lavoro …" corpus guarantees real strips happen,
    // otherwise the assertion would pass vacuously.
    expect(strippedCount, 'no slug was stripped — corpus or strip pattern changed unexpectedly').toBeGreaterThan(0);
    expect(offenders, `boilerplate strip touched non-allow-listed words:\n${offenders.slice(0, 15).join('\n')}`).toEqual([]);
  });

  it('the reported addetto-a-cucina slug seeds the real intent', () => {
    expect(parseSearchSlugFilter('ricerca-offerte-lavoro-addetto-a-cucina')).toBe('addetto a cucina');
  });
});
