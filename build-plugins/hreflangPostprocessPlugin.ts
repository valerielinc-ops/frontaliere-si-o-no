/**
 * Hreflang Post-Process Plugin
 *
 * Phase 2 of the SEO zero-issues sweep (2026-04-26).
 *
 * What it does
 * ------------
 * After every other build plugin has finished emitting HTML, walk every
 * `*.html` in `dist/` and strip `<link rel="alternate" hreflang="...">`
 * tags whose target file does not exist in the same `dist/`. This closes
 * Semrush issues:
 *
 *   - Issue 8 (E1) — 1.463 broken internal links (90% hreflang-driven).
 *   - Issue 25 (E8) — 6 wrong hreflang URLs.
 *
 * Why post-process instead of patching every emitter
 * --------------------------------------------------
 * 30+ build plugins emit hreflang. Patching each one risks divergence and
 * regressions; a single post-process pass is universal, idempotent, and
 * easy to test. It also runs AFTER `flatHtmlRedirectPlugin` so we can be
 * sure the final state of every HTML file matches what GitHub Pages will
 * actually serve.
 *
 * Run order
 * ---------
 * `enforce: 'post'` + `closeBundle.order: 'post'` + `sequential: true`.
 * Must run AFTER flatHtmlRedirectPlugin, which itself runs last among
 * post-phase plugins. We rely on Vite's stable plugin ordering: this
 * plugin is registered AFTER flatHtmlRedirectPlugin in vite.config.ts, so
 * within the post-phase queue ours is the last to execute.
 *
 * Flat redirect bridges (the tiny 9-line files emitted by
 * flatHtmlRedirectPlugin) contain no hreflang tags, so the regex matches
 * nothing and they are left untouched.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { filterExistingAlternates, type LocaleAlternates } from './shared/hreflangGuard.ts';

interface HreflangPostprocessOptions {
  readonly baseUrl: string;
}

/**
 * Match a single `<link rel="alternate" hreflang="..." href="...">` tag.
 *
 * - Accepts either ordering of `rel` / `hreflang` / `href` attributes (Vite/
 *   Rollup does not reorder, but emitters across the codebase use both
 *   orders).
 * - Tolerates self-closing (`/>`) and HTML5 (`>`) variants.
 * - Captures the locale (group 1) and the href (group 2).
 *
 * NOTE: we keep the regex deliberately strict (no `\s*` between attrs other
 * than the canonical single-space form used by every emitter) to avoid
 * false-positives in inline `<script>`/`<style>` content.
 */
const HREFLANG_LINK_RX =
  /<link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s*\/?>(?:\s*\n?)?/g;

/**
 * Stable iteration of every `.html` file under `dist/`, skipping the
 * static-asset directories (no HTML inside).
 */
function* walkHtml(dir: string): Iterable<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
      yield* walkHtml(p);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      yield p;
    }
  }
}

/**
 * Pure transform: strip `<link rel="alternate" hreflang>` tags whose target
 * file does not pass the supplied existence predicate. Returns `null` if the
 * HTML has no hreflang tags or all tags survive (no rewrite needed).
 *
 * Extracted from the plugin's closeBundle handler so the
 * `postWalkCoordinatorPlugin` can apply it during a single shared dist/ walk.
 *
 * Inputs:
 *   - html: current HTML string (already potentially mutated by prior steps)
 *   - distDir / baseUrl: passed through to `filterExistingAlternates`
 *   - existsCheck (optional): override the disk lookup. Useful when the
 *     coordinator has built an in-memory Set of every emitted HTML path so
 *     the walk avoids repeated `fs.existsSync` syscalls.
 */
export interface HreflangTransformResult {
  readonly html: string;
  readonly kept: number;
  readonly dropped: number;
}

export function transformHreflang(
  html: string,
  distDir: string,
  baseUrl: string,
  existsCheck?: (absPath: string) => boolean,
): HreflangTransformResult | null {
  if (!html.includes('hreflang=')) return null;

  const matches: Array<{
    full: string;
    entry: LocaleAlternates;
    index: number;
  }> = [];
  HREFLANG_LINK_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HREFLANG_LINK_RX.exec(html)) !== null) {
    matches.push({
      full: m[0],
      entry: { locale: m[1], url: m[2] },
      index: m.index,
    });
  }
  if (matches.length === 0) return null;

  const alternates: readonly LocaleAlternates[] = matches.map((x) => x.entry);
  const kept = existsCheck
    ? filterExistingAlternatesWith(alternates, distDir, baseUrl, existsCheck)
    : filterExistingAlternates(alternates, distDir, baseUrl);
  const keptUrls = new Set(kept.map((k) => `${k.locale}|${k.url}`));

  if (kept.length === alternates.length) {
    // Nothing to drop — return null so the coordinator skips a write.
    return null;
  }

  // audit-hreflang threshold: a page must emit either ZERO hreflang OR
  // ≥5 entries (4 locales + x-default). Stripping a single broken
  // alternate (e.g. DE alt for a job whose DE-slug got deduped to a
  // different canton's file) would leave 4 entries and trip the audit.
  // When the post-strip count would fall below the threshold, drop ALL
  // hreflang tags so the audit's `alternates.size === 0` branch skips.
  // Trade-off: we lose the per-locale link-equity signal on these
  // (typically bridge / dedup-collateral) pages, but they keep
  // <link rel="canonical"> + <html lang> so Google can still scope the
  // page to a single locale.
  const MIN_HREFLANG_ENTRIES = 5;
  const dropAll = kept.length > 0 && kept.length < MIN_HREFLANG_ENTRIES;
  const finalKeptUrls = dropAll ? new Set<string>() : keptUrls;

  let rewritten = html;
  let droppedCount = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const key = `${match.entry.locale}|${match.entry.url}`;
    if (finalKeptUrls.has(key)) continue;
    droppedCount++;
    const end = match.index + match.full.length;
    const tail = rewritten.slice(end);
    const trailingNl = tail.startsWith('\n') ? 1 : 0;
    rewritten =
      rewritten.slice(0, match.index) +
      rewritten.slice(end + trailingNl);
  }

  return { html: rewritten, kept: finalKeptUrls.size, dropped: droppedCount };
}

