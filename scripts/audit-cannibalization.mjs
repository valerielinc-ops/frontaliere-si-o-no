#!/usr/bin/env node
/**
 * Local cannibalization audit — Sprint 3 Task 3.1.
 *
 * Reads every HTML page under dist/ (after build), extracts <title> and H1,
 * tokenizes into normalized keyword phrases, and groups pages sharing the
 * same primary phrase. Any phrase with 2+ canonical (self-referencing) URLs
 * is flagged as a potential cannibalization cluster.
 *
 * This is a local heuristic approximation of the Semrush duplicate-keyword
 * report. It is not a substitute for GSC/Semrush SERP analysis — it flags
 * _on-page_ signals pointing at the same intent, not actual SERP dilution.
 * Use it to spot new duplicates introduced by builds before they ship.
 *
 * Exit codes:
 *   0 — no clusters found (or only whitelisted templated clusters)
 *   1 — at least one non-whitelisted cluster found
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');

/**
 * Semrush mode — when `--semrush` is passed (optionally with
 * `--input=<path>` to override the default CSV location), group raw
 * `domain_organic` rows by keyword and emit a URL-pairing CSV that
 * identifies winners (best position) and losers (dilutive siblings).
 *
 * The input CSV is expected to be produced by the Semrush MCP
 * `domain_organic` report with columns:
 *   Keyword;Position;Search Volume;Url;Traffic (%)
 *
 * We don't call the MCP from here (Node has no MCP client in this
 * project); a sibling agent/operator persists the raw export to
 * `data/seo/semrush-organic-raw.csv` and this script pairs it.
 */
const SEMRUSH_DEFAULT_INPUT = path.resolve('data/seo/semrush-organic-raw.csv');
const SEMRUSH_OUTPUT = path.resolve('data/seo/cannibalization-urls.csv');

/** Phrases we know legitimately repeat across pages (templated clusters). */
const WHITELIST_PREFIXES = [
 // Weekly employers per-city (IT/EN/DE/FR)
 'aziende che assumono',
 'companies hiring',
 'unternehmen mit offenen stellen',
 'entreprises qui recrutent',
 // Job market snapshots per-sector
 'mercato del lavoro',
 'job market',
 'marché du travail',
 'arbeitsmarkt',
 // Health premiums per-canton/age
 'premi cassa malati',
 'health insurance premiums',
 'primes assurance maladie',
 'krankenkassenprämien',
 'krankenkassenpraemien',
 // Fuel daily per-station / per-city
 'prezzi benzina',
 'fuel prices',
 // Border-wait per-valico
 'tempi di attesa dogana',
 'tempi di attesa',
 'border wait',
 'temps d attente',
 'grenzwartezeit',
 // Salary-hub templated scenarios (100+ numeric variants per locale)
 'stipendio netto',
 'net salary',
 'nettogehalt',
 'salaire net',
 // Salary-hub 20km variants (entro-20km / oltre-20km templated pair)
 'confronto netto',
 'confronto permit',
 'confronto permesso',
 // Job-market snapshot weekly archives
 'snapshot settimanale',
 'weekly snapshot',
 'ticino job market',
 'mercato del lavoro ticino',
];

/**
 * URL-path prefixes for JobPosting pages. Google de-duplicates jobs via the
 * `JobPosting` structured-data fingerprint (title+hiringOrganization+location),
 * so on-page title overlap across cities/companies is expected and NOT a
 * cannibalization signal at the SERP layer.
 */
const JOB_PATH_PREFIXES = [
 '/cerca-lavoro-ticino/',
 '/en/find-jobs-ticino/',
 '/de/jobs-im-tessin/',
 '/fr/trouver-emploi-tessin/',
 '/fr/emplois-tessin/',
];

function isJobPath(urlPath) {
 return JOB_PATH_PREFIXES.some((p) => urlPath.startsWith(p));
}

const MIN_CLUSTER_SIZE = 2;

/** Locale URL prefixes; paths under these are treated as localized siblings. */
const LOCALE_PREFIXES = ['/en/', '/de/', '/fr/'];

/**
 * Extract a locale-agnostic "page key" from the URL path by stripping the
 * locale prefix and any trailing /year-week/YYYY-MM-DD/page-N segments we
 * know to be pagination/time variants.
 * Two URLs sharing the same key are hreflang siblings or time-variants —
 * NOT cannibalization, so the audit should ignore clusters where all URLs
 * collapse to the same key.
 */
