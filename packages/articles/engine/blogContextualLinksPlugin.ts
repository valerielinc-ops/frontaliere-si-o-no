/**
 * Blog → Feature contextual internal linking (A6).
 *
 * After {@link ogPagesPlugin} and the other SEO HTML generators have written
 * the ~800 blog article pages into `dist/`, this plugin walks every article
 * HTML file in each locale directory and injects 1-2 contextual links to the
 * new feature hubs (fuel daily, LAMal premiums, job market snapshot, weekly
 * employers, recency/geo hubs).
 *
 * Key properties:
 *   - Idempotent: running the build twice never accumulates duplicate links.
 *     An article is skipped for a given target if its HTML already contains
 *     `href="<targetUrl>"` (exact match — we only ever write exact-path hrefs).
 *   - Safe text-node replacement: we never mutate text inside <a>, <code>,
 *     <pre>, <script>, <style>, or <h1>–<h6> tags. Markup, image dimensions,
 *     aria-labels, and existing links are preserved verbatim.
 *   - Capped injection: max `SiteShellContract.contextualLinksMaxPerArticle`
 *     links per article and at most 1 link per target URL per article.
 *   - Priority-based tie-breaking when multiple rules match overlapping text.
 *
 * The plugin is transparent to article source files — it only rewrites the
 * generated `dist/` HTML. Blog body sources under `services/locales/blog-body/`
 * are never modified.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';

import {
  getSiteShell,
  type ArticleContextualLinkRule as BlogContextualLinkRule,
  type ArticleLocale as BlogLinkLocale,
} from './siteShell';

// ── Locale → dist blog-index directory mapping ────────────────────
//
// Blog index slug per locale and its Switzerland-wide ("svizzera") mirror
// both come from the site's SLUG_TABLES, injected via SiteShellContract
// (`blogIndexSlugs` / `swissBlogIndexSlugs` — see `build-plugins/
// articlesSiteShellBootstrap.ts`). Read lazily (call-time, not module-eval
// time) via the two helpers below so this module never calls
// `getSiteShell()` before the bootstrap side effect has run.

function defaultBlogIndexSlug(): Record<BlogLinkLocale, string> {
  return { ...getSiteShell().blogIndexSlugs };
}

function svizzeraBlogIndexSlug(): Record<BlogLinkLocale, string> {
  return { ...getSiteShell().swissBlogIndexSlugs };
}

import {
  injectContextualLinksWith,
  countBodyWords,
  type ContextualLinkDefaults,
  type InjectionResult,
  type SkipReason,
  type InjectedLink,
} from './shared/contextualLinkInjector';

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function pathExists(pathname: string): boolean {
  try {
    fs.statSync(pathname);
    return true;
  } catch (err) {
    if (isMissingPathError(err)) return false;
    throw err;
  }
}

export { countBodyWords };
export type { ContextualLinkDefaults, InjectionResult, SkipReason, InjectedLink };

// ── Pure transform, re-exported ───────────────────────────────────
//
// The injector itself lives in ./shared/contextualLinkInjector.ts with no runtime
// imports, so the post-walk worker can load it under plain Node ESM (#4959 §4).
// This wrapper keeps the original call signature for the in-process callers and
// the unit tests: it resolves the shell here, where the bootstrap has already run.
export function injectContextualLinks(
  html: string,
  locale: BlogLinkLocale,
  opts?: { maxLinks?: number; rules?: readonly BlogContextualLinkRule[] },
): InjectionResult {
  return injectContextualLinksWith(html, locale, contextualLinkDefaults(), opts);
}

/** Shell slice for the injector. Also what the coordinator ships to the worker. */
export function contextualLinkDefaults(): ContextualLinkDefaults {
  const shell = getSiteShell();
  return {
    maxLinksPerArticle: shell.contextualLinksMaxPerArticle,
    rulesByLocale: shell.contextualLinkRules,
    defaultMinWords: shell.contextualLinksDefaultMinWords,
  };
}

// ── Filesystem walkers ────────────────────────────────────────────

// `rootDir` param kept for call-site compat — values now come straight from
// the injected SiteShellContract's `blogIndexSlugs` (shared SLUG_TABLES),
// no more router.ts source parse.
export function readBlogIndexSlugs(_rootDir: string): Record<BlogLinkLocale, string> {
  return defaultBlogIndexSlug();
}

export interface BlogArticleHtmlFile {
  readonly locale: BlogLinkLocale;
  readonly absPath: string;
  readonly articleSlug: string;
}

/**
 * Enumerate every blog article HTML path in `dist/`. For each locale we pick
 * up both `.../<slug>/index.html` (directory form) and `.../<slug>.html`
 * (flat form), because `ogPagesPlugin` writes both.
 *
 * Both article sections are walked: the cross-border ("frontaliere") hub via
 * the passed `blogIndexSlugs` and the Switzerland-wide ("svizzera") hub via
 * {@link svizzeraBlogIndexSlug}. A missing/empty hub dir is simply skipped,
 * so an empty svizzera registry yields no extra files (no crash).
 */
