#!/usr/bin/env node
/**
 * audit-jsonld-no-nested-scripts
 *
 * Zero-tolerance: every JSON-LD payload in dist/ HTML must live inside
 * exactly ONE `<script type="application/ld+json">…</script>` wrapper.
 *
 * Regression caught: GSC "Tipo di valore non corretto" (2026-05-16) on
 * ~80 canton-hub URLs in de/en/fr/it (jobs-im-wallis, find-jobs-valais,
 * trouver-emploi-valais, cerca-lavoro-vallese, …).
 *
 * Root cause: jobsSeoPagesPlugin.ts produced `cantonBreadcrumbLd` already
 * wrapped in `<script type="application/ld+json">…</script>`, then passed
 * it through `buildSeoPageHtml({ jsonLdScripts: [cantonBreadcrumbLd] })`.
 * `buildSimplePage` (htmlTemplate.ts:183) wraps every array entry with the
 * same tag, yielding:
 *
 *   <script type="application/ld+json"><script type="application/ld+json">{…}</script></script>
 *
 * Google parses the outer script's literal-string content as the JSON-LD
 * payload, finds `<script>{…}</script>` (not an object), and flags the
 * page as "wrong value type" / "unparsable structured data". Fixed in
 * PR #317; this audit prevents the regression from any future plugin
 * that pre-wraps a JSON-LD string before handing it to the shell helper.
 *
 * Detection
 * ---------
 * The pattern is unambiguous in dist HTML: an opening
 * `<script type="application/ld+json">` immediately followed (only
 * whitespace allowed) by another `<script` opening tag. Real JSON-LD
 * payloads start with `{` or `[`.
 *
 * Usage:
 *   node scripts/audit-jsonld-no-nested-scripts.mjs
 *   node scripts/audit-jsonld-no-nested-scripts.mjs --limit=20
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((s) => s.startsWith('--limit='));
  return a ? Math.max(1, parseInt(a.split('=')[1], 10) || 30) : 30;
})();

// Matches an `application/ld+json` opening tag whose first non-whitespace
// content is another `<script` opening tag (any attributes, any type).
// Captures the offender's start offset for reporting.
const NESTED_JSONLD_RE =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>\s*<script\b/gi;

async function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith('.html')) out.push(p);
    }
  }
  return out;
}

async function main() {
  const s = await stat(DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(
      `audit-jsonld-no-nested-scripts: dist/ not found at ${DIST}. Run a build first.`,
    );
    process.exit(2);
  }
  const files = await walk(DIST);
  const offenders = [];
  let scanned = 0;
  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!html) continue;
    scanned++;
    // Cheap pre-filter: only run the regex if the file even contains
    // the JSON-LD MIME type substring at all. Skips ~all HTML pages
    // that have no structured data.
    if (!html.includes('application/ld+json')) continue;
    NESTED_JSONLD_RE.lastIndex = 0;
    const matches = html.match(NESTED_JSONLD_RE);
    if (matches && matches.length > 0) {
      offenders.push({ file: relative(ROOT, file), count: matches.length });
    }
  }
  console.log(
    `audit-jsonld-no-nested-scripts: scanned ${scanned} HTML file(s) in dist/`,
  );
  if (offenders.length === 0) {
    console.log('PASS: no nested <script type="application/ld+json"> wrappers in dist/.');
    process.exit(0);
  }
  const totalNests = offenders.reduce((acc, o) => acc + o.count, 0);
  console.error(
    `\nFAIL: ${offenders.length} page(s) ship nested <script type="application/ld+json"> wrappers (${totalNests} total occurrence(s)).`,
  );
  console.error(
    `Google parses the outer wrapper's literal-string content as the JSON-LD payload,`,
  );
  console.error(
    `flagging the page as "Tipo di valore non corretto" / "Wrong value type" in GSC.`,
  );
  console.error(`\nFirst ${Math.min(LIMIT, offenders.length)} offenders:`);
  for (const o of offenders.slice(0, LIMIT)) {
    console.error(`  ${o.file}${o.count > 1 ? ` (${o.count}×)` : ''}`);
  }
  if (offenders.length > LIMIT) {
    console.error(`  ... and ${offenders.length - LIMIT} more`);
  }
  console.error(`\nHow to fix`);
  console.error(`----------`);
  console.error(`The emitter is pre-wrapping JSON-LD in <script type="application/ld+json">…</script>`);
  console.error(`before passing it to a shell helper that wraps it again. Find the offender:`);
  console.error(`  grep -rn '\\\`<script type="application/ld+json">\\\${JSON.stringify' build-plugins/`);
  console.error(`Pass the raw JSON.stringify(...) output to jsonLdScripts[]; let buildSimplePage`);
  console.error(`wrap exactly once. Reference fix: PR #317 (build-plugins/jobsSeoPagesPlugin.ts:7750).`);
  process.exit(1);
}

main().catch((err) => {
  console.error('audit-jsonld-no-nested-scripts: fatal', err);
  process.exit(2);
});