function localeAgnosticKey(urlPath) {
 let p = urlPath;
 for (const pref of LOCALE_PREFIXES) if (p.startsWith(pref)) { p = '/' + p.slice(pref.length); break; }
 // Strip /week-NN-YYYY/, /settimana-NN-YYYY/, /YYYY-MM-DD/, /marzo-2026/…
 p = p.replace(/\/(week|semaine|settimana|woche)-\d+-\d{4}\/?$/, '/');
 p = p.replace(/\/(january|february|march|april|may|june|july|august|september|october|november|december)-\d{4}\/?$/, '/');
 p = p.replace(/\/(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)-\d{4}\/?$/, '/');
 p = p.replace(/\/(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)-\d{4}\/?$/, '/');
 p = p.replace(/\/(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)-\d{4}\/?$/, '/');
 return p;
}

function walk(dir, acc = []) {
 for (const entry of readdirSync(dir)) {
  const full = path.join(dir, entry);
  let st;
  try {
   st = statSync(full);
  } catch {
   continue; // broken symlink or missing entry — skip
  }
  if (st.isDirectory()) {
   walk(full, acc);
  } else if (entry === 'index.html') {
   acc.push(full);
  }
 }
 return acc;
}

/** Normalize a phrase for keyword grouping. */
function normalize(phrase) {
 return phrase
  .toLowerCase()
  .replace(/\s*[—–\-|·•].*$/u, '') // strip suffix after separator
  .replace(/\s*\|\s*frontaliere ticino$/u, '')
  .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();
}

function extractTitle(html) {
 const m = html.match(/<title>([^<]+)<\/title>/i);
 return m ? m[1].trim() : '';
}

function extractCanonical(html) {
 const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
 return m ? m[1].trim() : '';
}

function isNoindex(html) {
 return /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(html);
}

/**
 * Parse the Semrush raw CSV. The Semrush export uses `;` as the column
 * delimiter (to tolerate commas inside titles). Returns one row per
 * keyword/URL pairing.
 */
function parseSemrushCsv(csvPath) {
 const raw = readFileSync(csvPath, 'utf-8');
 const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
 if (lines.length < 2) return [];
 const [, ...rest] = lines; // drop header
 const rows = [];
 for (const line of rest) {
  const parts = line.split(';');
  if (parts.length < 4) continue;
  const keyword = parts[0].trim();
  const position = Number.parseInt(parts[1], 10);
  const volume = Number.parseInt(parts[2], 10);
  const url = parts[3].trim();
  if (!keyword || !url || Number.isNaN(position)) continue;
  rows.push({ keyword, position, volume: Number.isNaN(volume) ? 0 : volume, url });
 }
 return rows;
}

/**
 * Normalize a URL to its canonical form so `www.` vs bare host and
 * trailing-slash variants collapse into one entry.
 */
function canonicalizeUrl(url) {
 return url
  .replace(/^https?:\/\/(?:www\.)?/i, 'https://')
  .replace(/\/+$/, '/');
}

/**
 * Build the cannibalization report from parsed Semrush rows. Groups by
 * keyword; flags any keyword where 2+ distinct canonical URLs from our
 * domain appear. Winner = lowest position (best rank). Losers are all
 * other URLs for that keyword.
 */
function buildCannibalizationReport(rows) {
 const byKeyword = new Map();
 for (const r of rows) {
  const canon = canonicalizeUrl(r.url);
  if (!byKeyword.has(r.keyword)) byKeyword.set(r.keyword, new Map());
  const urls = byKeyword.get(r.keyword);
  // Keep the best (lowest) position per (keyword, canonical URL) pair.
  const prev = urls.get(canon);
  if (!prev || r.position < prev.position) {
   urls.set(canon, { ...r, url: canon });
  }
 }
 const clusters = [];
 for (const [keyword, urlMap] of byKeyword.entries()) {
  if (urlMap.size < 2) continue;
  const sorted = [...urlMap.values()].sort((a, b) => a.position - b.position);
  const winner = sorted[0];
  for (const entry of sorted) {
   clusters.push({
    keyword,
    position: entry.position,
    volume: entry.volume,
    url: entry.url,
    winnerHint: entry === winner ? 'WINNER' : `loser→${winner.url}`,
   });
  }
 }
 return clusters;
}

/** CSV-escape a field containing `"`, `,`, or newline. */
function csvEscape(value) {
 const s = String(value ?? '');
 if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
 return s;
}