export function listBlogArticleHtmlFiles(
  distDir: string,
  blogIndexSlugs: Record<BlogLinkLocale, string>,
): BlogArticleHtmlFile[] {
  const out: BlogArticleHtmlFile[] = [];
  for (const slugMap of [blogIndexSlugs, svizzeraBlogIndexSlug()]) {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const indexSlug = slugMap[locale];
      if (!indexSlug) continue;
      const localeRoot = locale === 'it'
        ? path.join(distDir, indexSlug)
        : path.join(distDir, locale, indexSlug);
      if (!pathExists(localeRoot)) continue;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(localeRoot, { withFileTypes: true });
      } catch (err) {
        if (isMissingPathError(err)) continue;
        throw err;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirSlug = entry.name;
          const indexHtml = path.join(localeRoot, dirSlug, 'index.html');
          if (pathExists(indexHtml)) {
            out.push({ locale, absPath: indexHtml, articleSlug: dirSlug });
          }
        } else if (entry.isFile() && entry.name.endsWith('.html') && entry.name !== 'index.html') {
          const articleSlug = entry.name.slice(0, -5);
          out.push({ locale, absPath: path.join(localeRoot, entry.name), articleSlug });
        }
      }
    }
  }
  return out;
}

// ── Vite plugin ───────────────────────────────────────────────────

/**
 * @deprecated Consumed internally by {@link postWalkCoordinatorPlugin}.
 * Kept exported for backward compatibility and unit-test access. Do NOT
 * register both this plugin AND the coordinator — they would duplicate work.
 */
export function blogContextualLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'blog-contextual-links',
    apply: 'build',
    // Run this plugin's closeBundle AFTER every other SEO writer. Combining
    // `enforce: 'post'` with `closeBundle.order: 'post'` + `sequential: true`
    // is the only reliable way to guarantee that ogPagesPlugin,
    // jobsSeoPagesPlugin, static-pages, and sitemap-alias have all flushed
    // their HTML before we read+rewrite the blog articles. Without this,
    // Vite interleaves closeBundle hooks and we race the og-pages writer.
    enforce: 'post',
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
      const distDir = path.resolve(rootDir, 'dist');
      if (!pathExists(distDir)) {
        console.warn('[blog-contextual-links] dist/ missing — skipping');
        return;
      }

      const blogIndexSlugs = readBlogIndexSlugs(rootDir);
      const files = listBlogArticleHtmlFiles(distDir, blogIndexSlugs);

      if (files.length === 0) {
        console.warn('[blog-contextual-links] no blog HTML files found in dist/ — skipping');
        return;
      }

      const perTargetCounts = new Map<string, number>();
      const perLocaleCounts = new Map<BlogLinkLocale, number>();
      let articlesModified = 0;
      let linksInjected = 0;
      const skippedTooShort = new Set<string>();
      const skippedNoMatch = new Set<string>();

      // Deduplicate work across the dir+flat pair: inject once on the dir form,
      // then write the same HTML to the flat form so both stay consistent.
      const byLocaleSlug = new Map<string, BlogArticleHtmlFile[]>();
      for (const f of files) {
        const key = `${f.locale}|${f.articleSlug}`;
        const arr = byLocaleSlug.get(key) ?? [];
        arr.push(f);
        byLocaleSlug.set(key, arr);
      }

      for (const [key, variants] of byLocaleSlug) {
        // Sort variants so the directory form (with trailing `index.html`)
        // drives injection; this form is the one search engines see.
        const preferred = variants.find((v) => v.absPath.endsWith(path.sep + 'index.html')) ?? variants[0];
        let html: string;
        try {
          html = fs.readFileSync(preferred.absPath, 'utf-8');
        } catch (err) {
          if (isMissingPathError(err)) continue;
          throw err;
        }

        const locale = preferred.locale;
        const before = html;
        const result = injectContextualLinks(html, locale);

        if (result.skipped === 'tooShort') skippedTooShort.add(key);
        else if (result.skipped === 'noMatch') skippedNoMatch.add(key);

        if (result.injected.length === 0 || result.html === before) {
          continue;
        }

        articlesModified++;
        linksInjected += result.injected.length;
        for (const ij of result.injected) {
          perTargetCounts.set(ij.targetUrl, (perTargetCounts.get(ij.targetUrl) ?? 0) + 1);
          perLocaleCounts.set(locale, (perLocaleCounts.get(locale) ?? 0) + 1);
        }

        // Persist only to the directory form. The flat .html sibling is a
        // redirect bridge emitted by flatHtmlRedirectPlugin and must stay
        // untouched, otherwise Semrush sees both URL forms serving identical
        // content with non-self-referencing hreflang/canonical.
        try {
          fs.writeFileSync(preferred.absPath, result.html, 'utf-8');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[blog-contextual-links] failed to write ${preferred.absPath}: ${msg}`);
          throw err;
        }
      }

      const targetBreakdown = [...perTargetCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([url, n]) => `  ${n.toString().padStart(4, ' ')}  ${url}`)
        .join('\n');
      const localeBreakdown = [...perLocaleCounts.entries()]
        .map(([loc, n]) => `${loc}=${n}`)
        .join(' ');

      console.log(
        `\x1b[36m[blog-contextual-links]\x1b[0m articles modified: ${articlesModified}/${byLocaleSlug.size} — links injected: ${linksInjected} (${localeBreakdown})\n${targetBreakdown}`,
      );
      },
    },
  };
}
