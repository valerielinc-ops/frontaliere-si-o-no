#!/usr/bin/env node
/**
 * build-cf-hot-404s.mjs — bounded, traffic-targeted hot-list of non-Ticino
 * job-detail 404s for cfHot404BridgePlugin to recover.
 *
 * Why bounded (not the full compat accumulator): PR #2000 tried to emit a
 * bridge at EVERY non-Ticino compat job path (~241k). On top of
 * jobsSeoPagesPlugin's ~312k Ticino soft-landings that OOM'd the SSG build
 * (8GB heap) — reverted in #2031. The fix is to recover only the paths
 * Cloudflare confirms are ACTUALLY HIT: the long-tail with zero traffic is
 * not worth a page. The CF edge analytics records every real 404 with a hit
 * count, so we rank by hits and cap hard — a few thousand pages, safe by
 * construction.
 *
 * Output `data/cf-hot-404s.json`:
 *   { generatedAt, source:'cloudflare', windowHours, cap, paths:[{path,hits}] }
 * sorted by hits desc, accumulated across runs (keep max hits per path),
 * capped at MAX_PATHS. Ticino + nationwide `_AGGREGATE_` sections are EXCLUDED
 * (owned by jobsSeoPagesPlugin). Only single-segment job-detail slugs.
 *
 * Auth: CF_API_TOKEN (Zone→Analytics→Read), from Firebase Remote Config:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/load-rc-env.mjs)" && node scripts/build-cf-hot-404s.mjs
 *
 * Usage:
 *   node scripts/build-cf-hot-404s.mjs            # refresh + accumulate + write
 *   node scripts/build-cf-hot-404s.mjs --dry-run  # print stats, no write
 *   node scripts/build-cf-hot-404s.mjs --cap=8000 # override MAX_PATHS
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sweepErrorPathsWindowed, resolveZoneId, DEFAULT_ZONE_NAME } from './lib/cf-analytics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'cf-hot-404s.json');
const APEX_HOST = process.env.CF_ZONE_NAME || DEFAULT_ZONE_NAME;

// Anti-runaway rail (NOT a recovery limit). The 40k cap used to bite the real
// universe: this time-sliced sweep (48×1h windows summed below) measures ~50k
// accumulated ≥2-hit non-Ticino job 404s and ~134k distinct ever-swept, so 40k
// dropped tens of thousands of real-traffic paths before the bridge plugin ever
// saw them. The cfHot404BridgePlugin emit is STREAMING (mkdir+writeFile per
// path, no HTML held in heap), so the real cost is inode count (~2 per bridge):
// even the full ~134k universe ≈ 268k inodes on top of the ~327k-file IT shard,
// far under the ~2.3M Pages disk ceiling. Raised to a ceiling ABOVE the measured
// universe (true cap only vs a degraded CF response / runaway), env-tunable.
// Kept in lockstep with cfHot404BridgePlugin's MAX_EMIT — change BOTH together.
const MAX_PATHS = Number(process.env.CF_HOT_404_MAX) || 250000;

// Drop one-hit noise: a single hit is usually a bot path-probe, not a real
// expired/indexed URL worth a page. Real expired URLs get repeat hits from
// Google + returning visitors.
const MIN_HITS = 2;

// Age-out window for the accumulator. The list keeps the MAX hits ever seen per
// path so a briefly-hot URL is not dropped the moment it goes quiet — but
// without a recency bound the accumulator only ever grew (measured 87.6k→111.6k
// in 5 days, 0 dropped), marching toward the MAX_PATHS cap with STALE once-hot
// paths outranking fresh actively-hit orphans (the cap evicted by hits, not
// recency). A path not seen at the edge for STALE_DAYS — across the daily 48h
// sweeps — is one Google has stopped crawling: it has CONVERGED, its bridge is
// no longer load-bearing, and if Google ever re-crawls it the next sweep re-adds
// it and the next deploy re-emits the bridge. Dropping it keeps the list bounded
// and reflecting the CURRENT 404 universe. Conservative default (a URL untouched
// for 4 months is genuinely gone); env-tunable, 0 disables the age-out.
const STALE_DAYS = Number(process.env.CF_HOT_404_STALE_DAYS) || 120;

// Ticino + nationwide sections are owned by jobsSeoPagesPlugin; never include —
// EXCEPT cross-canton drift orphans (see isCrossCantonTicinoOrphan below). A job
// whose URL section re-derives away from Ticino (sharedResolveJobCanton, e.g.
// the pre-pin default-to-TI fallback) leaves its old `/cerca-lavoro-ticino/<slug>/`
// indexed URL orphaned; jobsSeoPagesPlugin's compat-merge drops it (it skips a
// slug whose `tracking[slug][locale]` is already set to the now-active non-TI
// canton), so it 404s with no soft-landing. Those ARE in scope here.
const TICINO_RE =
  /^\/(cerca-lavoro-ticino|en\/(find-jobs?|job-search)-ticino|de\/(jobs-im|jobsuche|stellenangebote)-tessin|fr\/(trouver-emploi|recherche-emploi|emplois)-tessin)\//;
const AGGREGATE_RE =
  /^\/(cerca-lavoro-svizzera|en\/find-jobs-switzerland|de\/jobs-in-schweiz|fr\/trouver-emploi-suisse)\//;

// Slug → per-locale CURRENT canonical section prefix, from the committed ledger
// data/all-known-job-slugs.json (same source jobCanonRedirectMapPlugin shards for
// the 404.html runtime resolver). Used ONLY to tell a genuine cross-canton Ticino
// orphan (slug's canonical now lives under a DIFFERENT section) from a legit
// Ticino job (canonical IS Ticino → already emitted by the main loop) or an
// expired/unknown slug (handled by the seo-404-compat-paths.json compat-merge).
// Best-effort: a missing/unreadable ledger leaves Ticino fully excluded (the
// historical behaviour), never throws.
const slugCanonicalSection = (() => {
  const map = new Map();
  try {
    const ledger = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'data', 'all-known-job-slugs.json'), 'utf8'),
    );
    for (const key of Object.keys(ledger)) {
      const entry = ledger[key];
      if (!entry || typeof entry !== 'object') continue;
      for (const loc of ['it', 'en', 'de', 'fr']) {
        const p = entry[loc];
        if (typeof p !== 'string' || !p.startsWith('/')) continue;
        const norm = p.replace(/\/+$/, '');
        const cut = norm.lastIndexOf('/');
        if (cut <= 0) continue;
        const slug = norm.slice(cut + 1);
        const section = norm.slice(0, cut); // e.g. /cerca-lavoro-berna, /de/jobs-in-bern
        if (slug && !map.has(slug)) map.set(slug, {});
        const rec = map.get(slug);
        if (rec && !(loc in rec)) rec[loc] = section;
      }
    }
  } catch {
    /* no ledger → Ticino stays fully excluded (historical behaviour) */
  }
  return map;
})();

