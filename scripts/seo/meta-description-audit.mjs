#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
/**
 * meta-description-audit.mjs — Workstream D.5
 *
 * Extracts `<meta name="description">` from every HTML file in `dist/`
 * and flags:
 *   - duplicate descriptions (same content on >1 URL)
 *   - length outside the 140-160 character recommendation band
 *   - missing primary keyword (heuristic: shares at least one non-stopword
 *     token with the URL's leaf slug)
 *   - missing description altogether
 *
 * Output:
 *   reports/meta-description-audit-YYYY-MM-DD.json
 *   reports/meta-description-audit-YYYY-MM-DD.md
 * (`--out=` overrides the directory; the post-deploy job points it at /tmp so
 * this audit never mutates the tree it is validating.)
 *
 * Fail-soft: emits stub report when dist/ is missing / empty.
 *
 * The description reader lives in scripts/lib/meta-description-extract.mjs and
 * is shared with scripts/validate-page-seo-quality and
 * tests/dist-duplicate-meta-description.test.ts. It used to be a local pair of
 * regexes requiring quotes around `description`, which made this audit blind to
 * every minified page (`removeAttributeQuotes`, PR #478) — measured on 200
 * production job-funnel pages: 200/200 reported "missing", 0/200 actually
 * missing. Do not re-inline it.
 *
 * MEMORY (report v2). On the reassembled corpus — 6,363,294 files in replay
 * 40068012243 — the v1 script died `Reached heap limit` at 4 GB: it built an
 * array of every absolute path (`path.join` cons-strings, ~950 B each, ~5.9 GB
 * before reading one page), a Map description → EVERY url, one issue object per
 * flagged page, and then a single `JSON.stringify` of all of it, which beyond
 * ~1.6M pages exceeds V8's max string length and was caught into a stub report
 * with exit 0 — a crash reported as a PASS. Now: the walk yields one path at a
 * time from frames of directory NAMES; duplicates are keyed by a 72-bit hash of
 * the description, holding only the page ordinal for singletons (their urls
 * are spooled to a temp file, UrlSpool) and a count plus at most MAX_DUP_URLS
 * urls per duplicated group; issues are COUNTED in full and
 * kept as a bounded sample per kind. Same pages, same flags, same totals.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, writeSync, readSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMetaDescription } from '../lib/meta-description-extract.mjs';
import { walkHtml } from './lib/walk-html.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const MIN_LENGTH = 140;
const MAX_LENGTH = 160;
/** Example urls kept per duplicated description (the count is always exact). */
const MAX_DUP_URLS = 5;
/** Issues kept per kind in the JSON (counts are always exact). */
const MAX_ISSUE_SAMPLES = 1000;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'at', 'by', 'with',
  'il', 'la', 'lo', 'le', 'i', 'gli', 'un', 'una', 'uno', 'di', 'da', 'del', 'della', 'dei', 'delle', 'e', 'ed', 'su', 'per', 'tra', 'fra', 'al', 'alla', 'ai', 'alle', 'che', 'con',
  'der', 'die', 'das', 'und', 'oder', 'für', 'zu', 'von', 'mit', 'bei', 'auf', 'im', 'am', 'den', 'dem',
  'les', 'des', 'du', 'et', 'ou', 'pour', 'en', 'au', 'aux', 'par', 'avec',
]);

