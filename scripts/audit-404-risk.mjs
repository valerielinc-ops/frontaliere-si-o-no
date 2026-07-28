#!/usr/bin/env node
/**
 * audit-404-risk.mjs
 *
 * Proactive "404-risk detector": find URLs/links that would return a GitHub
 * Pages 404 BEFORE a user (or a newsletter recipient) hits them.
 *
 * --------------------------------------------------------------------------
 * Why this exists (the proven incident)
 * --------------------------------------------------------------------------
 * 2026-06-09 the daily newsletter linked
 *     /de/jobs-im-tessin/azienda-eoc-ente-ospedaliero-cantonale
 * using the ITALIAN company-route prefix `azienda-`, but the real DE page is
 *     /de/jobs-im-tessin/unternehmen-eoc-ente-ospedaliero-cantonale
 * (the DE prefix is `unternehmen-`) → live 404. The bug lives in
 * `services/newsletter-content.mjs::companyPageUrl`, which hard-codes
 * `azienda-${slug}` for ALL four locales instead of using the localized
 * `companyRoutePrefix` map ({it:'azienda', en:'company', de:'unternehmen',
 * fr:'entreprise'}) that `build-plugins/jobsSeoPagesPlugin.ts` uses when it
 * EMITS the pages. The existing `validateJobUrls` only checks job-detail
 * slugs, never company-hub links, so nothing caught it.
 *
 * --------------------------------------------------------------------------
 * Architecture context (locale shards behind a Cloudflare Worker)
 * --------------------------------------------------------------------------
 * Non-primary locales are served from SEPARATE GitHub Pages repos:
 *   frontaliere-en / frontaliere-de / frontaliere-fr   (default branch `main`)
 * fronted by a Cloudflare Worker. So `/en /de /fr` URLs resolve via the
 * Worker → shard origins; `/assets /data /og` are proxied to
 * cdn.frontaliereticino.ch; everything else is the main repo.
 *
 * Since 2026-07-01 (PR #3177, TICINO_SHARD_LIVE=true) the Ticino job/company
 * section is carved out AGAIN, on top of the above: `cerca-lavoro-ticino`
 * (IT) and its `en/find-jobs-ticino` / `de/jobs-im-tessin` /
 * `fr/trouver-emploi-tessin` counterparts are stripped from the IT apex AND
 * from every locale shard's own tree, and pushed to FOUR MORE dedicated repos
 * `frontaliere-ticino-{it,en,de,fr}` (see SECTION_SHARD_REPOS below and
 * docs/TICINO-SHARD-RUNBOOK.md; svizzera/zurigo were added the same way,
 * generalized — see docs/SECTION-SHARD-RUNBOOK.md). Missing this union was
 * the root cause of
 * issue #3173 (19 real offenders on 2026-06-30 → thousands of false-positive
 * Ticino-section 404s from 2026-07-01 onward, once this script's served set
 * no longer matched what the locale-router Worker actually serves).
 *
 * Consequence for a STATIC check: the main repo's post-strip dist no longer
 * contains /en /de /fr, nor the Ticino subtree. To know the full SERVED set
 * you must UNION:
 *   - main IT pages  (from the live sitemap index, or local dist if present)
 *   - the three locale shard repos' file trees
 *   - the four Ticino shard repos' file trees.
 * A dist-only check on the main artifact would falsely flag every /en/de/fr
 * and every Ticino-section URL as missing. We list each shard tree with a
 * cheap blobless shallow clone (`git clone --filter=blob:none --no-checkout
 * --depth 1`), which returns the COMPLETE tree (the GitHub
 * `git/trees?recursive=1` API truncates above its entry cap and silently
 * under-reports — unusable here).
 *
 * Each emitted page is served as `<route>/index.html`, so a served route
 * `/de/jobs-im-tessin/x` maps to the tree entry `de/jobs-im-tessin/x/index.html`.
 *
 * --------------------------------------------------------------------------
 * What this MVP checks (highest-value 404 sources — the proven incidents)
 * --------------------------------------------------------------------------
 *   (A) SITEMAP COVERAGE — every `<loc>` in every child sitemap must resolve
 *       to a served path (main IT + shard trees). Catches shard-coverage
 *       gaps (a /de URL in the sitemap that the de shard never emitted).
 *   (B) NEWSLETTER HUB-LINK CORRECTNESS — re-derive the company-hub URL the
 *       newsletter builder (`companyPageUrl`) WOULD emit, for every locale,
 *       across a representative company sample, and verify each one exists in
 *       the served set. This directly reproduces the EOC incident: the
 *       `azienda-` form on /de/ is absent from the de shard → flagged.
 *
 * Both are checked STATICALLY (fast, no per-URL network) against the served
 * set. `--live` adds an HTTP confirmation probe of a small sample against the
 * public domain (which transparently routes through the Worker) — use it to
 * spot-check that the static served set matches reality.
 *
 * --------------------------------------------------------------------------
 * Reuses existing patterns (does NOT duplicate / does NOT lower any gate)
 * --------------------------------------------------------------------------
 *   - sitemap fetch + <loc> regex parse + path normalisation: same shape as
 *     scripts/audit-orphan-pages-in-sitemaps.mjs.
 *   - localized companyRoutePrefix / sectionByLocale: mirrors the SINGLE
 *     source of truth in build-plugins/jobsSeoPagesPlugin.ts. (The fix for
 *     the root-cause bug belongs in newsletter-content.mjs; this audit is the
 *     GATE that would have caught it.)
 *
 * --------------------------------------------------------------------------
 * CLI flags
 * --------------------------------------------------------------------------
 *   --no-shards        Skip cloning shard trees; treat any /en|/de|/fr URL as
 *                      "assumed served" (degrades (A)/(B) for shards to a
 *                      no-op). Use for a fast IT-only smoke run.
 *   --live[=N]         After the static check, HTTP-probe up to N offending
 *                      URLs (default 12) against https://frontaliereticino.ch
 *                      to confirm the 404. Network required.
 *   --sample=N         Company sample size for check (B) (default 200).
 *   --limit=N          Sample offending URLs printed per check (default 20).
 *   --json=<path>      Write a structured JSON report to <path>.
 *
 * Exit code: 0 when no would-be-404s are found, 1 otherwise (CI-ready).
 */

