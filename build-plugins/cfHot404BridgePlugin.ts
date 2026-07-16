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
import { readCompatPaths } from '../scripts/lib/compat-paths-store.mjs';
import searchClusterMapFile from '../data/search-cluster-301-map.json';

// Legacy per-canton related-search cluster URLs (old slug format, now 404). The
// hot-list/GSC sweeps miss them (mostly origin-side worker probes, not eyeball
// hits), so seed them here directly; each has a verified live target so
// resolveSearchConsoleCompatTarget upgrades it to the SPECIFIC live cluster. The
// set is small (~3.8k) and fully resolvable — negligible vs the hard cap.
const SEARCH_CLUSTER_LEGACY_PATHS: string[] = Object.keys(
  (searchClusterMapFile as { map?: Record<string, string> }).map ?? {},
);
// Trailing-slash-normalized lookup: these legacy cluster orphans have a
// VERIFIED-LIVE target (a specific live cluster or the canton board), so they
// must REDIRECT the user to the real page rather than dead-end on a "Pagina
// archiviata" compat bridge — see the meta-refresh branch in the emit loop.
const SEARCH_CLUSTER_LEGACY_SET = new Set(
  SEARCH_CLUSTER_LEGACY_PATHS.map((p) => p.replace(/\/+$/, '')),
);