function isoDate(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseArgs(argv) {
  const args = { dist: join(ROOT, 'dist'), out: join(ROOT, 'reports') };
  for (const a of argv) {
    if (a.startsWith('--dist=')) args.dist = resolve(a.slice(7));
    else if (a.startsWith('--out=')) args.out = resolve(a.slice(6));
  }
  return args;
}


/** 72-bit digest of a description: the Map key instead of the text itself. */
function descKey(desc) {
  return createHash('sha1').update(desc).digest('base64').slice(0, 12);
}

function fileToUrlPath(filePath, distRoot) {
  const rel = '/' + relative(distRoot, filePath).split('\\').join('/');
  if (rel === '/index.html') return '/';
  if (rel.endsWith('/index.html')) return rel.slice(0, -'index.html'.length);
  return rel;
}

function tokenize(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function primaryKeywordSource(urlPath) {
  const stripped = urlPath.replace(/^\/(en|de|fr)(?=\/|$)/, '') || '/';
  const parts = stripped.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
}

function writeStubReport(args, reason) {
  mkdirSync(args.out, { recursive: true });
  const today = isoDate();
  const stub = {
    version: 1, date: today, generatedAt: new Date().toISOString(), distRoot: args.dist, reason,
    totals: { pages: 0, withDescription: 0, missing: 0, duplicates: 0, tooShort: 0, tooLong: 0, missingKeyword: 0 },
    duplicates: {}, issues: [],
  };
  writeFileSync(join(args.out, `meta-description-audit-${today}.json`), JSON.stringify(stub, null, 2));
  writeFileSync(join(args.out, `meta-description-audit-${today}.md`), `# Meta Description Audit — ${today}\n\n_${reason}_\n`);
  console.log(`[meta-description-audit] ${reason} — stub written.`);
}

/**
 * `report` plus a `duplicates` object ({ [description]: { count, urls } }),
 * written group by group: the corpus has hundreds of thousands of duplicated
 * descriptions, and one JSON string holding all of them is what v1 could not
 * build.
 */
function writeReportJson(file, report, duplicateGroups) {
  const fd = openSync(file, 'w');
  try {
    const head = JSON.stringify(report, null, 2);
    writeSync(fd, `${head.slice(0, head.lastIndexOf('\n}'))},\n  "duplicates": {`);
    let first = true;
    for (const g of duplicateGroups) {
      writeSync(fd, `${first ? '' : ','}\n    ${JSON.stringify(g.desc)}: ${JSON.stringify({ count: g.count, urls: g.urls })}`);
      first = false;
    }
    writeSync(fd, `${first ? '' : '\n  '}}\n}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Urls of every described page, on DISK: one line per page in a temp file,
 * plus the byte offset of each line in an off-heap Float64Array. The dedup Map
 * then holds only the page ORDINAL of a singleton (a small integer), and the
 * first url is read back from the file only when a second page shares the
 * description. The heap no longer grows with one url string per page.
 */
class UrlSpool {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'meta-description-urls-'));
    this.fd = openSync(join(this.dir, 'urls'), 'w+');
    this.offsets = new Float64Array(1 << 20);
    this.count = 0;
    this.pos = 0;
  }
  push(url) {
    if (this.count + 1 >= this.offsets.length) {
      const grown = new Float64Array(this.offsets.length * 2);
      grown.set(this.offsets);
      this.offsets = grown;
    }
    const bytes = Buffer.from(url, 'utf8');
    writeSync(this.fd, bytes, 0, bytes.length, this.pos);
    this.offsets[this.count] = this.pos;
    this.pos += bytes.length;
    this.offsets[this.count + 1] = this.pos;
    return this.count++;
  }
  get(ordinal) {
    const start = this.offsets[ordinal];
    const buf = Buffer.alloc(this.offsets[ordinal + 1] - start);
    readSync(this.fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  }
  close() {
    closeSync(this.fd);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dist)) { writeStubReport(args, `dist-missing (${args.dist})`); return; }

  // key -> ordinal of the first page in `spool` while the description is unique
  // on the site, -> { desc, count, urls[<=MAX_DUP_URLS] } from its second
  // occurrence on.
  const byDesc = new Map();
  const spool = new UrlSpool();
  const duplicateGroups = [];
  const samples = { 'missing-description': [], 'too-short': [], 'too-long': [], 'missing-keyword': [] };
  let pages = 0;
  let withDescription = 0;
  let missing = 0;
  let tooShort = 0;
  let tooLong = 0;
  let missingKeyword = 0;
  let flaggedPages = 0;

  for (const f of walkHtml(args.dist)) {
    pages++;
    const url = fileToUrlPath(f, args.dist);
    let html;
    try { html = readFileSync(f, 'utf-8'); } catch { continue; }
    const desc = extractMetaDescription(html);
    html = undefined;
    if (!desc) {
      missing++;
      if (samples['missing-description'].length < MAX_ISSUE_SAMPLES) {
        samples['missing-description'].push({ url, type: 'missing-description', description: null, length: 0 });
      }
      continue;
    }
    withDescription++;
    const key = descKey(desc);
    const seen = byDesc.get(key);
    if (seen === undefined) {
      byDesc.set(key, spool.push(url));
    } else if (typeof seen === 'number') {
      const group = { desc, count: 2, urls: [spool.get(seen), url] };
      byDesc.set(key, group);
      duplicateGroups.push(group);
    } else {
      seen.count++;
      if (seen.urls.length < MAX_DUP_URLS) seen.urls.push(url);
    }

    const length = desc.length;
    const flags = [];
    if (length < MIN_LENGTH) flags.push('too-short');
    if (length > MAX_LENGTH) flags.push('too-long');

    const kwSource = primaryKeywordSource(url);
    if (kwSource) {
      const slugTokens = tokenize(kwSource);
      const descTokens = new Set(tokenize(desc));
      const overlap = slugTokens.filter((t) => descTokens.has(t));
      if (slugTokens.length > 0 && overlap.length === 0) flags.push('missing-keyword');
    }

    if (flags.length > 0) {
      flaggedPages++;
      for (const flag of flags) {
        if (flag === 'too-short') tooShort++;
        else if (flag === 'too-long') tooLong++;
        else missingKeyword++;
        if (samples[flag].length < MAX_ISSUE_SAMPLES) samples[flag].push({ url, description: desc, length, flags });
      }
    }
  }
  byDesc.clear();
  spool.close();
  if (pages === 0) { writeStubReport(args, 'dist-empty'); return; }

  const duplicateCount = duplicateGroups.length;

  mkdirSync(args.out, { recursive: true });
  const today = isoDate();
  const report = {
    version: 2,
    date: today,
    generatedAt: new Date().toISOString(),
    distRoot: args.dist,
    config: { minLength: MIN_LENGTH, maxLength: MAX_LENGTH, maxDupUrls: MAX_DUP_URLS, maxIssueSamples: MAX_ISSUE_SAMPLES },
    totals: {
      pages,
      withDescription,
      missing,
      duplicates: duplicateCount,
      duplicatePages: duplicateGroups.reduce((n, g) => n + g.count, 0),
      tooShort, tooLong, missingKeyword,
      flaggedPages,
    },
    // Exact counts are in `totals`; each kind keeps its first MAX_ISSUE_SAMPLES.
    issueSamples: samples,
  };
  writeReportJson(join(args.out, `meta-description-audit-${today}.json`), report, duplicateGroups);

  const md = [];
  md.push(`# Meta Description Audit — ${today}`);
  md.push('');
  md.push(`- Pages scanned: **${pages}**`);
  md.push(`- Pages with description: **${withDescription}**`);
  md.push(`- Missing description: **${missing}**`);
  md.push(`- Duplicate descriptions: **${duplicateCount}**`);
  md.push(`- Too short (<${MIN_LENGTH}): **${tooShort}**`);
  md.push(`- Too long (>${MAX_LENGTH}): **${tooLong}**`);
  md.push(`- Missing primary keyword: **${missingKeyword}**`);
  md.push('');
  if (duplicateCount > 0) {
    md.push('## Duplicate descriptions (top 20)');
    md.push('');
    duplicateGroups.slice(0, 20).forEach((g) => {
      md.push(`- _${g.desc.slice(0, 80)}…_ → ${g.count} URLs`);
      g.urls.slice(0, 5).forEach((u) => md.push(`  - \`${u}\``));
    });
    md.push('');
  }
  const missingUrls = samples['missing-description'].map((i) => i.url);
  if (missingUrls.length > 0) {
    md.push('## Missing description (top 50)');
    md.push('');
    missingUrls.slice(0, 50).forEach((u) => md.push(`- \`${u}\``));
    md.push('');
  }
  writeFileSync(join(args.out, `meta-description-audit-${today}.md`), md.join('\n'));

  console.log(`[meta-description-audit] ${pages} pages → duplicates=${duplicateCount} tooShort=${tooShort} tooLong=${tooLong} missingKw=${missingKeyword} missing=${missing}`);
  // The report files live on the runner and are not uploaded on a green run,
  // so the offenders have to reach STDOUT or nobody ever reads them — the
  // "muto" half of the defect this script was fixed for.
  missingUrls.slice(0, 20).forEach((u) => console.log(`[meta-description-audit] missing-description ${u}`));
  if (missing > 20) {
    console.log(`[meta-description-audit] … +${missing - 20} altre URL senza description (campione nel JSON)`);
  }
}

const invokedDirectly = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // A crash is not a report. v1 wrote a stub and exited 0 here, so the
    // `Invalid string length` of a too-large report read as a PASS.
    console.error('[meta-description-audit] fatal:', err);
    try { writeStubReport(parseArgs(process.argv.slice(2)), `fatal: ${err instanceof Error ? err.message : String(err)}`); } catch { /* noop */ }
    process.exit(1);
  }
}

export { extractMetaDescription, tokenize, primaryKeywordSource };