import { readFile, access, mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
// Exercise the REAL newsletter URL builder, not a frozen copy of the bug — so
// check (B) auto-resolves once companyPageUrl is fixed AND catches any future
// prefix/slug regression (the builder is the single source of truth).
// `companyHubUrlIfEmitted` + `buildCompanyHubSlugSet` are the production GATE
// (issue #3557): the raw `companyPageUrl` builds a URL for every company
// unconditionally, but the build only ever EMITS a hub page at this (Ticino
// board) URL for companies with >=1 active TI job — a non-TI-only company
// gets a *different* per-canton hub URL instead, never this one. Testing the
// ungated builder flagged companies the real newsletter never even links.
import {
  slugifyCompanyName,
  buildCompanyHubSlugSet,
  companyHubUrlIfEmitted,
} from '../services/newsletter-content.mjs';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const DATA_DIR = join(ROOT, 'data');
const HOST = 'https://frontaliereticino.ch';

// ── Locale routing maps — MIRROR build-plugins/jobsSeoPagesPlugin.ts ─────────
// Keep in lockstep with that file (the single emit-time source of truth).
const LOCALE_PREFIX = { it: '', en: '/en', de: '/de', fr: '/fr' };
const SECTION_BY_LOCALE = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};
const COMPANY_ROUTE_PREFIX = {
  it: 'azienda',
  en: 'company',
  de: 'unternehmen',
  fr: 'entreprise',
};
const SHARD_REPOS = {
  en: 'valerielinc-ops/frontaliere-en',
  de: 'valerielinc-ops/frontaliere-de',
  fr: 'valerielinc-ops/frontaliere-fr',
};