// Locale (it default) + section prefix + slug for a normalized job-detail path.
function parseJobPath(p) {
  const segs = p.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const locale = segs[0] === 'en' || segs[0] === 'de' || segs[0] === 'fr' ? segs[0] : 'it';
  const slug = segs[segs.length - 1];
  const section = '/' + segs.slice(0, -1).join('/');
  return { locale, slug, section };
}

// A Ticino-section path is in scope ONLY when its slug is a known job whose
// CURRENT canonical (for that locale) lives under a DIFFERENT section — i.e. a
// real canton-drift orphan with a live 200 page elsewhere. Legit Ticino jobs
// (canonical == this section) and expired/unknown slugs stay excluded.
function isCrossCantonTicinoOrphan(p) {
  const parsed = parseJobPath(p);
  if (!parsed) return false;
  const rec = slugCanonicalSection.get(parsed.slug);
  if (!rec) return false;
  const canon = rec[parsed.locale];
  return Boolean(canon) && canon !== parsed.section;
}

// A non-Ticino per-canton job-detail path: optional locale prefix, a job-board
// section stem + canton slug, then exactly ONE slug segment.
const JOB_DETAIL_RE =
  /^(?:\/(?:en|de|fr))?\/(?:cerca-lavoro|find-jobs?|job-search|jobs-i[mn]|jobsuche|stellenangebote|trouver-emploi|recherche-emploi|emplois)-[a-z-]+\/[^/]+\/?$/;

