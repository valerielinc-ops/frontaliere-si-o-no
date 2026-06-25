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

// ── City → canton job-board page targeting ──────────────────────────────────
// A legacy orphan that does NOT map to a specific live cluster (e.g. a junk-led
// "progetti morges" / "compiti solothurn" whose only real signal is the city)
// still has a great live home: the per-city job page /cerca-lavoro-<canton>/<city>/
// ("Lavoro Morges — 48 offerte"). The orphan URL's own canton is unreliable
// (these national clusters were ALL emitted under the legacy /cerca-lavoro-ticino/
// section regardless of the real city), so we resolve the city → its REAL canton
// from data/canton-municipalities.json, not from the URL.
const MUNI = JSON.parse(readFileSync(resolve(ROOT, 'data/canton-municipalities.json'), 'utf8'));
const CANTON_SLUGS = JSON.parse(readFileSync(resolve(ROOT, 'data/canton-url-slugs.json'), 'utf8'));
// Half-canton URL-group merges (mirrors canton-url-slugs.json note).
const CANTON_URL_GROUP = { AI: 'APPENZELLO', AR: 'APPENZELLO', BL: 'BASILEA', BS: 'BASILEA' };

function normalizeCitySlug(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// municipality-slug → IT canton-board slug (e.g. "morges" → "vaud").
const cityToCantonSlug = new Map();
for (const [code, obj] of Object.entries(MUNI.cantons || {})) {
  const groupCode = CANTON_URL_GROUP[code] || code;
  const cantonSlug = CANTON_SLUGS.cantons?.[groupCode]?.it || CANTON_SLUGS.cantons?.[code]?.it;
  if (!cantonSlug) continue;
  for (const m of obj.municipalities || []) {
    const slug = normalizeCitySlug(m);
    if (slug && !cityToCantonSlug.has(slug)) cityToCantonSlug.set(slug, cantonSlug);
  }
}

// Longest trailing municipality-slug in a hyphen-joined body ("progetti-morges"
// → "morges"; "compiti-wil-sg" → "wil-sg").
function detectTrailingCity(body) {
  if (!body) return null;
  const toks = body.split('-').filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const cand = toks.slice(i).join('-');
    if (cityToCantonSlug.has(cand)) return cand;
  }
  return null;
}

// Generation-time liveness check (cached). City pages are 200 but not in any
// enumerable sitemap, so verify per-URL; a miss falls back to the canton board.
const liveCache = new Map();
async function isLive(pathUrl) {
  if (liveCache.has(pathUrl)) return liveCache.get(pathUrl);
  let ok = false;
  try {
    const res = await fetch(`${BASE}${pathUrl}`, { method: 'GET', redirect: 'manual' });
    ok = res.status === 200;
  } catch {
    ok = false;
  }
  liveCache.set(pathUrl, ok);
  return ok;
}

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

  const verifyCity = !args.includes('--no-city-verify');
  const legacy = legacyClusterUrls(INDEXED);
  const map = {};
  let specific = 0;
  let cityPage = 0;
  let cityBoard = 0;
  let urlBoard = 0;
  for (const oldUrl of legacy.sort()) {
    const body = nationalSlugBody(oldUrl);

    // 1) Specific live national cluster (de-junked role+city), best relevance.
    const national = body ? `/cerca-lavoro-svizzera/ricerca-${body}/` : null;
    if (national && live.has(national)) {
      map[oldUrl] = national;
      specific++;
      continue;
    }

    // 2) City detected in the slug → the per-city job page in the city's REAL
    //    canton (e.g. "progetti morges" → /cerca-lavoro-vaud/morges/). Verified
    //    live per-URL (city pages are 200 but not sitemap-enumerable).
    const rawBody = (oldUrl.match(/\/ricerca-(.+?)\/?$/)?.[1] || '').replace(/-svizzera$/, '');
    const city = detectTrailingCity(body) || detectTrailingCity(rawBody);
    if (city) {
      const cantonSlug = cityToCantonSlug.get(city);
      const cityUrl = `/cerca-lavoro-${cantonSlug}/${city}/`;
      if (verifyCity && (await isLive(cityUrl))) {
        map[oldUrl] = cityUrl;
        cityPage++;
        continue;
      }
      // 3) City's REAL canton board (fixes the legacy ticino-prefix mislabel).
      map[oldUrl] = `/cerca-lavoro-${cantonSlug}/`;
      cityBoard++;
      continue;
    }

    // 4) No city signal (role-only national cluster, no live specific page) →
    //    the national board. NOT the URL's own canton: every legacy orphan
    //    carries the misleading /cerca-lavoro-ticino/ prefix, so the national
    //    "Lavoro in Svizzera" board is the honest generic home.
    map[oldUrl] = '/cerca-lavoro-svizzera/';
    urlBoard++;
  }

  const total = specific + cityPage + cityBoard + urlBoard;
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        generated: 'see git author date',
        source: 'indexed-cluster-urls.json × live search-cluster sitemaps + per-city job pages',
        counts: { total, specific, cityPage, cityCantonBoard: cityBoard, urlCantonBoard: urlBoard },
        map,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `search-cluster-301-map: ${total} entries → ${specific} specific clusters ` +
    `(${((100 * specific) / total).toFixed(1)}%), ${cityPage} per-city pages, ` +
    `${cityBoard} city-canton boards, ${urlBoard} url-canton boards.`,
  );
}

main();
