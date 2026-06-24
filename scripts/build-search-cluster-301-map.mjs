#!/usr/bin/env node
/**
 * Build data/search-cluster-301-map.json — a recovery map for the LEGACY
 * per-canton related-search cluster URLs that Google indexed under the old slug
 * format and that now hard-404.
 *
 * Background: related-search cluster pages were migrated from a per-canton,
 * salary-prefixed, nation-suffixed slug
 *     /cerca-lavoro-<canton>/ricerca-stipendio-<role>-svizzera/
 * to a single national hub keyed by the job city
 *     /cerca-lavoro-svizzera/ricerca-<role>-<city>/
 * The "stipendio" (salary) framing was deliberately consolidated onto the role,
 * and "<canton>" collapsed to "svizzera". The old indexed URLs were never
 * redirected → 404 (≈14k eyeball hits/day, the dominant residual-404 cohort).
 *
 * This script maps each dead legacy URL to a LIVE target, VERIFIED against the
 * live cluster sitemaps so we never 301 to another 404:
 *   1. nationalize the legacy slug (strip leading salary/boilerplate/junk
 *      tokens + the trailing "-svizzera", swap <canton> → svizzera);
 *   2. if the resulting /cerca-lavoro-svizzera/ricerca-<body>/ is a live
 *      cluster → that is the SPECIFIC target (best relevance);
 *   3. otherwise fall back to the canton job board /cerca-lavoro-<canton>/
 *      (always 200, canton-relevant) — a safe, never-wrong target.
 *
 * The map is consumed at build time by build-plugins/searchConsoleCompat.ts
 * (resolveSearchConsoleCompatTarget) so the compat bridge emits each legacy URL
 * pointing at its live target.
 *
 * Usage:
 *   node scripts/build-search-cluster-301-map.mjs            # fetch live sitemaps
 *   node scripts/build-search-cluster-301-map.mjs --live-file <path>  # offline
 *
 * Re-runnable: regenerate periodically (the live cluster set shifts with the job
 * data); a stale specific-target self-heals to the canton board on the next run.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELATED_SEARCH_JUNK_TERMS } from '../services/relatedSearchJunkTerms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BASE = 'https://frontaliereticino.ch';
const INDEXED = resolve(ROOT, 'data/indexed-cluster-urls.json');
const OUT = resolve(ROOT, 'data/search-cluster-301-map.json');

// Leading boilerplate phrase-heads stripped to reach the canonical role term.
// Mirrors the heads of SEARCH_QUERY_BOILERPLATE_PHRASES in
// services/relatedSearchClusters.ts (salary/job-search framing).
const LEADING_BOILERPLATE = [
  'offerte-lavoro', 'posti-di-lavoro', 'ricerca-stipendio',
  'stipendio', 'salario', 'offerte', 'impieghi', 'impiego', 'posti', 'lavoro',
];

function legacyClusterUrls(indexedPath) {
  const raw = JSON.parse(readFileSync(indexedPath, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.urls || Object.values(raw).find(Array.isArray) || [];
  const urls = arr.map((u) => (typeof u === 'string' ? u : u.url || u.path || '')).filter(Boolean);
  // per-canton (NOT svizzera) ricerca-* slugs only
  return [...new Set(urls.filter((u) => /^\/cerca-lavoro-(?!svizzera\/)[a-z-]+\/ricerca-/.test(u)))];
}

/** Strip the trailing "-svizzera" then leading boilerplate/junk tokens. */
function nationalSlugBody(legacyPath) {
  const m = legacyPath.match(/^\/cerca-lavoro-[a-z-]+\/ricerca-(.+?)\/?$/);
  if (!m) return null;
  let body = m[1];
  if (body.endsWith('-svizzera')) body = body.slice(0, -'-svizzera'.length);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    for (const p of LEADING_BOILERPLATE) {
      if (body === p) { body = ''; changed = true; break; }
      if (body.startsWith(`${p}-`)) { body = body.slice(p.length + 1); changed = true; break; }
    }
    if (changed) continue;
    const first = body.split('-')[0];
    if (first && RELATED_SEARCH_JUNK_TERMS.has(first)) {
      body = body.slice(first.length + 1);
      changed = true;
    }
  }
  return body || null;
}

function cantonBoard(legacyPath) {
  const m = legacyPath.match(/^(\/cerca-lavoro-[a-z-]+)\/ricerca-/);
  return m ? `${m[1]}/` : null;
}

async function fetchLiveClusterSet() {
  const live = new Set();
  for (let n = 1; n <= 20; n++) {
    const idx = String(n).padStart(3, '0');
    const url = `${BASE}/sitemap-search-clusters-${idx}.xml`;
    let xml;
    try {
      const res = await fetch(url);
      if (!res.ok) break; // no more shards
      xml = await res.text();
    } catch {
      break;
    }
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      live.add(m[1].replace(BASE, ''));
    }
  }
  return live;
}

function loadLiveFromFile(path) {
  return new Set(readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
}

async function main() {
  const args = process.argv.slice(2);
  const liveFileIdx = args.indexOf('--live-file');
  const live = liveFileIdx >= 0 ? loadLiveFromFile(args[liveFileIdx + 1]) : await fetchLiveClusterSet();
  if (live.size === 0) {
    console.error('No live cluster URLs loaded — aborting (would map everything to the board).');
    process.exit(2);
  }

  const legacy = legacyClusterUrls(INDEXED);
  const map = {};
  let specific = 0;
  let board = 0;
  for (const oldUrl of legacy.sort()) {
    const body = nationalSlugBody(oldUrl);
    const national = body ? `/cerca-lavoro-svizzera/ricerca-${body}/` : null;
    if (national && live.has(national)) {
      map[oldUrl] = national;
      specific++;
    } else {
      const board404 = cantonBoard(oldUrl);
      if (board404) {
        map[oldUrl] = board404;
        board++;
      }
    }
  }

  const total = specific + board;
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        generated: 'see git author date',
        source: 'indexed-cluster-urls.json × live search-cluster sitemaps',
        counts: { total, specific, cantonBoardFallback: board },
        map,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `search-cluster-301-map: ${total} entries → ${specific} specific live clusters ` +
    `(${((100 * specific) / total).toFixed(1)}%), ${board} canton-board fallback.`,
  );
}

main();
