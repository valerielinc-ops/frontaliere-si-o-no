/**
 * listing-url-fallback-audit.mjs — how much does the list-page fallback of
 * `listing.url` (to CAREER_URL & co.) cost, per ATS family? (issue #9679, parent #8060 item 2)
 *
 * The idiom lets a parser publish the careers LIST page as a job's `url` /
 * `applyUrl` whenever the source gave no per-vacancy detail URL. Most parsers
 * then hash that URL into the job id, so every listing that lost its detail
 * URL collides on the same id. `isTrustedDomain()` never notices: the list page
 * is on the employer's own host.
 *
 * This module is the deterministic half of the measurement: pure functions
 * over (parser source text, published crawler slice). It performs no network
 * I/O and does not import any parser, so it can classify all candidates in a
 * few milliseconds and its answer only depends on the repository content.
 *
 * What it can see: the loss that REACHED the published slice — jobs whose
 * `url`/`applyUrl` equals the parser's fallback constant, plus the id / URL
 * collisions that follow. What it cannot see: listings a parser silently drops
 * before the fallback; those never leave the runner.
 */

/**
 * The static predicate of issue #9679, identical to its reproduction command:
 *   rg -l 'listing\.url\s*\|\|\s*(CAREER_URL|PUBLIC_CAREER_URL|[A-Z_]+_URL)' scripts/lib
 */
export const LISTING_URL_FALLBACK_RE = /listing\.url\s*\|\|\s*(CAREER_URL|PUBLIC_CAREER_URL|[A-Z_]+_URL)/;

export const PARSER_FILE_RE = /-job-parser\.mjs$/;

/**
 * Ordered rules. Classification looks at the IMPORT SPECIFIERS first (a
 * parser that imports a dedicated ATS client belongs to that ATS), then at the
 * comment-stripped code for the tenant host (hand-written jobs2web / Workday /
 * Umantis scrapers that do not use the shared client). Comments are ignored on
 * purpose: parsers routinely explain why they do NOT use another ATS client.
 */
export const FAMILY_RULES = Object.freeze([
  { family: 'workday', imports: /ats-clients\/workday-client\.mjs/, code: /myworkdayjobs\.com/ },
  { family: 'smartrecruiters', imports: /ats-clients\/smartrecruiters-client\.mjs/, code: /smartrecruiters\.com/ },
  { family: 'greenhouse', imports: /ats-clients\/greenhouse-client\.mjs/, code: /greenhouse\.io/ },
  { family: 'lever', imports: /ats-clients\/lever-client\.mjs/, code: /jobs\.lever\.co/ },
  { family: 'successfactors', imports: /ats-clients\/successfactors-client\.mjs|successfactors-jobs2web-widget-guard\.mjs/, code: /successfactors\.(?:eu|com)|jobs2web|j2w/ },
  { family: 'umantis', imports: /umantis-(?:listing-common|empty-listing)\.mjs/, code: /\.umantis\.com/ },
  { family: 'refline', imports: /refline-common\.mjs/, code: /refline\.ch/ },
  { family: 'softgarden', imports: /softgarden/, code: /softgarden\.io/ },
  { family: 'pastahr', imports: /pastahr-widget-client\.mjs/, code: null },
  { family: 'prospector-spec', imports: /prospector\/spec-crawler\.mjs/, code: null },
  { family: 'playwright', imports: /ats-clients\/playwright-runtime\.mjs/, code: null },
  { family: 'jobposting-jsonld', imports: /jobposting-jsonld\.mjs/, code: null },
  { family: 'custom-json', imports: /assert-json-list-shape\.mjs/, code: null },
]);

export const FALLBACK_FAMILY = 'custom-html';

/** Drop block and line comments; keep `https://` inside string literals. */
export function stripParserComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** @param {string} source */
export function classifyFamily(source) {
  const imports = [...String(source).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).join('\n');
  for (const rule of FAMILY_RULES) {
    if (rule.imports.test(imports)) return rule.family;
  }
  const code = stripParserComments(source);
  for (const rule of FAMILY_RULES) {
    if (rule.code && rule.code.test(code)) return rule.family;
  }
  return FALLBACK_FAMILY;
}

const CONST_DECL_RE = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*([\s\S]*?);/g;

/**
 * Resolve a module-level string constant: quoted literal, template literal
 * over other resolvable constants, or a bare alias. Anything else (function
 * calls, `new URL(...)`, env reads) resolves to null — reported, never guessed.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string|null}
 */
