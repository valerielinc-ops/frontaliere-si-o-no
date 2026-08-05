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
// moves owner (stuck Pages cert on the default account).
const SECTION_OWNERS = JSON.parse(
  readFileSync(join(ROOT, 'scripts/lib/section-shard-owners.json'), 'utf8')
);
const SECTION_SHARD_REPOS = Object.fromEntries(
  Object.keys(SECTION_SLUGS)
    .filter((section) => !section.startsWith('_'))
    .map((section) => [
      section,
      Object.fromEntries(
        Object.keys(SECTION_SLUGS[section]).map((loc) => [
          loc,
          `${SECTION_OWNERS[section] || 'valerielinc-ops'}/frontaliere-${section}-${loc}`,
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

// ── Deploy-generation provenance (issue #4079) ──────────────────────────────
// Every shard push stamps the SOURCE repo's commit into its own commit
// subject: push-section-shard.sh writes "<section>-<loc> shard <sha8> (run
// <run_id>)" and push-locale-shard.sh writes "locale shard <loc> <sha8> (run
// <run_id>)". The apex publishes the same commit as /commit-hash.txt. That
// pair is what lets this audit tell "this URL has no page" apart from "these
// two snapshots are from different deploys" — see resolveApexGeneration().
const SHA8_IN_SUBJECT = /\b([0-9a-f]{8})\b/;

function shaFromSubject(subject) {
  const m = SHA8_IN_SUBJECT.exec(String(subject || ''));
  return m ? m[1] : null;
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
      const entries = stdout.split('\n').filter(Boolean);
      // Free: the commit is already local from the --depth 1 clone.
      let generation = null;
      try {
        const { stdout: head } = await execFileP('git', ['-C', dir, 'log', '-1', '--format=%s%x09%cI'], {
          maxBuffer: 1024 * 1024,
        });
        const [subject, at] = head.trim().split('\t');
        generation = { sha: shaFromSubject(subject), at: at || null, subject: (subject || '').slice(0, 120) };
      } catch { /* provenance is best-effort — absence downgrades to "cannot classify" */ }
      return { entries, generation };
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
  const meta = {
    shards: {},
    sectionShards: {},
    itSource: null,
    distRoutes: 0,
    // Filled below: which deploy each side of the comparison came from.
    generation: { apexSha: null, shards: {}, sectionShards: {} },
  };

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
      const result = await listShardTree(repo);
      const entries = result?.entries ?? [];
      meta.generation.shards[loc] = result?.generation ?? null;
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
      meta.generation.sectionShards[section] = {};
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
      const result = await listShardTree(repo);
      const entries = result === null ? null : result.entries;
      meta.generation.sectionShards[section][loc] = result?.generation ?? null;
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

// ── Publish-generation classification (issue #4079) ─────────────────────────
//
// WHY THIS EXISTS. This audit compares the LIVE apex sitemap against the LIVE
// shard repos' git trees. Those are two DIFFERENT publication channels with
// different latencies: a shard goes live the instant push-section-shard.sh
// force-pushes it, while the apex sitemap only goes live once
// deploy-publish.yml's `actions/deploy-pages` finishes. The deploy is not
// atomic across ~110 repos, so at any given moment the two sides can be from
// different deploys — and then a URL "missing" from a shard tree is not
// evidence of a 404, it is evidence of a snapshot skew this audit cannot see.
//
// Measured (2026-08-05), five consecutive daily runs: 32 · 0 · 0 · 97 · 0
// offenders, ZERO of them persisting into the next run, and 5/5 sampled
// offenders from the 97-offender run returning HTTP 200 live. The 32-offender
// run (2026-08-01) was ENTIRELY `…/2026-07` month-scoped URLs — a July
// sitemap measured against August shard trees, which is the skew signature in
// its purest form.
//
// So the offenders are classified, not suppressed: every one is still listed
// in the report and in the issue body. What changes is which ones FAIL the
// audit — only those whose owning shard is from the same deploy as the
// sitemap, i.e. the ones where "no served page" is a sound conclusion. A
// URL attributed to an off-generation shard is a measurement artifact, and
// reporting it as a silent 404 is what made this issue unactionable enough to
// be parked `needs-human` after six recurrences.
//
// This is strictly MORE information, never less: nothing is hidden, and the
// per-shard generation table now surfaces publish drift the audit previously
// could not see at all.

// Route prefix → owning section shard, from the same single source of truth
// the shard mechanism itself uses (section-shard-slugs.json).
const SECTION_BY_ROUTE_PREFIX = new Map();
for (const [section, byLoc] of Object.entries(SECTION_SLUGS)) {
  if (section.startsWith('_')) continue;
  for (const [loc, slug] of Object.entries(byLoc)) {
    if (!slug) continue;
    SECTION_BY_ROUTE_PREFIX.set(loc === 'it' ? `/${slug}` : `/${loc}/${slug}`, { section, loc });
  }
}

/** Which repo actually serves this path: a section shard, a locale shard, or the apex. */
function shardOwnerOf(path) {
  const loc = localeOf(path);
  const segs = path.split('/').filter(Boolean);
  const prefix = loc === 'it' ? `/${segs[0] ?? ''}` : `/${segs[0] ?? ''}/${segs[1] ?? ''}`;
  const section = SECTION_BY_ROUTE_PREFIX.get(prefix);
  if (section) return { kind: 'section', section: section.section, loc };
  if (loc !== 'it') return { kind: 'locale', loc };
  return { kind: 'apex', loc };
}

function ownerGeneration(owner, gen) {
  if (owner.kind === 'section') return gen.sectionShards?.[owner.section]?.[owner.loc] ?? null;
  if (owner.kind === 'locale') return gen.shards?.[owner.loc] ?? null;
  return null;
}

/**
 * 'unserved'     — the owning shard is from the SAME deploy as the sitemap, so
 *                  the page really is absent. This is what fails the audit.
 * 'publish-skew' — the owning shard is from a DIFFERENT deploy, so the two
 *                  sides are not comparable for this URL.
 *
 * Every ambiguity resolves to 'unserved': no apex sha, no shard provenance,
 * an apex-owned path — all keep today's behaviour rather than quietly
 * excusing an offender.
 */
function classifyOffender(path, gen) {
  if (!gen?.apexSha) return 'unserved';
  const owner = shardOwnerOf(path);
  if (owner.kind === 'apex') return 'unserved';
  const g = ownerGeneration(owner, gen);
  if (!g || !g.sha) return 'unserved';
  return gen.apexSha.startsWith(g.sha) ? 'unserved' : 'publish-skew';
}

function splitByGeneration(paths, gen) {
  const unserved = [];
  const skew = [];
  for (const p of paths) (classifyOffender(p, gen) === 'unserved' ? unserved : skew).push(p);
  return { unserved, skew };
}

// A shard that is merely off-generation is a transient: the deploy is still
// in flight. A shard that has not been pushed for this long has stopped
// publishing, and deferring its URLs forever would be exactly the silent skip
// this classification must not become. Deploys run every ~2.5 h, so 24 h is
// ~10 missed deploys. push-section-shard.sh only skips a push when the tree is
// byte-identical to the remote, which for a job-board shard does not survive a
// day. Overridable for a deliberately-frozen shard.
const SHARD_MAX_AGE_H = Number(process.env.AUDIT_404_SHARD_MAX_AGE_H ?? 24);

/** Flatten the per-shard generation table into a compact, reportable summary. */
function generationSummary(gen, now = Date.now()) {
  const rows = [];
  for (const [loc, g] of Object.entries(gen.shards || {})) {
    rows.push({ shard: `locale-${loc}`, sha: g?.sha ?? null, at: g?.at ?? null });
  }
  for (const [section, byLoc] of Object.entries(gen.sectionShards || {})) {
    for (const [loc, g] of Object.entries(byLoc || {})) {
      // A not-yet-seeded shard has no commit at all — that is already covered
      // by the section floor logic, not a stale-publish signal.
      if (g === null && byLoc[loc] === null) continue;
      rows.push({ shard: `${section}-${loc}`, sha: g?.sha ?? null, at: g?.at ?? null });
    }
  }
  const isSame = (r) => Boolean(r.sha && gen.apexSha && gen.apexSha.startsWith(r.sha));
  const ageH = (r) => (r.at ? (now - Date.parse(r.at)) / 3_600_000 : null);
  const offGeneration = rows.filter((r) => !isSame(r));
  return {
    apexSha: gen.apexSha,
    maxAgeHours: SHARD_MAX_AGE_H,
    shardsTotal: rows.length,
    shardsSameGeneration: rows.length - offGeneration.length,
    offGeneration: offGeneration
      .map((r) => ({ shard: r.shard, sha: r.sha, at: r.at, ageHours: ageH(r) }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at))),
    // Off-generation AND not pushed for longer than the window: this shard has
    // stopped publishing. Incident 2026-07-30: uri-it failed on every deploy
    // for 3 days behind a `::warning::` inside a green run, and this audit had
    // no way to see it.
    staleShards: offGeneration
      .filter((r) => {
        const h = ageH(r);
        return h !== null && h > SHARD_MAX_AGE_H;
      })
      .map((r) => ({ shard: r.shard, sha: r.sha, at: r.at, ageHours: Math.round(ageH(r)) }))
      .sort((a, b) => b.ageHours - a.ageHours),
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
  // Which deploy the sitemap side of the comparison came from. Published by
  // the same build that publishes the sitemap, so this is the reference the
  // shard stamps are compared against. Best-effort: on failure every offender
  // stays classified 'unserved', i.e. exactly today's behaviour.
  try {
    meta.generation.apexSha = (await fetchText(`${HOST}/commit-hash.txt`)).trim().toLowerCase() || null;
    log(`[404] apex generation: ${meta.generation.apexSha}`);
  } catch (e) {
    log(`[404]   WARN could not read ${HOST}/commit-hash.txt (${e.message}) — every offender will be reported as unserved`);
  }
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
  const sitemapSplit = splitByGeneration(sitemapOffenders, meta.generation);
  report.checks.publishGeneration = generationSummary(meta.generation);
  report.checks.sitemapCoverage = {
    totalUrls: sitemapTotal,
    // Only same-generation offenders are a sound "no served page" verdict —
    // see classifyOffender()'s comment for the measurement behind this.
    wouldBe404: sitemapSplit.unserved.length,
    sample: sitemapSplit.unserved.slice(0, LIMIT),
    // Reported, never suppressed: these are the URLs whose owning shard is
    // from a different deploy than the sitemap.
    publishSkew: sitemapSplit.skew.length,
    publishSkewSample: sitemapSplit.skew.slice(0, LIMIT),
    offendersBeforeGenerationSplit: sitemapOffenders.length,
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
  // Same generation split as (A) — a company hub on an off-generation shard is
  // the identical measurement artifact.
  const hubUnserved = [];
  const hubSkew = [];
  for (const o of hubOffenders) {
    (classifyOffender(o.builderUrl, meta.generation) === 'unserved' ? hubUnserved : hubSkew).push(o);
  }
  report.checks.newsletterHubLinks = {
    companiesSampled: companies.length,
    wouldBe404: hubUnserved.length,
    sample: hubUnserved.slice(0, LIMIT),
    publishSkew: hubSkew.length,
    publishSkewSample: hubSkew.slice(0, LIMIT),
    offendersBeforeGenerationSplit: hubOffenders.length,
  };

  // ── (live) optional HTTP confirmation of a small offender sample ────────
  if (LIVE) {
    log(`[404] (live) probing up to ${LIVE_N} offending URLs against ${HOST} …`);
    // Probe the SOUND offenders first — those are the ones a live 404 would
    // confirm; skew candidates fill any remaining budget.
    const probe = [
      ...sitemapSplit.unserved.slice(0, Math.ceil(LIVE_N / 2)),
      ...hubUnserved.slice(0, Math.floor(LIVE_N / 2)).map((o) => o.builderUrl),
      ...sitemapSplit.skew,
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
  // A shard that stopped publishing is a real, currently-invisible outage —
  // and it is also what stops the publish-skew deferral from being open-ended.
  const staleCount = report.checks.publishGeneration.staleShards.length;

  const g = report.checks.publishGeneration;

  process.stdout.write('\n=== 404-RISK AUDIT ===\n');
  process.stdout.write(`served set: ${served.size} paths (IT: ${meta.itSource}; shards: ${JSON.stringify(meta.shards)}; section shards: ${JSON.stringify(meta.sectionShards)})\n`);
  process.stdout.write(`publish generation: apex ${g.apexSha ?? 'UNKNOWN'} · ${g.shardsSameGeneration}/${g.shardsTotal} shards on the same deploy\n`);
  if (g.offGeneration.length) {
    process.stdout.write('  shards on a different deploy than the sitemap (their URLs are not comparable this run):\n');
    for (const r of g.offGeneration.slice(0, LIMIT)) {
      process.stdout.write(`      · ${r.shard}  ${r.sha ?? '(no stamp)'}  ${r.at ?? ''}\n`);
    }
  }
  if (g.staleShards.length) {
    process.stdout.write(`\n(C) Stale shards:           ${g.staleShards.length} shard(s) have not published for > ${g.maxAgeHours}h\n`);
    for (const r of g.staleShards) {
      process.stdout.write(`      ✗ ${r.shard} last pushed ${r.at} (${r.ageHours}h ago, stamp ${r.sha ?? 'none'})\n`);
    }
  }
  process.stdout.write(`\n(A) Sitemap coverage:       ${a.wouldBe404} / ${a.totalUrls} URLs would 404\n`);
  for (const u of a.sample) process.stdout.write(`      ✗ ${u}\n`);
  if (a.publishSkew) {
    process.stdout.write(`    + ${a.publishSkew} URL(s) on an off-generation shard — snapshot skew, not a verdict:\n`);
    for (const u of a.publishSkewSample) process.stdout.write(`      ~ ${u}\n`);
  }
  process.stdout.write(`\n(B) Newsletter hub links:   ${b.wouldBe404} would 404 (${b.companiesSampled} companies × 4 locales)\n`);
  for (const o of b.sample) process.stdout.write(`      ✗ [${o.locale}] ${o.builderUrl}  →  expected ${o.expectedUrl}  (${o.reason})\n`);
  if (b.publishSkew) {
    process.stdout.write(`    + ${b.publishSkew} hub link(s) on an off-generation shard — snapshot skew, not a verdict\n`);
  }
  process.stdout.write(`\nTOTAL would-be-404s: ${total404}`);
  const skewTotal = (a.publishSkew || 0) + (b.publishSkew || 0);
  process.stdout.write(skewTotal ? ` (+ ${skewTotal} deferred as publish skew)\n` : '\n');

  if (JSON_OUT) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(JSON_OUT, JSON.stringify(report, null, 2));
    log(`[404] wrote report → ${JSON_OUT}`);
  }

  if (total404 > 0 || staleCount > 0) {
    if (total404 > 0) process.stdout.write('\n❌ would-be-404s detected — failing.\n');
    if (staleCount > 0) process.stdout.write(`\n❌ ${staleCount} shard(s) have stopped publishing — failing.\n`);
    process.exit(1);
  }
  process.stdout.write('\n✅ no would-be-404s detected.\n');
}

main().catch((e) => {
  log(`[404] FATAL: ${e.stack || e.message}`);
  process.exit(2);
});