/**
 * Variant of {@link filterExistingAlternates} that accepts a custom existence
 * predicate. Used by the coordinator to substitute disk lookups with an
 * in-memory Set of every HTML path emitted during the build.
 */
function filterExistingAlternatesWith(
  alternates: readonly LocaleAlternates[],
  distDir: string,
  baseUrl: string,
  existsCheck: (absPath: string) => boolean,
): readonly LocaleAlternates[] {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return alternates.filter(({ url }) => {
    let p = url;
    if (p.startsWith(trimmedBase)) p = p.slice(trimmedBase.length);
    const q = p.indexOf('?');
    if (q !== -1) p = p.slice(0, q);
    const h = p.indexOf('#');
    if (h !== -1) p = p.slice(0, h);
    p = p.replace(/\/+$/, '');
    if (p === '' || p === '/') {
      return existsCheck(path.join(distDir, 'index.html'));
    }
    if (p.startsWith('/')) p = p.slice(1);
    return (
      existsCheck(path.join(distDir, p, 'index.html')) ||
      existsCheck(path.join(distDir, `${p}.html`))
    );
  });
}

/**
 * @deprecated Consumed internally by {@link postWalkCoordinatorPlugin}.
 * Kept exported for backward compatibility. Do NOT register both this plugin
 * AND the coordinator — they would duplicate work.
 */
export function hreflangPostprocessPlugin(
  rootDir: string,
  opts: HreflangPostprocessOptions,
): Plugin {
  const { baseUrl } = opts;

  return {
    name: 'hreflang-postprocess',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      order: 'post',
      sequential: true,
      handler: async () => {
        const distDir = path.resolve(rootDir, 'dist');
        if (!fs.existsSync(distDir)) return;

        let filesScanned = 0;
        let filesRewritten = 0;
        let linksKept = 0;
        let linksDropped = 0;

        for (const file of walkHtml(distDir)) {
          filesScanned++;
          const html = fs.readFileSync(file, 'utf-8');
          if (!html.includes('hreflang=')) continue;

          // Collect all hreflang tags + their full match offsets so we can
          // do a single in-place rewrite that preserves whitespace exactly.
          const matches: Array<{
            full: string;
            entry: LocaleAlternates;
            index: number;
          }> = [];
          HREFLANG_LINK_RX.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = HREFLANG_LINK_RX.exec(html)) !== null) {
            matches.push({
              full: m[0],
              entry: { locale: m[1], url: m[2] },
              index: m.index,
            });
          }
          if (matches.length === 0) continue;

          // x-default points at the IT URL. We treat it as a separate
          // pseudo-locale so the guard checks its target independently.
          const alternates: readonly LocaleAlternates[] = matches.map((x) => x.entry);
          const kept = filterExistingAlternates(alternates, distDir, baseUrl);
          const keptUrls = new Set(kept.map((k) => `${k.locale}|${k.url}`));

          if (kept.length === alternates.length) {
            linksKept += alternates.length;
            continue; // nothing to drop
          }

          // See `transformHreflang`: a page with non-empty hreflang must
          // emit ≥5 entries. If stripping would push below the threshold,
          // drop every hreflang tag (audit treats size===0 as a pass).
          const MIN_HREFLANG_ENTRIES = 5;
          const dropAll = kept.length > 0 && kept.length < MIN_HREFLANG_ENTRIES;
          const finalKeptUrls = dropAll ? new Set<string>() : keptUrls;

          // Rewrite: walk matches in REVERSE order, splice out the broken
          // tags by index. Reverse order keeps earlier indexes stable.
          let rewritten = html;
          for (let i = matches.length - 1; i >= 0; i--) {
            const match = matches[i];
            const key = `${match.entry.locale}|${match.entry.url}`;
            if (finalKeptUrls.has(key)) {
              linksKept++;
              continue;
            }
            linksDropped++;
            // Remove the tag and any single trailing newline that belongs
            // to it (avoids leaving blank-line gaps in <head>).
            const end = match.index + match.full.length;
            const tail = rewritten.slice(end);
            const trailingNl = tail.startsWith('\n') ? 1 : 0;
            rewritten =
              rewritten.slice(0, match.index) +
              rewritten.slice(end + trailingNl);
          }

          fs.writeFileSync(file, rewritten);
          filesRewritten++;
        }

        // Single concise log line — matches the project's convention
        // (cyan tag, counters in the body).
        // eslint-disable-next-line no-console
        console.log(
          `\x1b[36m[hreflang-postprocess]\x1b[0m Scanned ${filesScanned} files; ` +
            `kept ${linksKept} alternates, dropped ${linksDropped} broken across ${filesRewritten} files`,
        );
      },
    },
  };
}