/**
 * Reconcile the accumulated hot-list with a fresh sweep, applying a lastSeen
 * age-out and a recency-prioritised retention cap. Pure (no I/O) so it is unit-
 * testable; main() wires in the file read/write.
 *
 *  - Carries forward prior entries (max hits ever seen + prior lastSeen).
 *  - Stamps lastSeen=todayStr for every path re-seen in this sweep (count>=minHits).
 *  - Drops paths not seen for > staleDays (converged — see STALE_DAYS).
 *  - When over `cap`, evicts the LEAST-recently-seen first (then lowest hits) so a
 *    stale once-hot path can never displace a fresh, actively-hit orphan. Below
 *    the cap this is a no-op (the full set is kept, ordered by hits for emit).
 *
 * Backward-compat: pre-age-out entries have no lastSeen → graced to todayStr so
 * the first run after this change never mass-evicts a healthy list; they then age
 * out naturally over staleDays if Google stops crawling them.
 *
 * @returns {{ paths: Array<{path:string,hits:number,lastSeen:string}>, fresh:number, agedOut:number, accumulated:number }}
 */
export function reconcileHotPaths({ existing, sweptRows, cap, minHits, staleDays, todayStr, isHotCandidate }) {
  const norm = (p) => p.replace(/\/+$/, '');
  const acc = new Map(); // norm path -> { hits, lastSeen }
  for (const e of existing) {
    if (!e || typeof e.path !== 'string') continue;
    const p = norm(e.path);
    if (!isHotCandidate(p)) continue;
    acc.set(p, {
      hits: e.hits || 0,
      lastSeen: typeof e.lastSeen === 'string' ? e.lastSeen : todayStr,
    });
  }
  let fresh = 0;
  for (const r of sweptRows) {
    if (r.count < minHits) continue;
    const p = norm(r.path);
    if (!isHotCandidate(p)) continue;
    const prev = acc.get(p);
    if (!prev) {
      acc.set(p, { hits: r.count, lastSeen: todayStr });
      fresh++;
    } else {
      if (r.count > prev.hits) prev.hits = r.count;
      prev.lastSeen = todayStr;
    }
  }
  let agedOut = 0;
  if (staleDays > 0) {
    const cutoff = Date.parse(todayStr) - staleDays * 86400000;
    for (const [p, v] of acc) {
      const t = Date.parse(v.lastSeen);
      if (Number.isFinite(t) && t < cutoff) {
        acc.delete(p);
        agedOut++;
      }
    }
  }
  const accumulated = acc.size;
  let entries = [...acc.entries()].map(([path, v]) => ({ path, hits: v.hits, lastSeen: v.lastSeen }));
  if (entries.length > cap) {
    // Retention: most-recently-seen kept first (hits desc as tiebreak), so the
    // cap sheds CONVERGED paths, never fresh actively-hit ones.
    entries.sort(
      (a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.hits - a.hits || a.path.localeCompare(b.path),
    );
    entries = entries.slice(0, cap);
  }
  // Emit order: highest hits first (bridge recovery priority), stable by path.
  entries.sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
  return { paths: entries, fresh, agedOut, accumulated };
}

function parseArgs(argv) {
  const opts = { dryRun: false, cap: MAX_PATHS };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--cap=')) opts.cap = Math.max(1, Number(a.slice(6)) || MAX_PATHS);
  }
  return opts;
}

