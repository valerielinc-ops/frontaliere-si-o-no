#!/usr/bin/env node
/**
 * adsense-prereview-audit.mjs — AdSense pre-review checklist.
 *
 * WHAT CHANGED AND WHY (issue #4943)
 * ──────────────────────────────────
 * This audit used to read `dist/`, which forced its workflow to run a FULL
 * 4-locale SSG build (376k indexed URLs) inside one 16 GB runner just to read
 * ≤140 HTML files. That build is OOM-killed by the HOST (`Killed` → "runner has
 * received a shutdown signal" → exit 143) ~80 min in, on the FIRST locale, at
 * RSS ~11.7 GB. The workflow has not produced a report since 2026-07-07.
 * Splitting the build per-locale (#4586) did not shed the memory — that
 * composite action's own documented revert trigger fired.
 *
 * The fix is not a third heap-size guess: it is to stop needing the build at
 * all. AdSense reviews the LIVE SITE, not `dist/`. Auditing the deployed site
 * over HTTP is both cheaper (minutes, no OOM) and strictly MORE faithful — it
 * sees what the Cloudflare Worker actually serves, including routing,
 * redirects and real 404s, none of which `dist/` can show. `dist/` mode is
 * kept for local use and for replaying a build artifact.
 *
 * THREE CORRECTNESS BUGS FIXED AT THE SAME TIME
 * ─────────────────────────────────────────────
 * A green checklist that inspects the wrong pages is worse than a red one.
 * The last successful run (2026-07-07, 140/140 PASS) sampled 139 blog articles
 * and the homepage — and nothing else. Causes:
 *
 *  1. NO STRATIFICATION. `pickUrlSamples` sorted every candidate by a score and
 *     sliced the top N. Blog articles score +60 and there are thousands of
 *     them, so one bucket consumed all 140 slots and every other page type the
 *     scorer *intended* to cover (job board, comparisons, salary, statistics)
 *     was unreachable by construction. The programmatic surface — 78% of the
 *     site — was never audited. Now: sample is stratified across the page-type
 *     buckets, every bucket gets at least one slot, and the daily rotation
 *     offset walks the sample across each bucket so a scheduled run covers new
 *     pages every day instead of re-checking the same ones.
 *
 *  2. SITEMAP INDEX NOT FOLLOWED. It read 5 hardcoded sitemap filenames and
 *     treated `sitemap.xml` as a page list. `sitemap.xml` is a <sitemapindex>,
 *     so its <loc>s are SITEMAP urls, not pages: they became phantom page
 *     candidates that map to no HTML. That latent `html_file_missing` FAIL was
 *     masked only because those URLs scored 0 and never survived the top-N
 *     slice. Now the index is detected and recursed — all 87 sitemaps.
 *
 *  3. AUTO ADS INVISIBLE. `ads_on_thin_content_page` only fired when a page
 *     carried a static `<ins class="adsbygoogle">` or `data-ad-client`. Per
 *     AGENTS.md non-negotiable #7, Auto Ads are ~95% of revenue and inject
 *     their slots at RUNTIME on every page that loads the AdSense tag. Measured
 *     on 200 live search-cluster pages: 200/200 carry the loader, 3/200 have a
 *     static `<ins>`. So the rule was blind to ~95% of the real ad surface.
 *     Ad DELIVERY is now detected from the loader/meta too.
 *
 * GATE SEMANTICS (deliberately not weakened — AGENTS.md #1/#2)
 * ───────────────────────────────────────────────────────────
 * The pre-existing blocking rules keep their EXACT semantics. What is added is
 * strictly stronger, never a downgrade:
 *   - NEW blocking `ads_below_indexed_content_floor`: an indexed page serving
 *     ads with <50 words, the hard floor AGENTS.md #4 says must never be
 *     accepted.
 *   - NEW non-blocking `thin_content_with_auto_ads`: pages under the 140-word
 *     thin heuristic whose ads come from Auto Ads only. This is a WARNING, not
 *     a FAIL, because it is a newly-visible pre-existing condition covering a
 *     very large page class and its remedy is a content decision, not a build
 *     fix — turning it blocking would just park the workflow permanently red
 *     and re-open the daily-noise problem. It is reported prominently in the
 *     summary and in `summary.autoAdsThin` so it cannot be ignored.
 *
 * SITE-LEVEL CHECKS (new)
 * ───────────────────────
 * Page sampling cannot see account-level revenue breakage, so the audit also
 * checks, in live mode:
 *   - `ads.txt` reachable AND listing the publisher id the SITE ITSELF ships in
 *     its `google-adsense-account` meta, as DIRECT. A mismatch here is the
 *     classic "Earnings at risk — your ads.txt doesn't contain your publisher
 *     ID" outage. The id is read from the live page, never hardcoded, so the
 *     check verifies self-consistency and cannot rot.
 *   - `robots.txt` does not block the ad crawlers (`Mediapartners-Google`,
 *     `AdsBot-Google`). A `Disallow: /` for those silently kills ad serving.
 *
 * EXIT CODES (consumed by .github/workflows/adsense-prereview.yml)
 * ───────────────────────────────────────────────────────────────
 *   0 — no blocking findings.
 *   1 — the audit COULD NOT RUN (site unreachable, no URLs discovered). This is
 *       an infrastructure failure and is what should open a "Workflow Failure"
 *       bug.
 *   2 — the audit ran fine and found blocking POLICY findings (only with
 *       --strict). The job still fails, but this is a content problem, not a
 *       broken workflow, so the workflow does not file a workflow-failure bug
 *       for it.
 */
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { isJobBoardSectionPath } from './lib/jobBoardSections.mjs';
import { httpFetchWithRetry } from './lib/transient-fetch.mjs';

