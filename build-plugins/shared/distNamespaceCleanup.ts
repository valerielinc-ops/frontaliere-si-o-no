/**
 * Shared dist/ namespace cleanup helper for SEO page plugins.
 *
 * Incremental Vite builds preserve dist/ between runs (see
 * prepareOutDirPlugin). This means a plugin that writes N files this build
 * but M files last build — where M > N — leaves `M - N` stale files on
 * disk. Stale files show up in sitemap alias discovery, breadcrumb coverage
 * tests, and post-build link validators. Worse, thin-content guards (that
 * skip emitting index.html for an existing directory) leave empty folders
 * containing only the previous run's output.
 *
 * Each plugin owns a set of top-level dist/ directories (e.g.
 * `dist/prezzi-diesel/`, `dist/aziende-che-assumono/`, etc.). Before
 * regenerating, the plugin calls {@link cleanNamespaces} with its owned
 * directories. This wipes the namespaces entirely and lets the plugin
 * write only the files that match the current data snapshot.
 *
 * Locale-prefixed variants (`dist/en/<slug>/`, `dist/de/<slug>/`,
 * `dist/fr/<slug>/`) are handled as separate namespace entries.
 *
 * Sitemap XML files (`dist/sitemap-*.xml`) are owned by the plugins that
 * emit them and are wiped with a separate glob-matching pass since they
 * live at the root of `dist/` (cannot rm the whole root).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Remove each namespace directory if it exists. Silently no-ops on missing
 * paths (the first build has nothing to clean). All paths MUST be absolute
 * or resolved against `distDir`.
 */
export function cleanNamespaces(distDir: string, namespaces: ReadonlyArray<string>): void {
  for (const ns of namespaces) {
    const full = path.isAbsolute(ns) ? ns : path.join(distDir, ns);
    // Safety: never rm outside distDir.
    const rel = path.relative(distDir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.warn(`[dist-cleanup] refusing to remove path outside dist/: ${full}`);
      continue;
    }
    if (!fs.existsSync(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch (err) {
      // Non-fatal: a stale file lock shouldn't abort the build. The plugin
      // will overwrite its own files anyway; the only cost is that files
      // from the *previous* run that the current run no longer emits may
      // remain until the next successful cleanup.
      console.warn(`[dist-cleanup] failed to remove ${full}`, err);
    }
  }
}

/**
 * Remove sitemap-*.xml files whose basename matches one of the supplied
 * names (e.g. ['sitemap-weekly-employers.xml']). Sitemap files live at
 * dist/ root so a directory-wide rm is unsafe — this helper removes the
 * individual files instead.
 */
export function cleanSitemapFiles(distDir: string, filenames: ReadonlyArray<string>): void {
  for (const name of filenames) {
    const full = path.join(distDir, name);
    if (!fs.existsSync(full)) continue;
    try {
      fs.rmSync(full, { force: true });
    } catch (err) {
      console.warn(`[dist-cleanup] failed to remove ${full}`, err);
    }
  }
}
