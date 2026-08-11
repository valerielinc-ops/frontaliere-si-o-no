#!/usr/bin/env node
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
 * is shared with scripts/validate-page-seo-quality.mjs and
 * tests/dist-duplicate-meta-description.test.ts. It used to be a local pair of
 * regexes requiring quotes around `description`, which made this audit blind to
 * every minified page (`removeAttributeQuotes`, PR #478) — measured on 200
 * production job-funnel pages: 200/200 reported "missing", 0/200 actually
 * missing. Do not re-inline it.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMetaDescription } from '../lib/meta-description-extract.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const MIN_LENGTH = 140;
const MAX_LENGTH = 160;

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dist)) { writeStubReport(args, `dist-missing (${args.dist})`); return; }
  const files = walkHtml(args.dist);
  if (files.length === 0) { writeStubReport(args, 'dist-empty'); return; }

  const byDesc = new Map();
  const issues = [];
  let withDescription = 0;
  let missing = 0;

  for (const f of files) {
    const url = fileToUrlPath(f, args.dist);
    let html;
    try { html = readFileSync(f, 'utf-8'); } catch { continue; }
    const desc = extractMetaDescription(html);
    if (!desc) {
      missing++;
      issues.push({ url, type: 'missing-description', description: null, length: 0 });
      continue;
    }
    withDescription++;
    if (!byDesc.has(desc)) byDesc.set(desc, []);
    byDesc.get(desc).push(url);

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
      issues.push({ url, description: desc, length, flags });
    }
  }

  const duplicates = {};
  for (const [desc, urls] of byDesc) {
    if (urls.length > 1) duplicates[desc] = urls;
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
      withDescription,
      missing,
      duplicates: Object.keys(duplicates).length,
      tooShort, tooLong, missingKeyword,
    },
    duplicates,
    issues,
  };
  writeFileSync(join(args.out, `meta-description-audit-${today}.json`), JSON.stringify(report, null, 2));

  const md = [];
  md.push(`# Meta Description Audit — ${today}`);
  md.push('');
  md.push(`- Pages scanned: **${files.length}**`);
  md.push(`- Pages with description: **${withDescription}**`);
  md.push(`- Missing description: **${missing}**`);
  md.push(`- Duplicate descriptions: **${Object.keys(duplicates).length}**`);
  md.push(`- Too short (<${MIN_LENGTH}): **${tooShort}**`);
  md.push(`- Too long (>${MAX_LENGTH}): **${tooLong}**`);
  md.push(`- Missing primary keyword: **${missingKeyword}**`);
  md.push('');
  if (Object.keys(duplicates).length > 0) {
    md.push('## Duplicate descriptions (top 20)');
    md.push('');
    Object.entries(duplicates).slice(0, 20).forEach(([desc, urls]) => {
      md.push(`- _${desc.slice(0, 80)}…_ → ${urls.length} URLs`);
      urls.slice(0, 5).forEach((u) => md.push(`  - \`${u}\``));
    });
    md.push('');
  }
  const missingUrls = issues.filter((i) => i.type === 'missing-description').map((i) => i.url);
  if (missingUrls.length > 0) {
    md.push('## Missing description (top 50)');
    md.push('');
    missingUrls.slice(0, 50).forEach((u) => md.push(`- \`${u}\``));
    md.push('');
  }
  writeFileSync(join(args.out, `meta-description-audit-${today}.md`), md.join('\n'));

  console.log(`[meta-description-audit] ${files.length} pages → duplicates=${Object.keys(duplicates).length} tooShort=${tooShort} tooLong=${tooLong} missingKw=${missingKeyword} missing=${missing}`);
  // The report files live on the runner and are not uploaded on a green run,
  // so the offenders have to reach STDOUT or nobody ever reads them — the
  // "muto" half of the defect this script was fixed for.
  missingUrls.slice(0, 20).forEach((u) => console.log(`[meta-description-audit] missing-description ${u}`));
  if (missingUrls.length > 20) {
    console.log(`[meta-description-audit] … +${missingUrls.length - 20} altre URL senza description (elenco completo nel JSON)`);
  }
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('meta-description-audit.mjs');
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[meta-description-audit] fatal:', err);
    try { writeStubReport(parseArgs(process.argv.slice(2)), `fatal: ${err instanceof Error ? err.message : String(err)}`); } catch { /* noop */ }
    process.exit(0);
  }
}

export { extractMetaDescription, tokenize, primaryKeywordSource };