const ROOT = process.cwd();
const DIST = path.resolve(ROOT, 'dist');
const PUBLIC = path.resolve(ROOT, 'public');
const REPORTS_DIR = path.resolve(ROOT, 'reports');
const BASE_URL = 'https://frontaliereticino.ch';

/**
 * A bare undici/`fetch` request (no User-Agent) is answered by the Cloudflare
 * "Just a moment…" interstitial with HTTP 403 — verified against production.
 * Every real agent tested (curl, Chrome, Googlebot, AdsBot-Google,
 * Mediapartners-Google) gets 200, so this is a UA-presence gate, not an
 * anti-bot block on the audit. We identify honestly rather than impersonate a
 * browser: the point is to be allowed through, not to hide.
 */
const AUDIT_UA = 'Mozilla/5.0 (compatible; frontaliereticino-adsense-prereview/1.0; +https://frontaliereticino.ch/)';

/** Exit codes — see the docblock. */
const EXIT_OK = 0;
const EXIT_CANNOT_RUN = 1;
const EXIT_POLICY_FINDINGS = 2;

const args = process.argv.slice(2);
const flags = {
  sample: 140,
  save: false,
  strict: false,
  source: 'live',
  base: BASE_URL,
  concurrency: 8,
};

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--save') flags.save = true;
  else if (a === '--strict') flags.strict = true;
  else if (a === '--sample') flags.sample = Math.max(20, Math.min(2000, Number(args[i + 1] || 140)));
  else if (a === '--source') flags.source = String(args[i + 1] || 'live').toLowerCase() === 'dist' ? 'dist' : 'live';
  else if (a === '--base') flags.base = String(args[i + 1] || BASE_URL).replace(/\/+$/, '');
  else if (a === '--concurrency') flags.concurrency = Math.max(1, Math.min(16, Number(args[i + 1] || 8)));
}

