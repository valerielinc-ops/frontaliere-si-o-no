/**
 * cfHot404BridgePlugin — recover the non-Ticino job 404s Cloudflare confirms
 * are actually hit, at their exact path, with a hard emit cap.
 *
 * Background: jobsSeoPagesPlugin's compat merge only handles Ticino sections,
 * and legacyRedirectsPlugin skips every job path — so non-Ticino job-detail
 * URLs that Google indexed (now expired) 404 live. PR #2000 tried to emit a
 * bridge at EVERY such compat path (~241k) and OOM'd the SSG build (reverted
 * in #2031). This is the bounded replacement: emit a bridge ONLY for the
 * paths `scripts/build-cf-hot-404s.mjs` recorded as actually hit at the edge
 * (`data/cf-hot-404s.json`, ranked by hit count, already capped), and apply a
 * second HARD CAP here so the page count can never blow up the build again.
 *
 * Path-keyed (one page per hit URL, at the exact indexed/hit canton path — no
 * slug-collision loss). noindex canonical bridge → live listing for the
 * canton. enforce:'post' + an existsSync gap-fill guard + last position in the
 * plugin array mean it only fills paths with no richer page (active job,
 * enriched soft-landing, jobOrphan/hub bridge), never overwrites them.
 */

import path from 'path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { BASE_URL, buildCanonicalBridgePage } from './constants';
import { resolveSearchConsoleCompatTarget } from './searchConsoleCompat';

// Defensive rail (the #2000 OOM lesson): even if data/cf-hot-404s.json grows
// or is hand-edited, never emit more than this many bridge pages.
const MAX_EMIT = 12000;

const withSlash = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

interface HotPath {
  path: string;
  hits?: number;
}

export function cfHot404BridgePlugin(rootDir: string): Plugin {
  return {
    name: 'cf-hot-404-bridge',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      const hotFile = path.resolve(rootDir, 'data/cf-hot-404s.json');
      if (!fs.existsSync(hotFile) || !fs.existsSync(distDir)) return;

      let hot: HotPath[] = [];
      try {
        const raw = JSON.parse(fs.readFileSync(hotFile, 'utf-8'));
        hot = Array.isArray(raw?.paths) ? raw.paths : [];
      } catch {
        return; // unreadable hot-list — leave dist untouched
      }
      if (hot.length === 0) return;

      // Highest-traffic first, then hard-cap.
      const ordered = [...hot]
        .filter((h) => h && typeof h.path === 'string' && h.path.startsWith('/'))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0))
        .slice(0, MAX_EMIT);

      let emitted = 0;
      let skippedExisting = 0;
      let skippedUnresolved = 0;

      for (const { path: rawPath } of ordered) {
        const resolution = resolveSearchConsoleCompatTarget(rawPath);
        if (!resolution) { skippedUnresolved++; continue; }

        const from = withSlash(rawPath);
        const fromNorm = from.replace(/\/+$/, '');
        const toNorm = resolution.canonicalPath.replace(/\/+$/, '');
        if (from === '/' || fromNorm === toNorm) continue; // never self-reference

        const outDir = path.join(distDir, from.slice(1));
        // Gap-fill only: a richer page already here (active job / enriched
        // soft-landing / jobOrphan or hub bridge) must win.
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
        emitted++;
      }

      if (emitted > 0) {
        console.log(
          `\x1b[36m[cf-hot-404-bridge]\x1b[0m Recovered ${emitted} Cloudflare-confirmed non-Ticino job 404s ` +
            `(cap ${MAX_EMIT}; ${skippedExisting} already had richer pages, ${skippedUnresolved} unresolved).`,
        );
      }
    },
  };
}
