#!/usr/bin/env node
/**
 * title-audit.mjs — Workstream D.4
 *
 * Extracts `<title>` from every HTML file in `dist/` and flags:
 *   - duplicates across URLs
 *   - length outside the 30-60 character target band
 *     (SERP truncation typically kicks in around 60, and <30 is thin)
 *   - missing primary keyword (heuristic: first path segment after locale
 *     prefix must share at least one non-stopword token with the title)
 *
 * Output:
 *   reports/title-audit-YYYY-MM-DD.json
 *   reports/title-audit-YYYY-MM-DD.md
 *
 * Fail-soft: emits stub report when dist/ is missing / empty.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const MIN_LENGTH = 30;
const MAX_LENGTH = 60;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'at', 'by',
  'il', 'la', 'lo', 'le', 'i', 'gli', 'un', 'una', 'uno', 'di', 'da', 'del', 'della', 'dei', 'delle', 'e', 'ed', 'in', 'su', 'per', 'a', 'tra', 'fra', 'al', 'alla', 'ai', 'alle',
  'der', 'die', 'das', 'und', 'oder', 'für', 'in', 'zu', 'von', 'mit', 'bei', 'auf', 'im', 'am',
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'pour', 'en', 'au', 'aux', 'par',
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

function walkHtml(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'assets' || e.name === 'node_modules') continue;
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.html')) {
        out.push(full);
      }
    }
  }
  return out;
}

function fileToUrlPath(filePath, distRoot) {
  const rel = '/' + relative(distRoot, filePath).split('\\').join('/');
  if (rel === '/index.html') return '/';
  if (rel.endsWith('/index.html')) return rel.slice(0, -'index.html'.length);
  return rel;
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function extractTitle(html) {
  const m = html.match(TITLE_RE);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, ' ').trim();
  // Unescape common HTML entities so length matches user-visible string.
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
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
  // Strip locale prefix, use the most specific leaf slug as keyword proxy.
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
    totals: { pages: 0, withTitle: 0, duplicates: 0, tooShort: 0, tooLong: 0, missingKeyword: 0 },
    duplicates: {}, issues: [],
  };
  writeFileSync(join(args.out, `title-audit-${today}.json`), JSON.stringify(stub, null, 2));
  writeFileSync(join(args.out, `title-audit-${today}.md`), `# Title Audit — ${today}\n\n_${reason}_\n`);
  console.log(`[title-audit] ${reason} — stub written.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dist)) { writeStubReport(args, `dist-missing (${args.dist})`); return; }
  const files = walkHtml(args.dist);
  if (files.length === 0) { writeStubReport(args, 'dist-empty'); return; }

  const byTitle = new Map(); // title → [urls]
  const issues = [];
  let withTitle = 0;

  for (const f of files) {
    const url = fileToUrlPath(f, args.dist);
    let html;
    try { html = readFileSync(f, 'utf-8'); } catch { continue; }
    const title = extractTitle(html);
    if (!title) {
      issues.push({ url, type: 'missing-title', title: null, length: 0 });
      continue;
    }
    withTitle++;
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(url);

    const length = title.length;
    const flags = [];
    if (length < MIN_LENGTH) flags.push('too-short');
    if (length > MAX_LENGTH) flags.push('too-long');

    const kwSource = primaryKeywordSource(url);
    if (kwSource) {
      const slugTokens = tokenize(kwSource);
      const titleTokens = new Set(tokenize(title));
      const overlap = slugTokens.filter((t) => titleTokens.has(t));
      if (slugTokens.length > 0 && overlap.length === 0) flags.push('missing-keyword');
    }

    if (flags.length > 0) {
      issues.push({ url, title, length, flags });
    }
  }

  const duplicates = {};
  for (const [title, urls] of byTitle) {
    if (urls.length > 1) duplicates[title] = urls;
  }

  const tooShort = issues.filter((i) => i.flags?.includes('too-short')).length;
  const tooLong = issues.filter((i) => i.flags?.includes('too-long')).length;
  const missingKeyword = issues.filter((i) => i.flags?.includes('missing-keyword')).length;

  mkdirSync(args.out, { recursive: true });
  const today = isoDate();
  const report = {
    version: 1,
    date: today,
    generatedAt: new Date().toISOString(),
    distRoot: args.dist,
    config: { minLength: MIN_LENGTH, maxLength: MAX_LENGTH },
    totals: {
      pages: files.length,
      withTitle,
      duplicates: Object.keys(duplicates).length,
      tooShort,
      tooLong,
      missingKeyword,
    },
    duplicates,
    issues,
  };
  writeFileSync(join(args.out, `title-audit-${today}.json`), JSON.stringify(report, null, 2));

  const md = [];
  md.push(`# Title Audit — ${today}`);
  md.push('');
  md.push(`- Pages scanned: **${files.length}**`);
  md.push(`- Pages with <title>: **${withTitle}**`);
  md.push(`- Duplicate titles (same title on >1 URL): **${Object.keys(duplicates).length}**`);
  md.push(`- Too short (<${MIN_LENGTH}): **${tooShort}**`);
  md.push(`- Too long (>${MAX_LENGTH}): **${tooLong}**`);
  md.push(`- Missing primary keyword (heuristic): **${missingKeyword}**`);
  md.push('');
  if (Object.keys(duplicates).length > 0) {
    md.push('## Duplicate titles (top 20)');
    md.push('');
    Object.entries(duplicates).slice(0, 20).forEach(([title, urls]) => {
      md.push(`- **${title}** → ${urls.length} URLs`);
      urls.slice(0, 5).forEach((u) => md.push(`  - \`${u}\``));
    });
    md.push('');
  }
  writeFileSync(join(args.out, `title-audit-${today}.md`), md.join('\n'));

  console.log(`[title-audit] ${files.length} pages → duplicates=${Object.keys(duplicates).length} tooShort=${tooShort} tooLong=${tooLong} missingKw=${missingKeyword}`);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('title-audit.mjs');
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[title-audit] fatal:', err);
    try { writeStubReport(parseArgs(process.argv.slice(2)), `fatal: ${err instanceof Error ? err.message : String(err)}`); } catch { /* noop */ }
    process.exit(0);
  }
}

export { extractTitle, tokenize, primaryKeywordSource };
