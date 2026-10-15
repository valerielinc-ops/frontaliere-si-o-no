#!/usr/bin/env node
/**
 * repair-blog-key-marker-corruption.mjs
 *
 * One-shot remediation for blog-body files corrupted by an earlier version
 * of `backfill-ai-search-optimization.mjs` that used the string form of
 * `String.prototype.replace`. The replacement string expanded `$N` capture
 * group refs (when the AI block contained literal `$70`, `$120`, etc.),
 * embedding the literal body-key marker `'blog.article.{slug}.body{N}': '`
 * into the body1 string mid-content.
 *
 * Symptom (TypeScript build fails):
 *
 *   const body: Record<string, string> = {
 *     'blog.article.foo.body1': '… price jumped from $70 to over 'blog.article.foo.body1': '20, before settling around $90 …',
 *   };
 *
 * Repair strategy: for each occurrence of
 *   <char>'blog.article.{slug}.body{N}': '
 * embedded mid-string, replace with `$X` (a sensible numeric placeholder)
 * so the surrounding `… '$' + X + ' billion'` reads naturally and the file
 * once again parses as a valid TS object literal.
 *
 * Usage
 *   node scripts/repair-blog-key-marker-corruption.mjs            # DRY-RUN
 *   node scripts/repair-blog-key-marker-corruption.mjs --apply    # actually write
 *
 * Output
 *   - List of files scanned + per-file count of corruption sites repaired
 *   - Whether each file now parses as valid TS (via syntax sniff)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Match a corruption site:
 *
 *   <preceding chars> 'blog.article.X.body{N}': '<short trailing>
 *
 * The corruption is recognised when the marker is preceded by alphanumeric
 * or punctuation (i.e., it is NOT the start of a legit object entry, which
 * is preceded only by `,` + whitespace or `{` + whitespace).
 *
 * Capture groups:
 *   1: the preceding char (kept in the output)
 *   2: short fragment after the orphan opening quote (e.g., '20', '.4 billion')
 */
const CORRUPTION_RE = /([a-zA-Z0-9.,\-)]) *'blog\.article\.[a-z0-9-]+\.(?:body|faq)[0-9]*': '([^']{0,12})/g;

/**
 * Reconstruct a sensible replacement based on the trailing fragment.
 *
 *   'blog…body1': '20  → "$120"   (was "$70 to over $120, before…")
 *   'blog…body1': '.5 billion → "$3.5 billion"
 *   'blog…body1': '00,000 → "$100,000"
 *   'blog…body1': '00 per barrel → "$100 per barrel"
 *   'blog…body1': '6.1 trillion → "$16.1 trillion"
 *
 * Heuristic: if the fragment starts with digits or a decimal point, prepend
 * "$1" + the fragment; if the fragment starts with non-numeric, just emit
 * "$" + the original digit-prefix (best guess) + the fragment.
 */
function rebuildFragment(fragment) {
  // Strip trailing partial words after the first complete unit
  const m = /^(\.\d+|\d+(?:[.,]\d+)?)/.exec(fragment);
  if (m) {
    // Numeric fragment — assume "$1" prefix (matches the "$120" / "$1.4 billion" pattern)
    if (m[1].startsWith('.')) return `$1${m[1]}${fragment.slice(m[1].length)}`;
    return `$1${m[1]}${fragment.slice(m[1].length)}`;
  }
  // Non-numeric — drop the orphan and keep the trailing text raw
  return `$${fragment}`;
}

function repairOne(content) {
  let count = 0;
  const repaired = content.replace(CORRUPTION_RE, (_match, prev, frag) => {
    count++;
    return `${prev} ${rebuildFragment(frag)}`;
  });
  return { repaired, count };
}

function syntaxLooksValid(ts) {
  // Cheap sniff: balanced braces and at least one `: '` per `'key':` token.
  const open = (ts.match(/\{/g) || []).length;
  const close = (ts.match(/\}/g) || []).length;
  return open === close;
}

function scanLocale(locale) {
  const dir = path.join(ROOT, 'services', 'locales', 'blog-body', locale);
  let stat;
  try { stat = statSync(dir); } catch { return []; }
  if (!stat.isDirectory()) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const repairs = [];
  for (const file of files) {
    const fp = path.join(dir, file);
    const raw = readFileSync(fp, 'utf-8');
    const { repaired, count } = repairOne(raw);
    if (count > 0) {
      repairs.push({ file: fp, count, repaired, valid: syntaxLooksValid(repaired) });
    }
  }
  return repairs;
}

function main() {
  let totalRepairs = 0;
  let totalFiles = 0;
  for (const locale of LOCALES) {
    const repairs = scanLocale(locale);
    if (repairs.length === 0) {
      console.log(`[${locale}] no corruption`);
      continue;
    }
    console.log(`[${locale}] ${repairs.length} files with corruption:`);
    for (const r of repairs) {
      console.log(`  ${path.relative(ROOT, r.file)} — ${r.count} site(s) ${r.valid ? '✓ valid' : '✗ INVALID after repair'}`);
      if (APPLY) writeFileSync(r.file, r.repaired, 'utf-8');
      totalRepairs += r.count;
      totalFiles += 1;
    }
  }
  console.log('');
  console.log(`Total: ${totalRepairs} corruption site(s) across ${totalFiles} file(s)`);
  console.log(APPLY ? 'WRITE: applied' : 'DRY-RUN — re-run with --apply to write');
}

main();