// Anti-runaway rail (NOT a recovery limit): the 40k hard cap used to bite the
// real CF-confirmed 404 universe — a time-sliced sweep (build-cf-hot-404s.mjs,
// 48×1h windows summed) measures ~50k accumulated ≥2-hit paths and ~134k
// distinct ever-swept, so 40k left tens of thousands of real-traffic 404s
// unrecovered. The 250k cap that replaced it hit the SAME failure mode by
// 2026-07-07 (accumulator grew 181k→236k in 6 days, ~11-14k/day and
// accelerating — real job-market churn, not a runaway) — ~13.6k headroom left
// against ~13k/day growth meant the next daily sweep would start silently
// dropping fresh orphans. The emit is STREAMING (mkdir + writeFileSync per
// path, no HTML in heap; only the {path,hits} array is retained), so the real
// cost is inode count (~2 per bridge): even 500k paths ≈ 1M inodes on top of
// the ~327k-file IT shard, far under the ~2.3M Pages disk ceiling. So this rail
// is raised to a ceiling that sits ABOVE the measured universe (a true cap only
// against a degraded/hand-edited data file or a runaway), env-tunable for
// backfill. Kept in lockstep with scripts/build-cf-hot-404s.mjs's MAX_PATHS —
// change BOTH together. SSG-memory is not measurable pre-merge: revert-trigger
// declared in the PR body (revert if the next deploy OOMs or wall-time regresses).
// Revisit if growth doesn't taper (this rail will bite again).
const MAX_EMIT = Number(process.env.CF_HOT_404_MAX) || 500000;

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
    // Issue #4263 item 4: this docblock's own "last position in the plugin array"
    // safety claim (see file header) does not, by itself, guarantee this plugin's
    // existsSync gap-fill checks run after every other page-producing/bridge
    // plugin's closeBundle — Rollup's closeBundle is async-parallel by default, so
    // registration order alone only decides DISPATCH order, not COMPLETION order.
    // `order:'post'` + `sequential:true` makes Rollup await every previously-queued
    // closeBundle promise (every plugin registered earlier, including
    // eventsSeoPagesPlugin, legacyRedirectsPlugin, cantonOrphanRedirectsPlugin,
    // jobOrphanBridgePlugin, locationHubBridgePlugin, companyHubBridgePlugin,
    // legacyAliasPlugin — all of which this plugin's "never overwrites" guarantee
    // depends on having already written) before this handler runs. Verified
    // against the installed rollup package; mirrors hreflangPostprocessPlugin.ts.
    closeBundle: {
      order: 'post',
      sequential: true,
      handler: async () => {
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
      // Legacy related-search cluster URLs (see SEARCH_CLUSTER_LEGACY_PATHS).
      // Synthetic floor of 2 (above the accumulator's 1, below GSC) — these are
      // GSC-indexed dead URLs with a verified live target, worth recovering, but
      // not ahead of genuinely hot edge 404s. Bounded (~3.8k), always resolvable.
      const CLUSTER_LEGACY_SYNTHETIC_HITS = 2;
      for (const p of SEARCH_CLUSTER_LEGACY_PATHS) {
        addPath(p, CLUSTER_LEGACY_SYNTHETIC_HITS);
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
        // Sharded accumulator (issue #2988): union via the store helper.
        for (const p of readCompatPaths(rootDir).paths as unknown[]) {
          addPath(p, ACCUMULATOR_SYNTHETIC_HITS);
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

      // OPT-IN equity-SEO variant (DEFAULT OFF): the IT canton-moved full-content
      // copies below are forced noindex so they recover UX + a 200 status without
      // competing for index equity. With CF_HOT_404_IT_INDEX=1 the forced noindex
      // is dropped: the copied page stays indexable and its own
      // <link rel=canonical>/og:url already point at the CURRENT canton (`to`), so
      // Google consolidates equity to the live page (the canonical index+canonical
      // pattern) instead of dropping the URL. DEFAULT OFF because flipping ~65k
      // verbatim copies to indexable is a duplicate-content judgement call (Google
      // may consolidate via canonical, or may treat the mass-duplication as soft
      // doppione) — activate only after evaluating the duplicate-content impact,
      // exactly as the noindex was a deliberate choice. Mirrors the accumulator
      // opt-in above: a deploy/owner flag flip, never a default behaviour change.
      const itIndexable = process.env.CF_HOT_404_IT_INDEX === '1';

      let emitted = 0;
      let emittedFull = 0;
      let skippedExisting = 0;
      let skippedUnresolved = 0;

      for (const { path: rawPath } of ordered) {
        const resolution = resolveSearchConsoleCompatTarget(rawPath, slugIndex);
        if (!resolution) { skippedUnresolved++; continue; }

        const from = withSlash(rawPath);
        const fromNorm = from.replace(/\/+$/, '');

        let to = withSlash(resolution.canonicalPath);
        // A specific pagination-ladder page (bare `page-N` recovery) can shrink
        // out of existence between the original GSC crawl and this build — the
        // SPA has no out-of-range fallback for a missing page (blank shell, not
        // a 404), so verify the static file is actually on disk before pointing
        // there; otherwise land on the always-live section listing root. Must
        // resolve BEFORE the self-reference check below: for en/fr (whose
        // pagination word is the legacy "page" itself) an unresolved target
        // is textually identical to `from`, so checking self-reference against
        // the raw canonicalPath would wrongly skip the whole bridge.
        if (resolution.fallbackPath) {
          const pageFile = path.join(distDir, to.slice(1), 'index.html');
          if (!fs.existsSync(pageFile)) {
            to = withSlash(resolution.fallbackPath);
            // The fallback itself is not unconditionally emitted either (e.g. the
            // Swiss-wide events index is skipped when zero events exist sitewide
            // this build, not just for one canton) — verify it too, otherwise this
            // bridges to another 404 (review finding on PR #4252's re-review round).
            const fallbackFile = path.join(distDir, to.slice(1), 'index.html');
            if (!fs.existsSync(fallbackFile)) { skippedUnresolved++; continue; }
          }
        }
        const toNorm = to.replace(/\/+$/, '');
        if (from === '/' || fromNorm === toNorm) continue; // never self-reference

        const outDir = path.join(distDir, from.slice(1));
        // Gap-fill only: a richer page already here (active job / enriched
        // soft-landing / jobOrphan or hub bridge) must win.
        if (fs.existsSync(path.join(outDir, 'index.html'))) { skippedExisting++; continue; }

        const kind = resolution.kind;
        // A legacy cluster orphan whose target is verified-live: redirect the
        // user straight there instead of serving the archived compat bridge.
        const isClusterRedirect = SEARCH_CLUSTER_LEGACY_SET.has(fromNorm);

        // Canton-drift recovery as a REAL 200 page WITH the job's full content.
        // For an IT canton-moved orphan (the apex is NOT behind the locale Worker,
        // so without this it only ever gets a soft-404/JS redirect or a thin
        // bridge), copy the slug's already-built canonical page HTML verbatim. The
        // copied HTML's own <link rel=canonical>/og:url/hreflang already point at
        // the current canton, so ranking signals consolidate there while this URL
        // serves a full 200 instead of a 404. By default the copy is forced
        // noindex (UX + 200, no index competition); with CF_HOT_404_IT_INDEX=1 the
        // forced noindex is dropped so the copy stays indexable and consolidates
        // equity to `to` via its embedded canonical (see itIndexable note above).
        // en/de/fr are intentionally left to the thin bridge below: the locale
        // Worker 301s them at the edge (strictly better than a duplicate 200).
        // Falls through to the thin bridge if the canonical file isn't on disk.
        const isItPath = !/^\/(en|de|fr)\//.test(from);
        if (kind === 'canton-moved' && isItPath) {
          const canonFile = path.join(distDir, to.slice(1), 'index.html');
          if (fs.existsSync(canonFile)) {
            let canonHtml = fs.readFileSync(canonFile, 'utf-8');
            if (!itIndexable) {
              // Quote-flexible: PR #478 baked `removeAttributeQuotes` upstream, so
              // single-token attribute values lose their quotes in dist/ (`name=robots`).
              // A quote-mandatory regex (`name=["']robots["']`) misses the minified meta,
              // falls through to the <head> branch, and injects a SECOND robots meta while
              // the original `index,follow` one survives — the drift copy stays indexable.
              canonHtml = /<meta\s+name=["']?robots["']?/i.test(canonHtml)
                ? canonHtml.replace(
                    /<meta\s+name=["']?robots["']?[^>]*>/i,
                    '<meta name="robots" content="noindex,follow">',
                  )
                : canonHtml.replace(
                    /<head(\s[^>]*)?>/i,
                    (m) => `${m}<meta name="robots" content="noindex,follow">`,
                  );
            }
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'index.html'), canonHtml, 'utf-8');
            emitted++;
            emittedFull++;
            continue;
          }
        }

        // canton-moved: the canonical IS the same job at its current canton path
        // (a real 200 page), so word the bridge as a relocation and point the CTA
        // straight at it. Other kinds land on a listing/landing.
        const body = kind === 'canton-moved'
          ? `Questo annuncio e stato spostato. Lo trovi aggiornato alla pagina collegata qui sotto.`
          : isClusterRedirect
          ? `Questa ricerca ha una versione aggiornata. Ti stiamo portando alla pagina corretta; se non vieni reindirizzato, aprila qui sotto.`
          : `Questa pagina ${kind === 'company' ? 'azienda' : kind === 'search' ? 'di ricerca' : "dell annuncio"} non e piu disponibile. Abbiamo mantenuto una pagina compatibile per evitare un errore e mostrarti le offerte aggiornate per questa zona.`;
        let html = buildCanonicalBridgePage({
          canonicalUrl: `${BASE_URL}${to}`,
          pathLabel: to,
          title: kind === 'canton-moved'
            ? 'Annuncio spostato | Frontaliere Ticino'
            : isClusterRedirect
            ? 'Ricerca aggiornata | Frontaliere Ticino'
            : 'Pagina archiviata | Frontaliere Ticino',
          description: kind === 'canton-moved' ? `Annuncio spostato: vedi ${to}.` : `Annuncio non piu disponibile collegato a ${to}.`,
          body,
          ctaLabel: kind === 'canton-moved'
            ? 'Vai all annuncio'
            : isClusterRedirect
            ? 'Apri la ricerca aggiornata'
            : 'Vedi le offerte aggiornate',
          noindex: true,
        });

        if (isClusterRedirect) {
          // Land the user on the real (verified-live) page immediately. With the
          // canonical link + noindex already set on the page, a meta-refresh is
          // 301-equivalent for crawlers and an instant redirect for users — the
          // same pattern cantonOrphanRedirectsPlugin uses. Replaces the dead-end
          // "Pagina archiviata" compat bridge for these orphans.
          html = html.replace(
            '</head>',
            `  <meta http-equiv="refresh" content="0; url=${to}">\n  </head>`,
          );
        }

        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
        emitted++;
      }

      if (emitted > 0) {
        const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
        console.log(
          `\x1b[36m[cf-hot-404-bridge]\x1b[0m Recovered ${emitted} Cloudflare/GSC-confirmed 404s ` +
            `(${emittedFull} full-content canton-moved copies [${itIndexable ? 'indexable+canonical' : 'noindex'}], ` +
            `${emitted - emittedFull} thin bridges; ` +
            `cap ${MAX_EMIT}; ${skippedExisting} already had richer pages, ${skippedUnresolved} unresolved). ` +
            `[mem] heapUsed=${heapMb}MB after emit.`,
        );
      }
      },
    },
  };
}