function readExisting() {
  try {
    const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    return Array.isArray(j?.paths) ? j.paths : [];
  } catch {
    return [];
  }
}

function isHotCandidate(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return false;
  if (!JOB_DETAIL_RE.test(p)) return false;
  if (AGGREGATE_RE.test(p)) return false;
  // Ticino sections are normally owned by jobsSeoPagesPlugin, but cross-canton
  // drift orphans (slug's canonical now under a different section) fall through
  // its compat-merge → recover them here too.
  if (TICINO_RE.test(p)) return isCrossCantonTicinoOrphan(p);
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.error('❌ CF_API_TOKEN not set. Run `node scripts/load-rc-env.mjs` first.');
    process.exit(1);
  }
  const zoneId = await resolveZoneId(token, APEX_HOST, process.env.CF_ZONE_ID);

  // ── Time-sliced sweep ─────────────────────────────────────────────────────
  // A single httpRequestsAdaptiveGroups query is capped at 10k rows ordered by
  // count_DESC, so ONE 24h window only ever surfaces the 10k hottest paths — the
  // long-tail of distinct expired / wrong-canton job URLs (each hit a handful of
  // times) never enters the result, so it never gets a recovery bridge and keeps
  // 404ing. Windowing (sweepErrorPathsWindowed, scripts/lib/cf-analytics.mjs)
  // sweeps the last WINDOW_COUNT contiguous hourly windows and SUMs the
  // per-path counts: a path outside one window's top-10k still surfaces in
  // another, and summing the non-overlapping windows reconstructs its true
  // multi-day hit total. Tunable via env for backfill vs daily cadence.
  const WINDOW_HOURS = Number(process.env.CF_SWEEP_WINDOW_HOURS || 1);
  const WINDOW_COUNT = Number(process.env.CF_SWEEP_WINDOWS || 48);
  const { rows, windowsOk } = await sweepErrorPathsWindowed(token, zoneId, {
    windowHours: WINDOW_HOURS,
    windowCount: WINDOW_COUNT,
    minStatus: 404,
    maxStatus: 404,
    host: APEX_HOST,
  });
  console.log(
    `🛰️  Swept ${windowsOk}/${WINDOW_COUNT} × ${WINDOW_HOURS}h windows → ${rows.length} distinct 404 paths.`,
  );

  // Accumulate with a recency-aware age-out (keep MAX hits ever seen per path,
  // but drop paths the edge has not seen for STALE_DAYS and evict by recency when
  // over the cap). Pure helper so the retention invariants are unit-tested.
  const todayStr = new Date().toISOString().slice(0, 10);
  const { paths: sorted, fresh, agedOut, accumulated } = reconcileHotPaths({
    existing: readExisting(),
    sweptRows: rows,
    cap: opts.cap,
    minHits: MIN_HITS,
    staleDays: STALE_DAYS,
    todayStr,
    isHotCandidate,
  });

  console.log(
    `📊 CF non-Ticino job 404s: ${rows.length} CF rows → ${accumulated} accumulated ` +
      `(${fresh} new, ${agedOut} aged out >${STALE_DAYS}d), ` +
      `capped to ${sorted.length} (MAX ${opts.cap}, min-hits ${MIN_HITS}).`,
  );
  if (sorted.length) {
    console.log('   top:', sorted.slice(0, 3).map((x) => `${x.hits}×${x.path}`).join('  '));
  }

  if (opts.dryRun) {
    console.log('🧪 --dry-run: no write.');
    return;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'cloudflare',
    windowHours: 23.9,
    cap: opts.cap,
    minHits: MIN_HITS,
    staleDays: STALE_DAYS,
    paths: sorted,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`✅ Wrote ${OUT} (${sorted.length} paths).`);
}

// Run only when invoked directly (not when imported for unit tests of the pure
// reconcileHotPaths helper — importing must not trigger the network sweep).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`❌ ${err?.message || err}`);
    process.exit(1);
  });
}
