/**
 * cfHot404BridgePlugin — recover the 404s confirmed by Cloudflare edge traffic
 * AND/OR Google Search Console's Coverage report, at their exact path, with a
 * hard emit cap.
 *
 * Background: jobsSeoPagesPlugin's compat merge only handles Ticino sections,
 * and legacyRedirectsPlugin skips every job path — so non-Ticino job-detail
 * URLs that Google indexed (now expired) 404 live. PR #2000 tried to emit a
 * bridge at EVERY such compat path (~241k) and OOM'd the SSG build (reverted
 * in #2031). This is the bounded replacement: emit a bridge ONLY for paths in
 * two bounded, capped lists —
 *   - `data/cf-hot-404s.json`     (scripts/build-cf-hot-404s.mjs: edge-hit, ranked)
 *   - `data/gsc-coverage-404s.json` (scripts/ingest-gsc-coverage-404s.ts: the
 *     GSC "Not found (404)" Coverage export — confirmed-indexed URLs that may
 *     have no recent edge hit, so the CF sweep never surfaced them)
 * — unioned (max hit count per path), and apply a second HARD CAP here so the
 * page count can never blow up the build again. Any resolvable category is
 * recovered (expired job, pagination, fuel-station, company hub, legacy URL);
 * the resolver gate + existsSync gap-fill keep richer pages winning.
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
// or is hand-edited, never emit more than this many bridge pages. The emit
// below is STREAMING (mkdir + writeFileSync per path, no HTML accumulated in
// heap; the only retained structure is the {path,hits} array), so the real
// cost is inode count (~2 per bridge): 40k bridges ≈ 80k inodes on top of the
// ~327k-file IT shard, far under the ~2.3M Pages disk ceiling. Kept in lockstep
// with scripts/build-cf-hot-404s.mjs's MAX_PATHS — raise BOTH together.
// (Raised 12k→40k on 2026-06-16 to recover more of the long-tail CF-confirmed
// 404s; the per-emit [mem] log below makes the heap cost visible in the deploy
// log. SSG-memory impact is NOT measurable pre-merge — revert if it OOMs.)
const MAX_EMIT = 40000;

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
      if (!fs.existsSync(distDir)) return;
      const hotFile = path.resolve(rootDir, 'data/cf-hot-404s.json');
      // Second bounded source: URLs Google's Coverage report flags as 404.
      // These are confirmed-indexed-but-gone URLs that may have NO recent
      // Cloudflare edge hit (so build-cf-hot-404s.mjs's traffic sweep never
      // saw them), yet are exactly the cohort we want to recover. Any category
      // is welcome here — the resolver + existsSync gap-fill + hard cap below
      // keep it safe — not just the non-TI job-detail paths CF analytics feeds.
      const coverageFile = path.resolve(rootDir, 'data/gsc-coverage-404s.json');

      // Union both sources, keeping the max hit count per path. GSC-sourced
      // paths have no edge-hit count, so they get a synthetic floor (>= MIN_HITS
      // noise floor) so they outrank one-hit bot probes but stay below genuinely
      // hot CF paths when the hard cap bites.
      const GSC_SYNTHETIC_HITS = 2;
      const hitsByPath = new Map<string, number>();
      const addPath = (p: unknown, h: number): void => {
        if (typeof p !== 'string' || !p.startsWith('/')) return;
        const norm = p.replace(/\/+$/, '') || '/';
        const prev = hitsByPath.get(norm) ?? 0;
        if (h > prev) hitsByPath.set(norm, h);
      };
      if (fs.existsSync(hotFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(hotFile, 'utf-8'));
          for (const h of (Array.isArray(raw?.paths) ? raw.paths : []) as HotPath[]) {
            addPath(h?.path, h?.hits || 0);
          }
        } catch { /* unreadable hot-list — fall through to coverage source */ }
      }
      if (fs.existsSync(coverageFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(coverageFile, 'utf-8'));
          for (const p of (Array.isArray(raw?.paths) ? raw.paths : []) as unknown[]) {
            addPath(p, GSC_SYNTHETIC_HITS);
          }
        } catch { /* unreadable coverage list — use whatever the hot-list gave */ }
      }
      if (hitsByPath.size === 0) return;

      // Highest-traffic first, then hard-cap.
      const ordered = [...hitsByPath.entries()]
        .map(([p, h]) => ({ path: p, hits: h }))
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
        const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
        console.log(
          `\x1b[36m[cf-hot-404-bridge]\x1b[0m Recovered ${emitted} Cloudflare/GSC-confirmed 404s ` +
            `(cap ${MAX_EMIT}; ${skippedExisting} already had richer pages, ${skippedUnresolved} unresolved). ` +
            `[mem] heapUsed=${heapMb}MB after emit.`,
        );
      }
    },
  };
}