function runSemrushMode() {
 const args = process.argv.slice(2);
 const inputArg = args.find((a) => a.startsWith('--input='));
 const input = inputArg ? path.resolve(inputArg.slice('--input='.length)) : SEMRUSH_DEFAULT_INPUT;
 if (!existsSync(input)) {
  console.error(`Semrush input not found: ${input}`);
  console.error('Expected a CSV produced by the Semrush MCP domain_organic report.');
  console.error('Columns: Keyword;Position;Search Volume;Url;Traffic (%)');
  process.exit(2);
 }
 const rows = parseSemrushCsv(input);
 const clusters = buildCannibalizationReport(rows);

 // Ensure output directory exists.
 const outDir = path.dirname(SEMRUSH_OUTPUT);
 if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

 const header = 'keyword,position,volume,url,winner_hint\n';
 const body = clusters
  .map((c) => [c.keyword, c.position, c.volume, c.url, c.winnerHint].map(csvEscape).join(','))
  .join('\n');
 writeFileSync(SEMRUSH_OUTPUT, header + body + (body ? '\n' : ''));

 const keywordCount = new Set(clusters.map((c) => c.keyword)).size;
 if (keywordCount === 0) {
  console.log(`No Semrush-driven cannibalization clusters detected (input: ${input}).`);
  console.log(`Output: ${SEMRUSH_OUTPUT}`);
  process.exit(0);
 }
 console.log(`${keywordCount} cannibalization cluster(s) detected across ${clusters.length} URL pairings.`);
 console.log(`Output: ${SEMRUSH_OUTPUT}`);
 // Print top 15 clusters by volume (winner row) for operator triage.
 const byKw = new Map();
 for (const c of clusters) {
  if (!byKw.has(c.keyword)) byKw.set(c.keyword, { volume: c.volume, rows: [] });
  byKw.get(c.keyword).rows.push(c);
 }
 const sortedKw = [...byKw.entries()].sort((a, b) => b[1].volume - a[1].volume).slice(0, 15);
 for (const [kw, { volume, rows }] of sortedKw) {
  console.log(`\n"${kw}" (vol ${volume}, ${rows.length} URLs)`);
  for (const r of rows.slice(0, 5)) console.log(`  pos ${String(r.position).padStart(3)}  ${r.winnerHint === 'WINNER' ? '★' : ' '} ${r.url}`);
  if (rows.length > 5) console.log(`  … +${rows.length - 5} more`);
 }
 process.exit(0);
}

function main() {
 if (process.argv.includes('--semrush')) {
  runSemrushMode();
  return;
 }
 if (!statSync(DIST, { throwIfNoEntry: false })?.isDirectory?.()) {
  console.error(`dist/ not found. Run \`npx vite build\` first.`);
  process.exit(2);
 }

 const files = walk(DIST);
 /** @type {Map<string, Array<{canonical: string, title: string, file: string}>>} */
 const clusters = new Map();

 for (const file of files) {
  let html;
  try {
   html = readFileSync(file, 'utf-8');
  } catch {
   continue; // broken symlink — skip
  }
  if (isNoindex(html)) continue;
  const title = extractTitle(html);
  if (!title) continue;
  const canonical = extractCanonical(html);
  if (!canonical) continue;

  // Require the page to be its own canonical (self-canonical); otherwise
  // it's already a bridge/compat page pointing elsewhere → not a cluster.
  const rel = file.replace(DIST, '').replace(/\/index\.html$/, '/');
  const canonicalPath = canonical.replace(/^https?:\/\/[^/]+/, '');
  if (canonicalPath !== rel) continue;
  if (isJobPath(canonicalPath)) continue;

  const phrase = normalize(title);
  // Require ≥3 words and ≥12 chars so one-word "switzerland"/"ticino"/"locarno"
  // titles (mostly stubs coming from heuristic truncation) don't create false
  // positives.
  if (!phrase || phrase.length < 12 || phrase.split(' ').length < 3) continue;
  if (WHITELIST_PREFIXES.some((p) => phrase.startsWith(p))) continue;

  if (!clusters.has(phrase)) clusters.set(phrase, []);
  clusters.get(phrase).push({ canonical, title, file: rel });
 }

 // Drop clusters whose URLs all collapse to the same locale-agnostic key —
 // those are cross-locale hreflang siblings or time-variants of a single
 // logical page, not cannibalization.
 const flagged = [...clusters.entries()]
  .filter(([, urls]) => {
   if (urls.length < MIN_CLUSTER_SIZE) return false;
   const keys = new Set(urls.map((u) => localeAgnosticKey(u.canonical.replace(/^https?:\/\/[^/]+/, ''))));
   return keys.size > 1;
  })
  .sort((a, b) => b[1].length - a[1].length);

 if (flagged.length === 0) {
  console.log('✅ No cannibalization clusters detected.');
  process.exit(0);
 }

 console.error(`⚠️  ${flagged.length} potential cannibalization cluster(s) detected:\n`);
 for (const [phrase, urls] of flagged.slice(0, 30)) {
  console.error(`• "${phrase}" → ${urls.length} URLs`);
  for (const u of urls.slice(0, 6)) console.error(`    ${u.canonical}`);
  if (urls.length > 6) console.error(`    … +${urls.length - 6} more`);
 }
 if (flagged.length > 30) console.error(`\n… and ${flagged.length - 30} more clusters`);
 process.exit(1);
}

main();
