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
 * `frontaliere-ticino-{it,en,de,fr}` (see TICINO_SHARD_REPOS below and
 * docs/TICINO-SHARD-RUNBOOK.md). Missing this union was the root cause of
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
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
// Exercise the REAL newsletter URL builder, not a frozen copy of the bug — so
// check (B) auto-resolves once companyPageUrl is fixed AND catches any future
// prefix/slug regression (the builder is the single source of truth).
import { companyPageUrl, slugifyCompanyName } from '../services/newsletter-content.mjs';

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

// Ticino-section shards (issue #3173 root cause, added 2026-07-03): PR #3177
// (2026-06-30) carved the Ticino job/company section out of the IT apex AND
// every en/de/fr locale shard into FOUR dedicated per-locale Pages repos
// (frontaliere-ticino-<loc>), gated by the `TICINO_SHARD_LIVE` repo variable
// (flipped true 2026-07-01T06:30Z — see docs/TICINO-SHARD-RUNBOOK.md). Once
// live, strip-ticino-subtree.sh removes cerca-lavoro-ticino / en/find-jobs-ticino
// / de/jobs-im-tessin / fr/trouver-emploi-tessin from the apex and from every
// locale shard's own dist before push — the content is real and served (via
// the locale-router Worker → origin-ticino-<loc>), just no longer present in
// SHARD_REPOS' trees. This script's SHARD_REPOS map was never updated in that
// PR (post-deploy-validate-dist.yml's rehydrate step was, in the same PR — this
// was the missed sibling), so from 2026-07-01 onward EVERY Ticino-section
// en/de/fr page was a false-positive 404-risk (19 real offenders on 06-30 →
// 3581 false + real by 07-02, almost entirely `find-jobs-ticino` /
// `jobs-im-tessin` / `trouver-emploi-tessin` URLs). Keep in lockstep with
// TICINO_SUB in .github/workflows/post-deploy-validate-dist.yml and the `case`
// in scripts/lib/push-ticino-shard.sh.
const TICINO_SHARD_REPOS = {
  it: 'valerielinc-ops/frontaliere-ticino-it',
  en: 'valerielinc-ops/frontaliere-ticino-en',
  de: 'valerielinc-ops/frontaliere-ticino-de',
  fr: 'valerielinc-ops/frontaliere-ticino-fr',
};

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
function ticinoShardFloor(loc) {
  const raw = process.env[`AUDIT_404_TICINO_SHARD_FLOOR_${loc.toUpperCase()}`]
    ?? process.env.AUDIT_404_TICINO_SHARD_FLOOR;
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

async function listShardTree(repo) {
  const dir = await mkdtemp(join(tmpdir(), 'audit404-'));
  try {
    await execFileP('git', [
      'clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--quiet',
      `https://github.com/${repo}.git`, dir,
    ], { maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await execFileP('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout.split('\n').filter(Boolean);
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
  const meta = { shards: {}, ticinoShards: {}, itSource: null, distRoutes: 0 };

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
      const entries = await listShardTree(repo);
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

    // Ticino-section shards (issue #3173): additive to the locale shards
    // above, NOT a replacement — since 2026-07-01 the Ticino subtree is
    // stripped out of the IT apex and out of every en/de/fr locale shard, so
    // without this loop every Ticino-section page looks unserved even though
    // it's live on frontaliere-ticino-<loc>. See TICINO_SHARD_REPOS comment.
    for (const [loc, repo] of Object.entries(TICINO_SHARD_REPOS)) {
      log(`[404] listing ${loc} Ticino shard tree (${repo}) …`);
      const entries = await listShardTree(repo);
      let n = 0;
      for (const e of entries) {
        if (!/\.html$/i.test(e)) continue;
        served.add(treeEntryToRoute(e));
        n++;
      }
      const floor = ticinoShardFloor(loc);
      meta.ticinoShards[loc] = n;
      log(`[404]   ticino-${loc}: ${n} served pages (floor ${floor})`);
      // Same degenerate-clone guard as the locale shards above — a renamed
      // repo / failed push / rate-limited clone must fail loud, not silently
      // report tens of thousands of false Ticino-section 404s.
      if (n < floor) {
        throw new Error(`ticino shard ${loc} (${repo}) returned only ${n} pages (< floor ${floor}) — degenerate clone, refusing to emit a poisoned report. If this is expected (e.g. TICINO_SHARD_LIVE rolled back), lower it via AUDIT_404_TICINO_SHARD_FLOOR_${loc.toUpperCase()} (or AUDIT_404_TICINO_SHARD_FLOOR).`);
      }
    }
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
  // Always include the proven-incident company so the gate self-tests.
  names.add('EOC Ente Ospedaliero Cantonale');
  return [...names].map((name) => ({ name, slug: slugifyCompanyName(name) })).filter((c) => c.slug);
}

// The path the REAL newsletter builder emits for a company hub, for the given
// locale. companyPageUrl returns an absolute URL → reduce to a normalized path.
function builderHubPath(slug, locale) {
  return normPath(companyPageUrl(slug, locale));
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
  log(`[404] served set: ${served.size} paths | IT source: ${meta.itSource} | shards: ${JSON.stringify(meta.shards)} | ticino shards: ${JSON.stringify(meta.ticinoShards)}`);

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
  const companies = await loadCompanySample(SAMPLE);
  const hubOffenders = [];
  for (const { name, slug } of companies) {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const url = builderHubPath(slug, locale); // what the REAL builder emits
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
  process.stdout.write(`served set: ${served.size} paths (IT: ${meta.itSource}; shards: ${JSON.stringify(meta.shards)}; ticino shards: ${JSON.stringify(meta.ticinoShards)})\n\n`);
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