// Canton-section shards (issue #3173 root cause, added 2026-07-03; GENERALIZED
// 2026-07-19 from Ticino-only — see below). PR #3177 (2026-06-30) carved the
// Ticino job/company section out of the IT apex AND every en/de/fr locale
// shard into FOUR dedicated per-locale Pages repos (frontaliere-ticino-<loc>),
// gated by the `TICINO_SHARD_LIVE` repo variable (flipped true
// 2026-07-01T06:30Z — see docs/TICINO-SHARD-RUNBOOK.md). Once live,
// strip-section-subtree.sh removes the section's subtree from the apex and
// from every locale shard's own dist before push — the content is real and
// served (via the locale-router Worker → origin-<section>-<loc>), just no
// longer present in SHARD_REPOS' trees. This script's shard map was never
// updated in PR #3177 (post-deploy-validate-dist.yml's rehydrate step was, in
// the same PR — this was the missed sibling), so from 2026-07-01 onward EVERY
// Ticino-section en/de/fr page was a false-positive 404-risk (19 real
// offenders on 06-30 → 3581 false + real by 07-02). To not repeat that when a
// 3rd/4th section is added, this now reads section×locale from the SAME
// single-source-of-truth JSON the rest of the shard mechanism uses
// (scripts/lib/section-shard-slugs.json — shared with push-section-shard.sh /
// strip-section-subtree.sh / post-deploy-validate-dist.yml's rehydrate_section
// / locale-router.js's SECTION_ROUTES) instead of a second hardcoded copy, so
// a future section is covered automatically with no change here.
const SECTION_SLUGS = JSON.parse(
  readFileSync(join(ROOT, 'scripts/lib/section-shard-slugs.json'), 'utf8')
);
// Per-section GitHub owner override (default valerielinc-ops) — see
// scripts/lib/section-shard-owners.json header comment for why a section
// moves owner (stuck Pages cert on the default account). An entry is either a
// plain string (uniform owner for all 4 locales) or an object
// {default, <locale>} for a mixed per-locale owner (issue #4846).
const SECTION_OWNERS = JSON.parse(
  readFileSync(join(ROOT, 'scripts/lib/section-shard-owners.json'), 'utf8')
);
function sectionShardOwner(section, loc) {
  const entry = SECTION_OWNERS[section];
  if (entry && typeof entry === 'object') return entry[loc] || entry.default || 'valerielinc-ops';
  return entry || 'valerielinc-ops';
}
const SECTION_SHARD_REPOS = Object.fromEntries(
  Object.keys(SECTION_SLUGS)
    .filter((section) => !section.startsWith('_'))
    .map((section) => [
      section,
      Object.fromEntries(
        Object.keys(SECTION_SLUGS[section]).map((loc) => [
          loc,
          `${sectionShardOwner(section, loc)}/frontaliere-${section}-${loc}`,
        ])
      ),
    ])
);

// Degenerate-clone floor: a successful clone of a real locale shard returns
// hundreds of thousands of served pages, whereas an empty/partial tree (renamed
// repo, failed push, rate-limited clone) returns ≈0 → without the floor that
// near-zero count makes EVERY sitemap URL for the locale look unserved and
// poisons the report with tens of thousands of false 404s. The floor catches
// that. It is NOT an assertion that a shard must ALWAYS exceed it: an
// early-stage locale could legitimately sit below 1000, in which case a fixed
// floor would put the monitor permanently RED (alert fatigue → real 404s
// ignored). So the floor is overridable — globally via AUDIT_404_SHARD_FLOOR or
// per-locale via AUDIT_404_SHARD_FLOOR_<LOC> (e.g. AUDIT_404_SHARD_FLOOR_FR=0
// disables it for a brand-new fr shard) — without a code change. Same intent as
// the configurable `opts.floor` in scripts/lib/compat-paths-floor-guard.mjs
// (kept separate: that guard compares prev/next of an on-disk accumulator;
// this is a fresh-clone size check with no prior state to diff against).
const DEFAULT_SHARD_FLOOR = 1000;
function shardFloor(loc) {
  const raw = process.env[`AUDIT_404_SHARD_FLOOR_${loc.toUpperCase()}`]
    ?? process.env.AUDIT_404_SHARD_FLOOR;
  if (raw == null) return DEFAULT_SHARD_FLOOR;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHARD_FLOOR;
}
// Same floor guard, separate knobs, for the Ticino shards (~222k pages each per
// docs/TICINO-SHARD-RUNBOOK.md — degenerate-clone risk is identical to the
// locale shards, so reuse DEFAULT_SHARD_FLOOR unless overridden).
function sectionShardFloor(section, loc) {
  const sectionUpper = section.toUpperCase();
  const raw = process.env[`AUDIT_404_${sectionUpper}_SHARD_FLOOR_${loc.toUpperCase()}`]
    ?? process.env[`AUDIT_404_${sectionUpper}_SHARD_FLOOR`];
  if (raw == null) return DEFAULT_SHARD_FLOOR;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHARD_FLOOR;
}

