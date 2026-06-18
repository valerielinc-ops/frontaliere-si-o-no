#!/usr/bin/env node
/**
 * Validate the output of a per-locale shard build (BUILD_LOCALE=<loc>).
 *
 * Asserts, for the locale(s) this shard was responsible for:
 *   1. The target locale subtree has pages (count > 0).
 *   2. The OTHER locales' subtrees were NOT emitted (the filter dropped them).
 *      - For a non-`it` shard: the root (it) pages are also absent.
 *      - For the `it` shard: en/de/fr subtrees are empty but the root has pages.
 *   3. A sampled page from the target subtree carries a COMPLETE hreflang
 *      block — all four locales + x-default — proving the cross-locale
 *      coupling is preserved even though only one locale was emitted.
 *
 * Usage: BUILD_LOCALE=en node scripts/ci/validate-locale-shard-build.mjs [distDir]
 * Exits non-zero on any failed assertion (CI gate).
 */
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.argv[2] || 'dist');
const rawLocale = (process.env.BUILD_LOCALE || '').trim().toLowerCase();
const ALL = ['it', 'en', 'de', 'fr'];
const emit = rawLocale
  ? rawLocale.split(',').map((s) => s.trim()).filter((l) => ALL.includes(l))
  : ALL.slice();

if (emit.length === 0) {
  console.error(`✖ BUILD_LOCALE=${JSON.stringify(rawLocale)} resolved to no valid locales`);
  process.exit(1);
}

/** Count index.html files under a directory (recursive, bounded, no symlinks). */
function countPages(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && (e.name === 'index.html' || e.name.endsWith('.html'))) n++;
    }
  }
  return n;
}

/** Count it (root) pages — top-level html files not under a locale prefix. */
function countItPages() {
  let n = 0;
  if (!fs.existsSync(distDir)) return 0;
  for (const e of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (['en', 'de', 'fr', 'assets', 'data', 'og'].includes(e.name)) continue;
    const full = path.join(distDir, e.name);
    if (e.isDirectory()) n += countPages(full);
    else if (e.isFile() && e.name.endsWith('.html')) n++;
  }
  return n;
}

/** Find one sample HTML page inside a locale's subtree (or root for it). */
function sampleHtml(locale) {
  const root = locale === 'it' ? distDir : path.join(distDir, locale);
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      // For it, never descend into the other locale subtrees.
      if (locale === 'it' && cur === distDir && ['en', 'de', 'fr', 'assets', 'data', 'og'].includes(e.name)) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name === 'index.html') return full;
    }
  }
  return null;
}

const counts = {
  it: countItPages(),
  en: countPages(path.join(distDir, 'en')),
  de: countPages(path.join(distDir, 'de')),
  fr: countPages(path.join(distDir, 'fr')),
};

console.log(`Locale shard validation — BUILD_LOCALE=${rawLocale || '(all)'} → emit [${emit.join(', ')}]`);
console.log(`dist: ${distDir}`);
console.log(`page counts: it=${counts.it}  en=${counts.en}  de=${counts.de}  fr=${counts.fr}`);

const errors = [];

// (1) target locales must have pages
for (const loc of emit) {
  if (counts[loc] <= 0) errors.push(`expected pages for emitted locale '${loc}', found ${counts[loc]}`);
}

// (2) non-emitted locales must be empty
for (const loc of ALL) {
  if (!emit.includes(loc) && counts[loc] > 0) {
    errors.push(`locale '${loc}' was NOT in the shard set but emitted ${counts[loc]} pages (filter leak)`);
  }
}

// (3) hreflang completeness on a sampled page from each emitted locale
for (const loc of emit) {
  const sample = sampleHtml(loc);
  if (!sample) {
    errors.push(`no sample index.html found for emitted locale '${loc}'`);
    continue;
  }
  const html = fs.readFileSync(sample, 'utf-8');
  const rel = path.relative(distDir, sample);
  const missing = ALL.filter((l) => !new RegExp(`hreflang=["']${l}["']`).test(html));
  const hasXDefault = /hreflang=["']x-default["']/.test(html);
  if (missing.length || !hasXDefault) {
    errors.push(
      `sample ${rel} (locale ${loc}) has incomplete hreflang: ` +
      `missing locales [${missing.join(', ') || 'none'}]${hasXDefault ? '' : ' + x-default'}`,
    );
  } else {
    console.log(`✓ ${loc}: ${rel} → complete hreflang (it/en/de/fr + x-default)`);
  }
}

// (4) Sitemap cross-locale completeness (Fase 4) — only on the it/main shard,
// which owns the root sitemaps. Proves the render-skips did NOT drop sibling-
// locale entries: a root sitemap with xhtml:link alternates must reference all
// four locales. Catches the manifest-divergence trap at the gate.
if (emit.includes('it')) {
  const smCandidates = [];
  try {
    for (const e of fs.readdirSync(distDir)) {
      if (/^sitemap.*\.xml$/.test(e)) smCandidates.push(path.join(distDir, e));
    }
  } catch { /* no dist root */ }
  const smWithAlts = smCandidates.find((p) => {
    try { return /xhtml:link[^>]*hreflang=/.test(fs.readFileSync(p, 'utf-8')); } catch { return false; }
  });
  if (!smWithAlts) {
    console.log('ℹ (4) no root sitemap with xhtml:link alternates found — skipping sitemap-completeness check');
  } else {
    const xml = fs.readFileSync(smWithAlts, 'utf-8');
    const missingSm = ALL.filter((l) => !new RegExp(`hreflang=["']${l}["']`).test(xml));
    if (missingSm.length) {
      errors.push(`root sitemap ${path.basename(smWithAlts)} missing cross-locale alternates for [${missingSm.join(', ')}] — shard build dropped sibling-locale sitemap entries`);
    } else {
      console.log(`✓ (4) sitemap ${path.basename(smWithAlts)} → cross-locale alternates complete (it/en/de/fr)`);
    }
  }
}

if (errors.length) {
  console.error('\n✖ Locale shard validation FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('\n✓ Locale shard validation PASSED');

// Emit a GitHub step-summary table when running in Actions.
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = ALL.map((l) => `| ${l}${emit.includes(l) ? ' ✅' : ''} | ${counts[l]} |`).join('\n');
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### Locale shard \`${rawLocale || 'all'}\` — page counts\n\n| locale | pages |\n|---|---|\n${rows}\n`,
  );
}