const RE = {
  loc: /<loc>(.*?)<\/loc>/gi,
  sitemapIndex: /<sitemapindex[\s>]/i,
  stripScript: /<script[\s\S]*?<\/script>/gi,
  stripStyle: /<style[\s\S]*?<\/style>/gi,
  stripNoScript: /<noscript[\s\S]*?<\/noscript>/gi,
  stripSvg: /<svg[\s\S]*?<\/svg>/gi,
  stripTags: /<[^>]+>/g,
  ws: /\s+/g,
  adInsSlot: /<ins[^>]*\badsbygoogle\b[^>]*>/gi,
  adClientTag: /data-ad-client=/gi,
  adSenseMeta: /google-adsense-account/gi,
  adSenseScript: /pagead2\.googlesyndication\.com/gi,
  publisherId: /ca-(pub-\d{10,20})/i,
  heading: /<h[1-3][^>]*>/gi,
  paragraph: /<(p|li)[^>]*>/gi,
  mainLike: /<(main|article)[^>]*>/gi,
  // Quote-flexible (issue #6558): the site's minifier drops attribute quotes
  // when the value needs none (`name=robots content=noindex,follow`), so a
  // quote-mandatory regex never matches a served/emitted page.
  noindex: /<meta[^>]+name=["']?robots["']?[^>]+content=["']?[^"'>]*noindex/i,
};

const THIN_TEXT_CHARS = 900;
const THIN_WORDS = 140;
const LOW_RICHNESS_BLOCKS = 3;
const MIN_CHARS_PER_AD_SLOT = 500;
/**
 * AGENTS.md non-negotiable #4: "Mai accettare thin content indicizzato <50
 * parole." Below this an indexed page carrying ads is a hard violation, not a
 * heuristic warning.
 */
const INDEXED_CONTENT_WORD_FLOOR = 50;

function fmtDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}${m}${day}-${hh}${mm}`;
}

function countRegex(re, s) {
  const m = String(s || '').match(re);
  return m ? m.length : 0;
}

/** Every <loc> in a sitemap or sitemap index document. */
export function extractLocs(xml) {
  const out = [];
  let m;
  RE.loc.lastIndex = 0;
  while ((m = RE.loc.exec(String(xml || ''))) !== null) {
    const url = String(m[1] || '').trim();
    if (url) out.push(url);
  }
  return out;
}

/** True when the document is a <sitemapindex> (its <loc>s are sitemaps, not pages). */
export function isSitemapIndex(xml) {
  return RE.sitemapIndex.test(String(xml || ''));
}

function extractUrlsFromSitemapFile(filePath) {
  if (!existsSync(filePath)) return [];
  return extractLocs(readFileSync(filePath, 'utf8')).filter((u) => u.startsWith(BASE_URL));
}

function mapUrlToDistPath(url) {
  try {
    const u = new URL(url);
    const pathname = decodeURIComponent(u.pathname || '/');
    if (pathname === '/') return path.resolve(DIST, 'index.html');
    const clean = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    const candidateA = path.resolve(DIST, clean, 'index.html');
    const candidateB = path.resolve(DIST, `${clean}.html`);
    if (existsSync(candidateA)) return candidateA;
    if (existsSync(candidateB)) return candidateB;
    return candidateA;
  } catch {
    return '';
  }
}

function walkHtmlFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkHtmlFiles(full, out);
    else if (st.isFile() && full.endsWith('.html')) out.push(full);
  }
  return out;
}

function normalizeTextFromHtml(html) {
  return String(html || '')
    .replace(RE.stripScript, ' ')
    .replace(RE.stripStyle, ' ')
    .replace(RE.stripNoScript, ' ')
    .replace(RE.stripSvg, ' ')
    .replace(RE.stripTags, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(RE.ws, ' ')
    .trim();
}

/**
 * Phrases with which a page ANNOUNCES ITSELF as an error/placeholder page.
 *
 * Each needs its subject ("pagina"/"sito"/"site"/"page"). The previous list had
 * a bare `in manutenzione`, matched with `includes()` against the whole body
 * text — so the job listing "Operatore automatico/in manutenzione (m/f/d)" on
 * https://frontaliereticino.ch/aziende/sfs-group/ (394 words of real content)
 * was classified as an error page and became a BLOCKING
 * `ads_on_utility_or_error_page` FAIL. On a job board, maintenance roles are
 * ordinary inventory, so that false positive class is unbounded.
 */
const ERROR_PAGE_PHRASES = [
  'pagina non trovata',
  'page not found',
  'seite nicht gefunden',
  'page introuvable',
  'sito in manutenzione',
  'pagina in manutenzione',
  'site under maintenance',
  'site under construction',
  'sito in costruzione',
  'coming soon',
];

/** Text of <title> plus every <h1> — where a real error page states what it is. */
export function pageSelfDescription(html) {
  const s = String(html || '');
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
  const h1s = [...s.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1]).join(' ');
  return normalizeTextFromHtml(`${title} ${h1s}`).toLowerCase();
}

/**
 * An error/utility page is identified from its PATH or its own title/h1 — never
 * from arbitrary body text, which on this site contains user-supplied job
 * titles. Validated against the live 404 (`Pagina non trovata` in both <title>
 * and <h1>), which this still classifies correctly.
 */
export function isLikelyUtilityOrErrorPage(url, html) {
  const p = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return ''; }
  })();
  if (p.includes('/404') || p.includes('/errore') || p.includes('/not-found')) return true;
  const self = pageSelfDescription(html);
  return ERROR_PAGE_PHRASES.some((phrase) => self.includes(phrase));
}

/**
 * The page-type bucket a URL belongs to. In live mode the sitemap a URL came
 * from is the authoritative signal (the site publishes one sitemap per page
 * family), so callers pass it; the path-derived fallback keeps dist mode and
 * any sitemap-less URL working.
 */
export function bucketForUrl(url, sitemapName = '') {
  if (sitemapName) {
    return String(sitemapName)
      .replace(/^.*\//, '')
      .replace(/^sitemap-?/, '')
      .replace(/\.xml$/, '')
      .replace(/-\d{3,}$/, '') || 'root';
  }
  let p = '/';
  try { p = new URL(url).pathname; } catch { /* keep default */ }
  if (p === '/') return 'home';
  if (isJobBoardSectionPath(p)) return 'job-board';
  const seg = p.split('/').filter(Boolean);
  // Strip a leading locale segment so it/en/de/fr variants share one bucket.
  if (seg.length > 1 && /^(en|de|fr)$/.test(seg[0])) seg.shift();
  return seg[0] || 'root';
}

/**
 * Priority weight for a bucket. Kept from the original scorer so the page
 * families the checklist cares most about still get the most slots — the
 * difference is that this now WEIGHTS a stratified allocation instead of
 * sorting a list that one bucket then monopolises.
 */
function bucketWeight(bucket, sampleUrl) {
  if (bucket === 'home') return 12;
  if (/^(blog|news|articoli)/.test(bucket)) return 6;
  if (/^jobs/.test(bucket) || bucket === 'job-board') return 6;
  if (isJobBoardSectionPath((() => { try { return new URL(sampleUrl).pathname; } catch { return ''; } })())) return 6;
  if (/^(comparisons|compara|salary|salaire|calcola|statistiche|stats)/.test(bucket)) return 5;
  // Utility/legal pages carry ads but are not what a reviewer judges content on.
  if (/^(privacy|cookie|404|termini|terms)/.test(bucket)) return 1;
  return 3;
}

/**
 * Deterministic daily rotation offset. A scheduled audit that always inspects
 * the same pages stops discovering anything after day one; seeding the pick
 * with the day-of-year walks the sample across each bucket over time while
 * keeping a single run perfectly reproducible.
 */
export function rotationOffset(now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start) / 86400000);
}

/**
 * Allocate `total` sample slots across buckets: every non-empty bucket is
 * guaranteed one slot (so no page family is invisible), the remainder is shared
 * out by weight × sqrt(size) — sqrt so a 39k-page bucket outweighs a 20-page
 * one without erasing it, which a linear split would do.
 */
export function allocateSampleSlots(buckets, total) {
  const names = [...buckets.keys()].filter((k) => buckets.get(k).length > 0);
  if (names.length === 0) return new Map();
  const alloc = new Map();
  for (const n of names) alloc.set(n, 0);

  const guaranteed = Math.min(names.length, total);
  // Guarantee in weight order so that, when total < bucket count, the highest
  // priority families are the ones that get the scarce slots.
  const byPriority = [...names].sort((a, b) => {
    const wd = bucketWeight(b, buckets.get(b)[0]) - bucketWeight(a, buckets.get(a)[0]);
    return wd !== 0 ? wd : a.localeCompare(b);
  });
  for (let i = 0; i < guaranteed; i += 1) alloc.set(byPriority[i], 1);

  let remaining = total - guaranteed;
  if (remaining > 0) {
    const scored = names.map((n) => ({
      n,
      score: bucketWeight(n, buckets.get(n)[0]) * Math.sqrt(buckets.get(n).length),
    }));
    const totalScore = scored.reduce((s, x) => s + x.score, 0) || 1;
    for (const { n, score } of scored) {
      if (remaining <= 0) break;
      const extra = Math.min(
        remaining,
        Math.floor((score / totalScore) * (total - guaranteed)),
        Math.max(0, buckets.get(n).length - alloc.get(n)),
      );
      alloc.set(n, alloc.get(n) + extra);
      remaining -= extra;
    }
    // Hand out any rounding leftovers to the biggest buckets that can take them.
    const fillOrder = [...scored].sort((a, b) => b.score - a.score);
    let guard = 0;
    while (remaining > 0 && guard < fillOrder.length * 4) {
      let progressed = false;
      for (const { n } of fillOrder) {
        if (remaining <= 0) break;
        if (alloc.get(n) < buckets.get(n).length) {
          alloc.set(n, alloc.get(n) + 1);
          remaining -= 1;
          progressed = true;
        }
      }
      if (!progressed) break;
      guard += 1;
    }
  }
  return alloc;
}

/** Evenly spaced, rotation-offset picks from one bucket — reproducible per day. */
export function pickFromBucket(urls, count, offset) {
  if (count <= 0 || urls.length === 0) return [];
  const n = Math.min(count, urls.length);
  const step = Math.max(1, Math.floor(urls.length / n));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i += 1) {
    let idx = (offset + i * step) % urls.length;
    let guard = 0;
    while (seen.has(idx) && guard < urls.length) { idx = (idx + 1) % urls.length; guard += 1; }
    seen.add(idx);
    out.push(urls[idx]);
  }
  return out;
}

export function stratifiedSample(entries, total, offset) {
  const buckets = new Map();
  for (const e of entries) {
    const b = e.bucket;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(e.url);
  }
  for (const [, list] of buckets) list.sort();
  const alloc = allocateSampleSlots(buckets, total);
  const out = [];
  for (const [name, count] of alloc) {
    for (const url of pickFromBucket(buckets.get(name), count, offset)) {
      out.push({ url, bucket: name });
    }
  }
  return out;
}

/**
 * Ad DELIVERY signals. `staticSlots`/`clientTags` are the pre-declared markup
 * the original audit looked at; `autoAds` is the loader/meta that makes Auto
 * Ads inject slots at runtime — ~95% of revenue per AGENTS.md #7 and the only
 * signal present on most of the programmatic surface.
 */
export function adDelivery(html) {
  const staticSlots = countRegex(RE.adInsSlot, html);
  const clientTags = countRegex(RE.adClientTag, html);
  const meta = countRegex(RE.adSenseMeta, html);
  const loader = countRegex(RE.adSenseScript, html);
  return {
    staticSlots,
    clientTags,
    autoAds: meta > 0 || loader > 0,
    signals: staticSlots + clientTags + meta + loader,
    /** Does this page serve ads at all, by any mechanism? */
    servesAds: staticSlots > 0 || clientTags > 0 || meta > 0 || loader > 0,
  };
}

export function auditPage(url, filePath, html, bucket = '') {
  const text = normalizeTextFromHtml(html);
  const wordCount = text ? text.split(' ').filter(Boolean).length : 0;
  const textChars = text.length;
  const headingCount = countRegex(RE.heading, html);
  const paragraphCount = countRegex(RE.paragraph, html);
  const mainCount = countRegex(RE.mainLike, html);
  const ads = adDelivery(html);
  const adInsSlots = ads.staticSlots;
  const adClientTags = ads.clientTags;
  const adSignals = ads.signals;
  const contentBlocks = headingCount + paragraphCount + mainCount;
  const charsPerSlot = adInsSlots > 0 ? Math.round(textChars / Math.max(1, adInsSlots)) : null;
  const noindex = RE.noindex.test(String(html || ''));

  const issues = [];
  const warnings = [];
  const utilityLike = isLikelyUtilityOrErrorPage(url, html);
  const thin = textChars < THIN_TEXT_CHARS || wordCount < THIN_WORDS || contentBlocks < LOW_RICHNESS_BLOCKS;

  // ── Pre-existing blocking rules: semantics unchanged (AGENTS.md #1/#2) ──
  if (utilityLike && adSignals > 0) {
    issues.push('ads_on_utility_or_error_page');
  }
  if (thin && (adInsSlots > 0 || adClientTags > 0)) {
    issues.push('ads_on_thin_content_page');
  }
  if (adInsSlots > 0 && charsPerSlot !== null && charsPerSlot < MIN_CHARS_PER_AD_SLOT) {
    issues.push(`low_content_to_ad_ratio:${charsPerSlot}`);
  }

  // ── NEW blocking: the AGENTS.md #4 hard floor for INDEXED pages with ads ──
  if (ads.servesAds && !noindex && wordCount < INDEXED_CONTENT_WORD_FLOOR) {
    issues.push(`ads_below_indexed_content_floor:${wordCount}`);
  }

  // ── NEW non-blocking: Auto-Ads-only thin pages (see docblock for why warn) ──
  const autoAdsThin = thin && ads.autoAds && adInsSlots === 0 && adClientTags === 0;
  if (autoAdsThin) {
    warnings.push(`thin_content_with_auto_ads:${wordCount}`);
  }

  if (mainCount === 0) {
    warnings.push('missing_main_or_article_container');
  }
  if (wordCount < 250) {
    warnings.push(`low_word_count:${wordCount}`);
  }
  if (adInsSlots > 2) {
    warnings.push(`high_ad_slots:${adInsSlots}`);
  }

  return {
    url,
    bucket,
    filePath: filePath ? path.relative(ROOT, filePath) : '',
    metrics: {
      textChars,
      wordCount,
      headingCount,
      paragraphCount,
      mainCount,
      adInsSlots,
      adClientTags,
      adSignals,
      autoAds: ads.autoAds,
      servesAds: ads.servesAds,
      noindex,
      charsPerSlot,
      contentBlocks,
      thin,
      autoAdsThin,
      utilityLike,
    },
    status: issues.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    issues,
    warnings,
  };
}

async function fetchText(url, label) {
  const res = await httpFetchWithRetry(
    url,
    { headers: { 'User-Agent': AUDIT_UA, Accept: '*/*' }, redirect: 'follow' },
    { label: label || url, timeout: 30000, retries: 2 },
  );
  return { status: res.status, ok: res.ok, body: res.ok ? await res.text() : '' };
}

/** Walk the live sitemap index into {url, bucket} entries. */
async function collectLiveEntries(base) {
  const rootUrl = `${base}/sitemap.xml`;
  const root = await fetchText(rootUrl, 'sitemap.xml');
  if (!root.ok) throw new Error(`sitemap.xml unreachable (HTTP ${root.status}) at ${rootUrl}`);
  const entries = [];
  if (!isSitemapIndex(root.body)) {
    for (const url of extractLocs(root.body)) entries.push({ url, bucket: bucketForUrl(url) });
    return entries;
  }
  const children = extractLocs(root.body).filter((u) => u.endsWith('.xml'));
  console.log(`Sitemap index: ${children.length} child sitemaps`);
  let q = [...children];
  const workers = Array.from({ length: Math.min(flags.concurrency, 8) }, async () => {
    while (q.length) {
      const sm = q.shift();
      try {
        const doc = await fetchText(sm, sm);
        if (!doc.ok) continue;
        const bucket = bucketForUrl('', sm);
        for (const url of extractLocs(doc.body)) {
          if (url.endsWith('.xml')) continue;
          entries.push({ url, bucket });
        }
      } catch (err) {
        console.warn(`⚠️  sitemap unreadable: ${sm} — ${err?.message || err}`);
      }
    }
  });
  await Promise.all(workers);
  return entries;
}

/** Local dist/public sitemaps, index-aware. */
function collectDistEntries() {
  const seen = new Set();
  const entries = [];
  const roots = [];
  for (const dir of [DIST, PUBLIC]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (/^sitemap.*\.xml$/i.test(f)) roots.push(path.resolve(dir, f));
    }
  }
  for (const file of roots) {
    const xml = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (isSitemapIndex(xml)) continue; // its children are separate files, already in `roots`
    const bucket = bucketForUrl('', path.basename(file));
    for (const url of extractLocs(xml)) {
      if (!url.startsWith(BASE_URL) || url.endsWith('.xml') || seen.has(url)) continue;
      seen.add(url);
      entries.push({ url, bucket });
    }
  }
  if (entries.length === 0 && existsSync(DIST)) {
    for (const f of walkHtmlFiles(DIST)) {
      const rel = path.relative(DIST, f).replace(/\\/g, '/');
      const url = rel === 'index.html'
        ? `${BASE_URL}/`
        : `${BASE_URL}/${rel.replace(/\/index\.html$/, '/').replace(/\.html$/, '')}`;
      if (seen.has(url)) continue;
      seen.add(url);
      entries.push({ url, bucket: bucketForUrl(url) });
    }
  }
  return entries;
}

/**
 * Account-level checks that page sampling structurally cannot see. Returns
 * {issues, warnings, publisherId}.
 */
export function checkAdsTxt(adsTxtBody, publisherId) {
  const issues = [];
  if (!publisherId) return { issues, warnings: ['adsense_publisher_id_not_found_on_site'] };
  const line = String(adsTxtBody || '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .find((l) => l.includes(publisherId) && /google\.com/i.test(l));
  if (!line) {
    issues.push(`ads_txt_missing_publisher_id:${publisherId}`);
  } else if (!/\bDIRECT\b/i.test(line)) {
    issues.push(`ads_txt_publisher_id_not_direct:${publisherId}`);
  }
  return { issues, warnings: [] };
}

export function checkRobotsTxt(robotsBody) {
  const issues = [];
  const lines = String(robotsBody || '').split('\n').map((l) => l.trim());
  let current = null;
  const blocked = new Set();
  for (const raw of lines) {
    const l = raw.replace(/#.*$/, '').trim();
    if (!l) continue;
    const ua = l.match(/^user-agent:\s*(.+)$/i);
    if (ua) { current = ua[1].trim().toLowerCase(); continue; }
    const dis = l.match(/^disallow:\s*(.*)$/i);
    if (dis && current && /^(mediapartners-google|adsbot-google)$/.test(current) && dis[1].trim() === '/') {
      blocked.add(current);
    }
  }
  for (const ua of blocked) issues.push(`robots_txt_blocks_ad_crawler:${ua}`);
  return { issues, warnings: [] };
}

async function runSiteChecks(base) {
  const site = { checked: false, issues: [], warnings: [], publisherId: null };
  try {
    const home = await fetchText(`${base}/`, 'homepage');
    if (!home.ok) {
      site.issues.push(`homepage_unreachable:${home.status}`);
      return site;
    }
    const m = home.body.match(RE.publisherId);
    site.publisherId = m ? m[1] : null;

    const adsTxt = await fetchText(`${base}/ads.txt`, 'ads.txt');
    if (!adsTxt.ok) {
      site.issues.push(`ads_txt_unreachable:${adsTxt.status}`);
    } else {
      const r = checkAdsTxt(adsTxt.body, site.publisherId);
      site.issues.push(...r.issues);
      site.warnings.push(...(r.warnings || []));
    }

    const robots = await fetchText(`${base}/robots.txt`, 'robots.txt');
    if (!robots.ok) {
      site.warnings.push(`robots_txt_unreachable:${robots.status}`);
    } else {
      const r = checkRobotsTxt(robots.body);
      site.issues.push(...r.issues);
    }
    site.checked = true;
  } catch (err) {
    site.warnings.push(`site_checks_error:${String(err?.message || err).slice(0, 120)}`);
  }
  return site;
}

function writeReports(report) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = fmtDate(new Date());
  const jsonPath = path.resolve(REPORTS_DIR, `adsense-prereview-${stamp}.json`);
  const mdPath = path.resolve(REPORTS_DIR, `adsense-prereview-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const topFail = report.pages.filter((p) => p.status === 'fail').slice(0, 25);
  const topWarn = report.pages.filter((p) => p.status === 'warn').slice(0, 25);
  const lines = [
    '# AdSense Pre-Review Checklist',
    '',
    `- Generated at: ${report.generatedAt}`,
    `- Source: ${report.source}${report.source === 'live' ? ` (${report.base})` : ''}`,
    `- Sample size: ${report.sampleSize} across ${report.bucketsSampled} page families (of ${report.urlsDiscovered} URLs discovered)`,
    `- PASS: ${report.summary.pass}`,
    `- WARN: ${report.summary.warn}`,
    `- FAIL: ${report.summary.fail}`,
    `- Thin pages served by Auto Ads: ${report.summary.autoAdsThin}`,
    '',
    '## Site-level checks',
    '',
    `- AdSense publisher id: ${report.site.publisherId || 'NOT FOUND'}`,
    ...(report.site.issues.length > 0
      ? report.site.issues.map((i) => `- ❌ ${i}`)
      : ['- ✅ ads.txt and robots.txt consistent with the deployed publisher id']),
    ...report.site.warnings.map((w) => `- ⚠️ ${w}`),
    '',
    '## Coverage by page family',
    '',
    ...Object.entries(report.byBucket)
      .sort((a, b) => b[1].n - a[1].n)
      .map(([b, v]) => `- ${b}: ${v.n} sampled — pass ${v.pass}, warn ${v.warn}, fail ${v.fail}`),
    '',
    '## Top FAIL pages',
    '',
    ...(topFail.length > 0 ? topFail.map((p) => `- ${p.url} | issues: ${p.issues.join(', ')}`) : ['- none']),
    '',
    '## Top WARN pages',
    '',
    ...(topWarn.length > 0 ? topWarn.map((p) => `- ${p.url} | warnings: ${p.warnings.join(', ')}`) : ['- none']),
    '',
    '## Decision',
    '',
    report.summary.fail > 0 || report.site.issues.length > 0
      ? '- NOT READY for AdSense re-review: resolve FAIL / site-level findings first.'
      : '- READY for AdSense re-review (only WARN/non-blocking findings).',
    '',
  ];
  writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, mdPath };
}