// ── CLI args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = new Map();
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? true);
  }
}
const NO_SHARDS = args.has('no-shards');
const LIVE = args.has('live');
const LIVE_N = LIVE ? Number(args.get('live') === true ? 12 : args.get('live')) : 0;
const SAMPLE = Number(args.get('sample') ?? 200);
const LIMIT = Number(args.get('limit') ?? 20);
const JSON_OUT = args.get('json')
  ? (isAbsolute(String(args.get('json'))) ? String(args.get('json')) : join(ROOT, String(args.get('json'))))
  : null;

const log = (...m) => process.stderr.write(m.join(' ') + '\n');

// ── HTTPS GET with timeout + one-redirect-follow (stdlib only) ───────────────
function fetchText(url, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'audit-404-risk/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout fetching ${url}`)));
  });
}

function headStatus(url, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'audit-404-risk/1.0' } }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(-1));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(-1); });
    req.end();
  });
}

// ── Path normalisation: strip host, fragment, query, trailing slash ──────────
function normPath(input) {
  let p;
  try {
    p = new URL(input, HOST).pathname;
  } catch {
    p = String(input).split('#')[0].split('?')[0];
  }
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function localeOf(path) {
  if (path.startsWith('/en/') || path === '/en') return 'en';
  if (path.startsWith('/de/') || path === '/de') return 'de';
  if (path.startsWith('/fr/') || path === '/fr') return 'fr';
  return 'it';
}

// ── extract <loc> entries from a sitemap (non-validating regex) ──────────────
function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

// ── Served-path set construction ─────────────────────────────────────────────
// A served path is the route a user hits, normalised (no trailing slash). For
// shard trees, the file entry `<route>/index.html` (or `<route>.html`) yields
// the route `/<route>`.
function treeEntryToRoute(entry) {
  // entry e.g. "de/jobs-im-tessin/x/index.html" → "/de/jobs-im-tessin/x"
  //            "de.html"                          → "/de"
  let e = entry.replace(/\/index\.html$/i, '');
  if (e.endsWith('.html')) e = e.slice(0, -'.html'.length);
  return normPath('/' + e);
}

// Returns the list of tracked file paths, or `null` if the repo has no
// commits yet (a genuinely empty repo — e.g. a section shard repo freshly
// `gh repo create`d but not yet seeded by the first push-section-shard.sh
// run). That's NOT a degenerate clone: the section's content is simply still
// served from wherever it hasn't been stripped from yet, so callers that can
// tolerate a not-yet-seeded shard should treat `null` as "0 pages, skip the
// floor check" rather than a failure. Any other clone/list error still
// throws (auth, network, wrong repo name — real problems).
// Bounded-concurrency mapper — mirrors the MAX_PARALLEL=4 cap used for
// section-shard push/pack/rehydrate elsewhere in the pipeline (conservative
// margin against runner disk/network limits when fanning out across up to
// ~27 sections x 4 locales of `git clone`).
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function listShardTree(repo) {
  const dir = await mkdtemp(join(tmpdir(), 'audit404-'));
  try {
    await execFileP('git', [
      'clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--quiet',
      `https://github.com/${repo}.git`, dir,
    ], { maxBuffer: 64 * 1024 * 1024 });
    try {
      const { stdout } = await execFileP('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], {
        maxBuffer: 256 * 1024 * 1024,
      });
      return stdout.split('\n').filter(Boolean);
    } catch (err) {
      if (/Not a valid object name HEAD/.test(String(err.stderr || err.message || ''))) return null;
      throw err;
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Local-dist fallback for main IT pages (used only if dist/ exists with HTML).
async function listDistRoutes() {
  const routes = new Set();
  async function walk(dir, rel) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(abs, r);
      else if (ent.name.endsWith('.html')) routes.add(treeEntryToRoute(r));
    }
  }
  try {
    const s = await stat(DIST);
    if (!s.isDirectory()) return null;
  } catch { return null; }
  await walk(DIST, '');
  return routes.size >= 10 ? routes : null;
}

async function buildServedSet() {
  const served = new Set();
  const meta = { shards: {}, sectionShards: {}, itSource: null, distRoutes: 0 };

  // Main IT routes: prefer local dist; else use the live IT sitemap <loc>s.
  const distRoutes = await listDistRoutes();
  if (distRoutes) {
    meta.itSource = 'local-dist';
    meta.distRoutes = distRoutes.size;
    for (const r of distRoutes) served.add(r);
  } else {
    meta.itSource = 'live-sitemap';
  }

  // Shard routes: clone each shard tree (unless --no-shards).
  if (!NO_SHARDS) {
    for (const [loc, repo] of Object.entries(SHARD_REPOS)) {
      log(`[404] listing ${loc} shard tree (${repo}) …`);
      // These locale shards must ALWAYS have content (unlike section shards
      // below) — a `null` here (empty repo) is exactly as bad as n=0 from a
      // truncated tree, so it flows into the same floor check rather than a
      // silent skip.
      const entries = (await listShardTree(repo)) ?? [];
      let n = 0;
      for (const e of entries) {
        if (!/\.html$/i.test(e)) continue;
        served.add(treeEntryToRoute(e));
        n++;
      }
      const floor = shardFloor(loc);
      meta.shards[loc] = n;
      log(`[404]   ${loc}: ${n} served pages (floor ${floor})`);
      // Fail loud on a degenerate clone (renamed repo, failed push, rate-limit
      // returning an empty/partial tree). Without this, n≈0 makes EVERY sitemap
      // URL for that locale look unserved → a report poisoned with tens of
      // thousands of false 404s. See shardFloor() for why the floor is
      // overridable (legitimately-small early-stage shard ≠ broken clone).
      if (n < floor) {
        throw new Error(`shard ${loc} (${repo}) returned only ${n} pages (< floor ${floor}) — degenerate clone, refusing to emit a poisoned report. If this locale is legitimately smaller than the floor, lower it via AUDIT_404_SHARD_FLOOR_${loc.toUpperCase()} (or AUDIT_404_SHARD_FLOOR).`);
      }
    }

    // Canton-section shards (Ticino/Svizzera/Zurigo, issue #3173): additive to
    // the locale shards above, NOT a replacement — once a section's
    // `<SECTION>_SHARD_LIVE` flips, its subtree is stripped out of the IT apex
    // and out of every en/de/fr locale shard, so without this loop every page
    // in that section looks unserved even though it's live on
    // frontaliere-<section>-<loc>. See SECTION_SHARD_REPOS comment.
    for (const section of Object.keys(SECTION_SHARD_REPOS)) {
      meta.sectionShards[section] = {};
    }
    const shardTasks = Object.entries(SECTION_SHARD_REPOS).flatMap(([section, repos]) =>
      Object.entries(repos).map(([loc, repo]) => ({ section, loc, repo })),
    );
    // Bounded concurrency (MAX_PARALLEL=4, same cap as the push/pack/rehydrate
    // loops this mirrors): up to ~27 sections x 4 locales of `git clone` run
    // one-at-a-time here used to be the slow path this audit shares with the
    // deploy pipeline it audits.
    await mapPool(shardTasks, 4, async ({ section, loc, repo }) => {
      log(`[404] listing ${loc} ${section} shard tree (${repo}) …`);
      const entries = await listShardTree(repo);
      if (entries === null) {
        // Genuinely empty repo (no commits) — this section isn't seeded/
        // live yet (e.g. a new section between `gh repo create` and its
        // first push-section-shard.sh run). Its content is still fully
        // served from wherever it hasn't been stripped from, so this
        // contributes 0 pages with NO floor check — not a degenerate-clone
        // regression. See listShardTree()'s doc comment.
        meta.sectionShards[section][loc] = null;
        log(`[404]   ${section}-${loc}: not seeded yet (empty repo) — skipping`);
        return;
      }
      let n = 0;
      for (const e of entries) {
        if (!/\.html$/i.test(e)) continue;
        served.add(treeEntryToRoute(e));
        n++;
      }
      const floor = sectionShardFloor(section, loc);
      meta.sectionShards[section][loc] = n;
      log(`[404]   ${section}-${loc}: ${n} served pages (floor ${floor})`);
      // Same degenerate-clone guard as the locale shards above — a renamed
      // repo / failed push / rate-limited clone must fail loud, not
      // silently report tens of thousands of false section-scoped 404s.
      if (n < floor) {
        throw new Error(`${section} shard ${loc} (${repo}) returned only ${n} pages (< floor ${floor}) — degenerate clone, refusing to emit a poisoned report. If this is expected (e.g. ${section.toUpperCase()}_SHARD_LIVE rolled back), lower it via AUDIT_404_${section.toUpperCase()}_SHARD_FLOOR_${loc.toUpperCase()} (or AUDIT_404_${section.toUpperCase()}_SHARD_FLOOR).`);
      }
    });
  }
  return { served, meta };
}

// Membership test that tolerates the IT-from-sitemap and no-shards modes.
function makeResolver(served, meta) {
  return (path) => {
    const loc = localeOf(path);
    // IT, when we only have the live sitemap (no dist): the sitemap IS the IT
    // served set, so IT-sitemap members resolve by construction; we cannot
    // independently disprove an IT path, so treat IT as resolvable here and
    // rely on (B)/live for IT link checks.
    if (loc === 'it' && meta.itSource === 'live-sitemap' && meta.distRoutes === 0) {
      return true; // IT path not independently disprovable without local dist
    }
    if (NO_SHARDS && loc !== 'it') return true; // shards skipped → can't disprove
    return served.has(path);
  };
}

// ── Company sample for check (B): real companies from the jobs dataset ───────
// Returns both the company sample AND the full jobs array — the latter feeds
// `buildCompanyHubSlugSet(jobs)` so check (B) can gate on the same TI-only
// allow-set the real newsletter builder uses (issue #3557).
async function loadCompanySample(limit) {
  // Try assembled jobs dataset, then a few known fallbacks. Each entry → a
  // company display name; we only need a representative spread of slugs.
  const candidates = [
    join(DIST, 'data', 'jobs.json'),
    join(ROOT, 'public', 'data', 'jobs.json'),
    join(DATA_DIR, 'jobs.json'),
  ];
  let jobs = null;
  for (const p of candidates) {
    try {
      await access(p);
      const raw = JSON.parse(await readFile(p, 'utf8'));
      jobs = Array.isArray(raw) ? raw : (Array.isArray(raw?.jobs) ? raw.jobs : null);
      if (jobs) break;
    } catch { /* try next */ }
  }
  const names = new Set();
  if (jobs) {
    for (const j of jobs) {
      const c = j && (j.company || j.companyName);
      if (c) names.add(String(c));
      if (names.size >= limit) break;
    }
  }
  // Slug via the SAME function the real builder uses (slugifyCompanyName), so
  // the URL we test matches what the newsletter actually emits.
  // Always include the proven-incident company so the gate self-tests (EOC is
  // a real, currently-active TI employer, so it passes the TI-only gate below).
  names.add('EOC Ente Ospedaliero Cantonale');
  const companies = [...names].map((name) => ({ name, slug: slugifyCompanyName(name) })).filter((c) => c.slug);
  return { companies, jobs: jobs || [] };
}

// The path the REAL newsletter builder emits for a company hub, for the given
// locale — gated through the SAME TI-only allow-set (`emittedSlugs`) the real
// newsletter uses, so a company the builder never links (e.g. a non-TI-only
// company, issue #3557) isn't flagged as a would-be-404: there is no link to
// begin with. Returns '' when the builder emits no link at all.
function builderHubPath(name, locale, emittedSlugs) {
  const url = companyHubUrlIfEmitted(name, locale, emittedSlugs);
  return url ? normPath(url) : '';
}
// The locally-correct localized form, used only for a human-readable hint in the
// report (the offender DETECTION above is driven by the real builder).
function expectedHubPath(slug, locale) {
  const board = `${LOCALE_PREFIX[locale]}/${SECTION_BY_LOCALE[locale]}`.replace(/^\//, '');
  return normPath(`/${board}/${COMPANY_ROUTE_PREFIX[locale]}-${slug}`);
}

// ───────────────────────────────────────────────────────────────────────────
async function main() {
  log('[404] building served-path set (main IT + shards) …');
  const { served, meta } = await buildServedSet();
  const resolves = makeResolver(served, meta);
  log(`[404] served set: ${served.size} paths | IT source: ${meta.itSource} | shards: ${JSON.stringify(meta.shards)} | section shards: ${JSON.stringify(meta.sectionShards)}`);

  const report = {
    generatedAt: new Date().toISOString(),
    servedSetSize: served.size,
    meta,
    checks: {},
  };

  // ── (A) SITEMAP COVERAGE ───────────────────────────────────────────────
  log('[404] (A) sitemap coverage — fetching sitemap index …');
  let sitemapOffenders = [];
  let sitemapTotal = 0;
  try {
    const indexXml = await fetchText(`${HOST}/sitemap.xml`);
    const children = extractLocs(indexXml).filter((u) => /\.xml(\?|$)/i.test(u));
    for (const child of children) {
      let xml;
      try { xml = await fetchText(child); } catch (e) { log(`[404]   WARN sitemap ${child}: ${e.message}`); continue; }
      for (const loc of extractLocs(xml)) {
        if (/\.xml(\?|$)/i.test(loc)) continue; // nested index, already followed
        const p = normPath(loc);
        sitemapTotal++;
        if (!resolves(p)) sitemapOffenders.push(p);
      }
    }
  } catch (e) {
    // Fail loud: a sitemap-index fetch failure means check (A) couldn't run.
    // Silently reporting 0/0 (+ (B)=0 post-fix) would exit green on a broken run
    // — the same "silently green" trap the shard floor guards against.
    log(`[404]   FATAL: sitemap index fetch failed: ${e.message}`);
    process.exit(2);
  }
  report.checks.sitemapCoverage = {
    totalUrls: sitemapTotal,
    wouldBe404: sitemapOffenders.length,
    sample: sitemapOffenders.slice(0, LIMIT),
  };

  // ── (B) NEWSLETTER HUB-LINK CORRECTNESS ────────────────────────────────
  log('[404] (B) newsletter hub-link correctness …');
  const { companies, jobs } = await loadCompanySample(SAMPLE);
  // TI-only allow-set the real newsletter gates company-hub links through
  // (issue #3557) — a company outside this set gets NO link at all, so it's
  // not a would-be-404, it's correctly-absent.
  const emittedSlugs = buildCompanyHubSlugSet(jobs);
  const hubOffenders = [];
  for (const { name, slug } of companies) {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const url = builderHubPath(name, locale, emittedSlugs); // what the REAL builder emits (TI-gated)
      if (!url) continue; // builder emits no link for this company/locale — correctly gated, nothing to 404-check
      if (!resolves(url)) {
        const expected = expectedHubPath(slug, locale);
        hubOffenders.push({
          company: name,
          locale,
          builderUrl: url,
          expectedUrl: expected,
          reason: expected !== url
            ? `builder emits wrong locale prefix → expected '${COMPANY_ROUTE_PREFIX[locale]}-'`
            : 'hub page not present in served set',
        });
      }
    }
  }
  report.checks.newsletterHubLinks = {
    companiesSampled: companies.length,
    wouldBe404: hubOffenders.length,
    sample: hubOffenders.slice(0, LIMIT),
  };

  // ── (live) optional HTTP confirmation of a small offender sample ────────
  if (LIVE) {
    log(`[404] (live) probing up to ${LIVE_N} offending URLs against ${HOST} …`);
    const probe = [
      ...sitemapOffenders.slice(0, Math.ceil(LIVE_N / 2)),
      ...hubOffenders.slice(0, Math.floor(LIVE_N / 2)).map((o) => o.builderUrl),
    ].slice(0, LIVE_N);
    const live = [];
    for (const p of probe) {
      const code = await headStatus(`${HOST}${p}/`);
      live.push({ path: p, status: code });
      log(`[404]   ${code}  ${p}`);
    }
    report.checks.liveProbe = live;
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const a = report.checks.sitemapCoverage;
  const b = report.checks.newsletterHubLinks;
  const total404 = a.wouldBe404 + b.wouldBe404;

  process.stdout.write('\n=== 404-RISK AUDIT ===\n');
  process.stdout.write(`served set: ${served.size} paths (IT: ${meta.itSource}; shards: ${JSON.stringify(meta.shards)}; section shards: ${JSON.stringify(meta.sectionShards)})\n\n`);
  process.stdout.write(`(A) Sitemap coverage:       ${a.wouldBe404} / ${a.totalUrls} URLs would 404\n`);
  for (const u of a.sample) process.stdout.write(`      ✗ ${u}\n`);
  process.stdout.write(`\n(B) Newsletter hub links:   ${b.wouldBe404} would 404 (${b.companiesSampled} companies × 4 locales)\n`);
  for (const o of b.sample) process.stdout.write(`      ✗ [${o.locale}] ${o.builderUrl}  →  expected ${o.expectedUrl}  (${o.reason})\n`);
  process.stdout.write(`\nTOTAL would-be-404s: ${total404}\n`);

  if (JSON_OUT) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(JSON_OUT, JSON.stringify(report, null, 2));
    log(`[404] wrote report → ${JSON_OUT}`);
  }

  if (total404 > 0) {
    process.stdout.write('\n❌ would-be-404s detected — failing.\n');
    process.exit(1);
  }
  process.stdout.write('\n✅ no would-be-404s detected.\n');
}

main().catch((e) => {
  log(`[404] FATAL: ${e.stack || e.message}`);
  process.exit(2);
});