export function resolveStringConstant(source, name) {
  const decls = new Map();
  for (const m of source.matchAll(CONST_DECL_RE)) {
    if (!decls.has(m[1])) decls.set(m[1], m[2].trim());
  }
  const seen = new Set();
  const resolve = (id) => {
    if (seen.has(id)) return null;
    seen.add(id);
    const expr = decls.get(id);
    if (expr == null) return null;
    let m = expr.match(/^'([^'\\]*)'$/) || expr.match(/^"([^"\\]*)"$/);
    if (m) return m[1];
    m = expr.match(/^`([^`\\]*)`$/);
    if (m) {
      let failed = false;
      const out = m[1].replace(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/g, (_, ref) => {
        const value = resolve(ref);
        if (value == null) failed = true;
        return value ?? '';
      });
      return failed || /\$\{/.test(out) ? null : out;
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(expr)) return resolve(expr);
    return null;
  };
  return resolve(name);
}

/**
 * @param {string} fileName basename, e.g. `scandit-job-parser.mjs`
 * @param {string} source
 * @returns {null | {
 *   parser: string, crawlerKey: string|null, family: string,
 *   fallbackConst: string, fallbackUrl: string|null, idFromUrl: boolean,
 * }}
 */
export function scanParserSource(fileName, source) {
  const match = source.match(LISTING_URL_FALLBACK_RE);
  if (!match) return null;
  const fallbackConst = match[1];
  const keyMatch = source.match(/export\s+const\s+[A-Z0-9_]+_KEY\s*=\s*['"]([^'"]+)['"]/);
  return {
    parser: fileName.replace(PARSER_FILE_RE, ''),
    crawlerKey: keyMatch ? keyMatch[1] : null,
    family: classifyFamily(source),
    fallbackConst,
    fallbackUrl: resolveStringConstant(source, fallbackConst),
    // Does the job id hash the (possibly fallback) public URL? Then a missing
    // detail URL is also an id collision, not just a wrong link.
    idFromUrl: /createHash\([^)]*\)\s*\.update\(\s*publicUrl\s*\)/.test(source),
  };
}

/**
 * Trailing slash and host case do not make a different page. The fragment
 * DOES identify a listing on single-page boards (Franklin `#para_4660`,
 * Galenica, Bellinzona), exactly as `scripts/lib/job-url-key.mjs` keeps it.
 */
export function normalizeListingUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function countExtraDuplicates(values) {
  const seen = new Map();
  for (const v of values) {
    if (!v) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  let extra = 0;
  for (const n of seen.values()) if (n > 1) extra += n - 1;
  return extra;
}

/**
 * @param {Array<Record<string, unknown>>} jobs published jobs of ONE crawler slice
 * @param {string|null} fallbackUrl
 */
export function measureSlice(jobs, fallbackUrl) {
  const list = Array.isArray(jobs) ? jobs : [];
  const fallback = normalizeListingUrl(fallbackUrl);
  let missingDetailUrl = 0;
  let fallbackEmissions = 0;
  for (const job of list) {
    const url = normalizeListingUrl(job?.url);
    const applyUrl = normalizeListingUrl(job?.applyUrl);
    if (!url) missingDetailUrl += 1;
    if (fallback && (url === fallback || applyUrl === fallback)) fallbackEmissions += 1;
  }
  return {
    total: list.length,
    missingDetailUrl,
    fallbackEmissions,
    duplicateIds: countExtraDuplicates(list.map((j) => String(j?.id || ''))),
    duplicateUrls: countExtraDuplicates(list.map((j) => normalizeListingUrl(j?.url))),
  };
}

const EMPTY_TOTALS = Object.freeze({
  parsers: 0, withSlice: 0, unresolvedFallback: 0, total: 0,
  missingDetailUrl: 0, fallbackEmissions: 0, duplicateIds: 0, duplicateUrls: 0,
});

/**
 * @param {Array<{ fileName: string, source: string }>} parserFiles
 * @param {(crawlerKey: string) => Array<Record<string, unknown>>|null} loadSlice
 *   returns the slice's jobs, or null when the crawler has no published slice
 */
export function auditListingUrlFallback(parserFiles, loadSlice) {
  const rows = [];
  for (const { fileName, source } of [...parserFiles].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    if (!PARSER_FILE_RE.test(fileName)) continue;
    const scanned = scanParserSource(fileName, source);
    if (!scanned) continue;
    const jobs = scanned.crawlerKey ? loadSlice(scanned.crawlerKey) : null;
    rows.push({
      ...scanned,
      slice: jobs ? 'present' : 'absent',
      ...measureSlice(jobs || [], scanned.fallbackUrl),
    });
  }

  const byFamily = new Map();
  for (const row of rows) {
    const t = byFamily.get(row.family) || { family: row.family, ...EMPTY_TOTALS };
    t.parsers += 1;
    if (row.slice === 'present') t.withSlice += 1;
    if (!row.fallbackUrl) t.unresolvedFallback += 1;
    for (const k of ['total', 'missingDetailUrl', 'fallbackEmissions', 'duplicateIds', 'duplicateUrls']) t[k] += row[k];
    byFamily.set(row.family, t);
  }
  const families = [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family));
  const totals = families.reduce((acc, f) => {
    for (const k of Object.keys(EMPTY_TOTALS)) acc[k] += f[k];
    return acc;
  }, { ...EMPTY_TOTALS });

  return {
    candidates: rows.length,
    classified: rows.filter((r) => r.crawlerKey && r.family).length,
    rows,
    families,
    totals,
    lossyParsers: rows.filter((r) => r.fallbackEmissions > 0 || r.missingDetailUrl > 0).map((r) => r.parser),
  };
}

/** @param {ReturnType<typeof auditListingUrlFallback>} report */
export function formatMarkdown(report) {
  const lines = [];
  lines.push(`candidates=${report.candidates} classified=${report.classified}/${report.candidates}`);
  lines.push('');
  lines.push('| famiglia | parser | con slice | fallback non risolto | annunci | url vuota | url=fallback | id duplicati | url duplicate |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const f of [...report.families, { family: 'TOTALE', ...report.totals }]) {
    lines.push(`| ${f.family} | ${f.parsers} | ${f.withSlice} | ${f.unresolvedFallback} | ${f.total} | ${f.missingDetailUrl} | ${f.fallbackEmissions} | ${f.duplicateIds} | ${f.duplicateUrls} |`);
  }
  lines.push('');
  lines.push(`parser con perdita riproducibile: ${report.lossyParsers.length ? report.lossyParsers.join(', ') : 'nessuno'}`);
  return lines.join('\n');
}
