/**
 * cantonJobCompatBridgePlugin — recover non-Ticino job 404s at their exact path.
 *
 * The 404→compat→page pipeline has a Ticino blind spot. `jobsSeoPagesPlugin`
 * only merges the FOUR Ticino job-board sections from
 * `data/seo-404-compat-paths.json` into its soft-landing tracking (its
 * `COMPAT_JOB_PATTERNS` was hard-coded to TI), and `legacyRedirectsPlugin`
 * deliberately skips EVERY job-board path (it defers all of them to
 * jobsSeoPagesPlugin to avoid thin pages competing with enriched ones). The
 * result: every compat job path in any other canton (grigioni, vallese,
 * zurigo, soletta, …) falls through both plugins and 404s live, even though
 * Cloudflare edge analytics confirms real eyeball traffic keeps hitting them
 * (the CF producer `discover-404s-via-cloudflare.mjs` keeps re-adding them,
 * but nothing ever emits a page → an accumulating, never-recovered tail).
 *
 * This plugin closes that gap WITHOUT touching the OOM-sensitive
 * jobsSeoPagesPlugin: it walks the compat accumulator, keeps only NON-Ticino
 * per-canton job-board paths (Ticino + the nationwide `_AGGREGATE_` board are
 * owned by jobsSeoPagesPlugin), resolves each via the shared
 * `resolveSearchConsoleCompatTarget`, and emits a canonical bridge page at the
 * EXACT path the path was indexed/hit at (path-keyed, not slug-keyed — so the
 * historical TI-normalisation collisions don't hide the real-canton URL).
 *
 * Safety:
 *   - Runs `enforce: 'post'` + placed AFTER jobsSeoPagesPlugin and
 *     legacyRedirectsPlugin in vite.config, so the `fs.existsSync` guard below
 *     skips any path that already has an enriched soft-landing / active page.
 *     It therefore only ever FILLS gaps — it never overwrites richer content,
 *     which is exactly the invariant legacyRedirectsPlugin's job-path skip was
 *     protecting.
 *   - Reuses the shared resolver + `buildCanonicalBridgePage` (no duplicated
 *     funnel-critical construct). Non-resolving paths are skipped here and
 *     dropped from the accumulator by `prune-404-compat-paths.ts` upstream.
 *
 * Bridges are intentionally thin (canonical → live canton listing, noindex):
 * the goal is to turn a 404 into a 200 that consolidates the canonical and
 * keeps AdSense rendering. Upgrading these to fully enriched soft-landings
 * (title/description/FAQ from orphan-enriched-data) is a possible follow-up.
 */

import path from 'path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { BASE_URL, buildCanonicalBridgePage } from './constants';
import { resolveSearchConsoleCompatTarget } from './searchConsoleCompat';
import { resolveCantonSection, type CantonLocale } from './shared/cantonSection';
import cantonSlugFile from '../data/canton-url-slugs.json';

const LOCALE_URL_PREFIX: Record<CantonLocale, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };
const LOCALES: CantonLocale[] = ['it', 'en', 'de', 'fr'];

/**
 * Build the set of per-canton job-board path prefixes this plugin OWNS:
 * every canton section across all 4 locales EXCEPT Ticino (owned by
 * jobsSeoPagesPlugin's TI compat merge) and the nationwide `_AGGREGATE_`
 * board (owned by jobsSeoPagesPlugin too). Each entry ends in '/' so a
 * `startsWith` test cannot match a longer canton slug by accident.
 */
function buildNonTicinoJobPrefixes(): Set<string> {
  const codes = Object.keys((cantonSlugFile as { cantons: Record<string, unknown> }).cantons || {});
  const prefixes = new Set<string>();
  for (const loc of LOCALES) {
    for (const code of codes) {
      if (code === 'TI') continue;
      const section = resolveCantonSection(loc, code);
      prefixes.add(`${LOCALE_URL_PREFIX[loc]}/${section}/`);
    }
  }
  return prefixes;
}

/** A compat path is in scope when it sits under a non-TI canton section and
 *  the remainder is a single job slug segment (no nested city/company hub). */
function matchNonTicinoJobPath(rawPath: string, prefixes: Set<string>): boolean {
  const withSlash = rawPath.endsWith('/') ? rawPath : `${rawPath}/`;
  for (const prefix of prefixes) {
    if (!withSlash.startsWith(prefix)) continue;
    const rest = withSlash.slice(prefix.length).replace(/\/+$/, '');
    if (rest && !rest.includes('/')) return true;
    return false;
  }
  return false;
}

const withSlash = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

export function cantonJobCompatBridgePlugin(rootDir: string): Plugin {
  return {
    name: 'canton-job-compat-bridge',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const compatPathsPath = path.resolve(rootDir, 'data/seo-404-compat-paths.json');
      if (!fs.existsSync(compatPathsPath) || !fs.existsSync(distDir)) return;

      let compatPaths: string[] = [];
      try {
        const raw = JSON.parse(fs.readFileSync(compatPathsPath, 'utf-8'));
        compatPaths = Array.isArray(raw?.paths) ? raw.paths : [];
      } catch {
        return; // unreadable accumulator — leave dist untouched
      }
      if (compatPaths.length === 0) return;

      const nonTiPrefixes = buildNonTicinoJobPrefixes();
      let emitted = 0;
      let skippedExisting = 0;
      let skippedUnresolved = 0;

      for (const rawPath of compatPaths) {
        const raw = String(rawPath || '');
        if (!raw.startsWith('/') || !matchNonTicinoJobPath(raw, nonTiPrefixes)) continue;

        const resolution = resolveSearchConsoleCompatTarget(raw);
        if (!resolution) { skippedUnresolved++; continue; }

        const from = withSlash(raw);
        const fromNorm = from.replace(/\/+$/, '');
        const toNorm = resolution.canonicalPath.replace(/\/+$/, '');
        if (from === '/' || fromNorm === toNorm) continue; // never self-reference

        const outDir = path.join(distDir, from.slice(1));
        // Gap-fill only: an enriched soft-landing / active page already here wins.
        if (fs.existsSync(path.join(outDir, 'index.html'))) { skippedExisting++; continue; }

        const to = withSlash(resolution.canonicalPath);
        const kind = resolution.kind;
        const html = buildCanonicalBridgePage({
          canonicalUrl: `${BASE_URL}${to}`,
          pathLabel: to,
          title: 'Pagina archiviata | Frontaliere Ticino',
          description: `Annuncio non piu disponibile collegato a ${to}.`,
          body: `Questa pagina ${kind === 'company' ? 'azienda' : kind === 'search' ? 'di ricerca' : "dell annuncio"} non e piu disponibile. Abbiamo mantenuto una pagina compatibile per evitare un errore e mostrarti le offerte aggiornate per questa zona.`,
          ctaLabel: 'Vedi le offerte aggiornate',
          noindex: true,
        });

        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
        // NB: only the directory `index.html` is written — NOT a flat `.html`
        // sibling. At this volume (~240k recovered paths) the flat file would
        // double the dist inode count for marginal gain: the indexed/hit form
        // of these URLs carries a trailing slash (served by index.html), and
        // the rare no-slash variant gets a GitHub Pages 301 → 200 (still not a
        // 404). These bridges are `noindex`, so the 301 has no SEO cost.
        emitted++;
      }

      if (emitted > 0) {
        console.log(
          `\x1b[36m[canton-job-compat-bridge]\x1b[0m Recovered ${emitted} non-Ticino job 404s as canonical bridge pages ` +
            `(${skippedExisting} already had enriched pages, ${skippedUnresolved} unresolved → left for prune).`,
        );
      }
    },
  };
}
