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

// Anti-runaway rail (NOT a recovery limit): the 40k hard cap used to bite the
// real CF-confirmed 404 universe — a time-sliced sweep (build-cf-hot-404s.mjs,
// 48×1h windows summed) measures ~50k accumulated ≥2-hit paths and ~134k
// distinct ever-swept, so 40k left tens of thousands of real-traffic 404s
// unrecovered. The emit is STREAMING (mkdir + writeFileSync per path, no HTML
// in heap; only the {path,hits} array is retained), so the real cost is inode
// count (~2 per bridge): even the full ~134k universe ≈ 268k inodes on top of
// the ~327k-file IT shard, far under the ~2.3M Pages disk ceiling. So this rail
// is raised to a ceiling that sits ABOVE the measured universe (a true cap only
// against a degraded/hand-edited data file or a runaway), env-tunable for
// backfill. Kept in lockstep with scripts/build-cf-hot-404s.mjs's MAX_PATHS —
// change BOTH together. SSG-memory is not measurable pre-merge: revert-trigger
// declared in the PR body (revert if the next deploy OOMs or wall-time regresses).
const MAX_EMIT = Number(process.env.CF_HOT_404_MAX) || 250000;

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
      // Third source (OPT-IN): the full Cloudflare-imported 404 accumulator.
      // Every path Google/CF has hit at the edge lands here (appended daily by
      // discover-404s-via-cloudflare.mjs), so it carries the canton-drift orphans
      // the bounded hot-list and GSC export miss. Synthetic floor of 1 (below the
      // GSC floor) so genuinely hot + GSC-confirmed paths still win the hard cap
      // first; the rest fill the remaining cap. DEFAULT OFF: it can push emit from
      // ~49k toward the 250k cap on the OOM-prone SSG path (unmeasurable pre-merge)
      // — enable with CF_HOT_404_INCLUDE_ACCUMULATOR=1 after a deploy confirms the
      // mem/wall-time headroom. The slug→canonical resolution below already
      // upgrades the existing hot-list + GSC bridges to real pages without it.
      const ACCUMULATOR_SYNTHETIC_HITS = 1;
      if (process.env.CF_HOT_404_INCLUDE_ACCUMULATOR === '1') {
        const accumulatorFile = path.resolve(rootDir, 'data/seo-404-compat-paths.json');
        if (fs.existsSync(accumulatorFile)) {
          try {
            const raw = JSON.parse(fs.readFileSync(accumulatorFile, 'utf-8'));
            for (const p of (Array.isArray(raw?.paths) ? raw.paths : []) as unknown[]) {
              addPath(p, ACCUMULATOR_SYNTHETIC_HITS);
            }
          } catch { /* unreadable accumulator — use the hot-list + coverage union */ }
        }
      }
      if (hitsByPath.size === 0) return;

      // Slug → canonical-path index for canton-drift recovery: a job slug is
      // globally unique, so an orphaned canton-variant 404 (/cerca-lavoro-<X>/<slug>)
      // resolves to the real (200) page at the slug's CURRENT canonical canton
      // instead of the bare listing. Built once from the committed tracking ledger
      // (data/all-known-job-slugs.json). Keyed by localized slug (last path
      // segment of each locale path). Best-effort: missing/unreadable ledger →
      // the resolver simply falls back to the section listing.
      const slugCanonical = new Map<string, Partial<Record<'it' | 'en' | 'de' | 'fr', string>>>();
      try {
        const tracking = JSON.parse(
          fs.readFileSync(path.resolve(rootDir, 'data/all-known-job-slugs.json'), 'utf-8'),
        ) as Record<string, Partial<Record<'it' | 'en' | 'de' | 'fr', string>>>;
        for (const key of Object.keys(tracking)) {
          const entry = tracking[key];
          if (!entry) continue;
          for (const loc of ['it', 'en', 'de', 'fr'] as const) {
            const p = entry[loc];
            if (!p) continue;
            const seg = p.replace(/\/+$/, '').split('/').pop();
            if (seg && !slugCanonical.has(seg)) slugCanonical.set(seg, entry);
          }
        }
      } catch { /* no tracking ledger — canton-drift recovery falls back to listings */ }
      const slugIndex = slugCanonical.size > 0 ? slugCanonical : undefined;

      // Highest-traffic first, then hard-cap.
      const ordered = [...hitsByPath.entries()]
        .map(([p, h]) => ({ path: p, hits: h }))
        .sort((a, b) => (b.hits || 0) - (a.hits || 0))
        .slice(0, MAX_EMIT);

      let emitted = 0;
      let skippedExisting = 0;
      let skippedUnresolved = 0;

      for (const { path: rawPath } of ordered) {
        const resolution = resolveSearchConsoleCompatTarget(rawPath, slugIndex);
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
        // canton-moved: the canonical IS the same job at its current canton path
        // (a real 200 page), so word the bridge as a relocation and point the CTA
        // straight at it. Other kinds land on a listing/landing.
        const body = kind === 'canton-moved'
          ? `Questo annuncio e stato spostato. Lo trovi aggiornato alla pagina collegata qui sotto.`
          : `Questa pagina ${kind === 'company' ? 'azienda' : kind === 'search' ? 'di ricerca' : "dell annuncio"} non e piu disponibile. Abbiamo mantenuto una pagina compatibile per evitare un errore e mostrarti le offerte aggiornate per questa zona.`;
        const html = buildCanonicalBridgePage({
          canonicalUrl: `${BASE_URL}${to}`,
          pathLabel: to,
          title: kind === 'canton-moved' ? 'Annuncio spostato | Frontaliere Ticino' : 'Pagina archiviata | Frontaliere Ticino',
          description: kind === 'canton-moved' ? `Annuncio spostato: vedi ${to}.` : `Annuncio non piu disponibile collegato a ${to}.`,
          body,
          ctaLabel: kind === 'canton-moved' ? 'Vai all annuncio' : 'Vedi le offerte aggiornate',
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