function writeStepSummary(report) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    '## AdSense Pre-Review Checklist',
    '',
    `Source: **${report.source}** — ${report.sampleSize} pages across ${report.bucketsSampled} families `
    + `(of ${report.urlsDiscovered} URLs discovered)`,
    '',
    `| PASS | WARN | FAIL | Thin+AutoAds |`,
    `|---|---|---|---|`,
    `| ${report.summary.pass} | ${report.summary.warn} | ${report.summary.fail} | ${report.summary.autoAdsThin} |`,
    '',
    `Publisher id: \`${report.site.publisherId || 'NOT FOUND'}\``,
    ...(report.site.issues.length > 0 ? ['', '**Site-level findings**', ...report.site.issues.map((i) => `- ❌ ${i}`)] : []),
    ...(report.summary.fail > 0
      ? ['', '**Blocking page findings**', ...report.pages.filter((p) => p.status === 'fail').slice(0, 20).map((p) => `- ${p.url} — ${p.issues.join(', ')}`)]
      : []),
    '',
  ];
  try { appendFileSync(file, `${lines.join('\n')}\n`, 'utf8'); } catch { /* summary is best-effort */ }
}

async function main() {
  let entries = [];
  if (flags.source === 'dist') {
    if (!existsSync(DIST)) {
      console.error('❌ dist/ not found. Run a build first, or use --source live.');
      process.exit(EXIT_CANNOT_RUN);
    }
    entries = collectDistEntries();
  } else {
    try {
      entries = await collectLiveEntries(flags.base);
    } catch (err) {
      console.error(`❌ cannot reach the live site: ${err?.message || err}`);
      process.exit(EXIT_CANNOT_RUN);
    }
  }

  // Deduplicate while keeping the first bucket a URL was seen under.
  const seen = new Set();
  entries = entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));

  if (entries.length === 0) {
    console.error('❌ no URLs discovered — nothing to audit (sitemaps empty or unreadable).');
    process.exit(EXIT_CANNOT_RUN);
  }

  const site = flags.source === 'live'
    ? await runSiteChecks(flags.base)
    : { checked: false, issues: [], warnings: ['site_checks_skipped_in_dist_mode'], publisherId: null };

  const picked = stratifiedSample(entries, flags.sample, rotationOffset());
  console.log(`Discovered ${entries.length} URLs; sampling ${picked.length} across page families.`);

  const pages = [];
  if (flags.source === 'dist') {
    for (const { url, bucket } of picked) {
      const filePath = mapUrlToDistPath(url);
      if (!filePath || !existsSync(filePath)) {
        pages.push({ url, bucket, filePath: filePath ? path.relative(ROOT, filePath) : 'n/a', status: 'fail', issues: ['html_file_missing'], warnings: [], metrics: null });
        continue;
      }
      pages.push(auditPage(url, filePath, readFileSync(filePath, 'utf8'), bucket));
    }
  } else {
    const q = [...picked];
    await Promise.all(Array.from({ length: flags.concurrency }, async () => {
      while (q.length) {
        const { url, bucket } = q.shift();
        try {
          const res = await fetchText(url, url);
          if (!res.ok) {
            pages.push({ url, bucket, filePath: '', status: 'fail', issues: [`page_unreachable:${res.status}`], warnings: [], metrics: null });
            continue;
          }
          pages.push(auditPage(url, '', res.body, bucket));
        } catch (err) {
          pages.push({ url, bucket, filePath: '', status: 'fail', issues: [`page_fetch_error:${String(err?.message || err).slice(0, 80)}`], warnings: [], metrics: null });
        }
      }
    }));
  }

  pages.sort((a, b) => a.url.localeCompare(b.url));

  const byBucket = {};
  for (const p of pages) {
    const b = p.bucket || 'unknown';
    byBucket[b] = byBucket[b] || { n: 0, pass: 0, warn: 0, fail: 0 };
    byBucket[b].n += 1;
    byBucket[b][p.status] += 1;
  }

  const summary = {
    pass: pages.filter((p) => p.status === 'pass').length,
    warn: pages.filter((p) => p.status === 'warn').length,
    fail: pages.filter((p) => p.status === 'fail').length,
    autoAdsThin: pages.filter((p) => p.metrics?.autoAdsThin).length,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    source: flags.source,
    base: flags.base,
    urlsDiscovered: entries.length,
    sampleSize: pages.length,
    bucketsSampled: Object.keys(byBucket).length,
    thresholds: {
      thinTextChars: THIN_TEXT_CHARS,
      thinWords: THIN_WORDS,
      minContentBlocks: LOW_RICHNESS_BLOCKS,
      minCharsPerAdSlot: MIN_CHARS_PER_AD_SLOT,
      indexedContentWordFloor: INDEXED_CONTENT_WORD_FLOOR,
    },
    site,
    summary,
    byBucket,
    pages,
  };

  console.log('=== AdSense Pre-Review Checklist ===');
  console.log(`Source: ${flags.source}${flags.source === 'live' ? ` (${flags.base})` : ''}`);
  console.log(`URLs discovered: ${report.urlsDiscovered} | sampled: ${report.sampleSize} across ${report.bucketsSampled} families`);
  console.log(`PASS: ${summary.pass} | WARN: ${summary.warn} | FAIL: ${summary.fail}`);
  console.log(`Thin pages served by Auto Ads (non-blocking): ${summary.autoAdsThin}`);
  console.log(`Publisher id: ${site.publisherId || 'NOT FOUND'}`);
  if (site.issues.length > 0) {
    console.log('\nSite-level findings:');
    for (const i of site.issues) console.log(`- ${i}`);
  }
  if (summary.fail > 0) {
    console.log('\nTop FAIL pages:');
    for (const p of pages.filter((x) => x.status === 'fail').slice(0, 20)) {
      console.log(`- ${p.url} -> ${p.issues.join(', ')}`);
    }
  }

  if (flags.save) {
    const out = writeReports(report);
    console.log(`\nSaved report: ${path.relative(ROOT, out.jsonPath)}`);
    console.log(`Saved summary: ${path.relative(ROOT, out.mdPath)}`);
  }
  writeStepSummary(report);

  const blocking = summary.fail + site.issues.length;
  if (flags.strict && blocking > 0) {
    console.error(`\n❌ ${blocking} blocking finding(s) — not ready for AdSense re-review.`);
    process.exit(EXIT_POLICY_FINDINGS);
  }
  process.exit(EXIT_OK);
}

// Allow the pure helpers above to be imported by tests without running the audit.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`❌ audit crashed: ${err?.stack || err}`);
    process.exit(EXIT_CANNOT_RUN);
  });
}
