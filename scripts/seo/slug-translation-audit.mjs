#!/usr/bin/env node
/**
 * slug-translation-audit.mjs — Workstream G.1
 *
 * Reads `data/jobs.json` (if present; gitignored) and examines the
 * per-locale slug table `slugByLocale` on each job. Flags:
 *
 *   1. brand-translated slugs — segment that contained a protected brand
 *      in the IT slug was altered in the localized slug
 *      (e.g. "the-north-face" becoming "das-nord-gesicht")
 *   2. identical slug across locales — a sign of missed translation
 *      (the IT slug simply copied across to EN/DE/FR)
 *   3. literal over-translation — a transliteration that visibly breaks
 *      common company/product words into German/English (heuristic list
 *      drawn from the memory note on "expediter-casale-sa-lugano" &c.)
 *
 * Output:
 *   docs/seo-reports/slug-quality-audit.md  (human-readable markdown)
 *
 * G.2 is deliberately deferred — correcting the top-50 flagged slugs
 * requires human review against SEMrush keyword data, and is tracked as
 * a follow-up. See commit body.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const JOBS_JSON = join(ROOT, 'data', 'jobs.json');
const OUT_DIR = join(ROOT, 'docs', 'seo-reports');
const OUT_FILE = join(OUT_DIR, 'slug-quality-audit.md');

/**
 * Protected brand list — mirrors scripts/lib/dedicated-crawler-common.mjs
 * PROTECTED_BRAND_NAMES. Kept inline here to avoid a runtime dependency
 * on a crawler module that also pulls in Firestore.
 */
const PROTECTED_BRANDS = [
  'the north face', 'bottega veneta', 'dolce & gabbana', 'ermenegildo zegna',
  'salvatore ferragamo', 'ralph lauren', 'hugo boss', 'louis vuitton',
  'michael kors', 'kate spade', 'north face', 'timberland', 'napapijri',
  'balenciaga', 'burberry', 'givenchy', 'valentino', 'moncler', 'versace',
  'dickies', 'armani', 'chanel', 'fendi', 'gucci', 'prada', 'tiffany',
  'adidas', 'reebok', 'uniqlo', 'nike', 'puma', 'vans', 'zara', 'dior',
  'ikea', 'h&m',
];

// Slug-friendly versions (hyphenated, lowercase).
const PROTECTED_SLUG_FRAGMENTS = PROTECTED_BRANDS.map((b) =>
  b.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
);

/**
 * Dictionary of literal-translation "red flags" — words that, when they
 * appear in a localized slug, almost always indicate the translator
 * mangled a company / role name. Observed in production: "expediter"
 * (for "spedizione"), "beschleuniger" (for the same root), "ferroviario"
 * → "railway-worker".
 */
const LITERAL_FLAGS = {
  en: [
    'expediter', 'forwarder', 'railway-worker', 'bartender-alt',
    'the-swiss', 'saint-', 'holy-', 'incineration-',
  ],
  de: [
    'beschleuniger', 'der-schweizer', 'heiliger-', 'verbrennung-',
    'eisenbahner-arbeiter', 'spediteur-',
  ],
  fr: [
    'accelerateur', 'le-suisse', 'saint-', 'incineration-',
  ],
};

function loadJobs() {
  if (!existsSync(JOBS_JSON)) return null;
  try {
    const raw = readFileSync(JOBS_JSON, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.jobs)) return parsed.jobs;
    // Some shapes keyed by id.
    if (parsed && typeof parsed === 'object') {
      const values = Object.values(parsed);
      if (values.every((v) => v && typeof v === 'object' && 'slug' in v)) return values;
    }
  } catch (err) {
    console.warn('[slug-translation-audit] could not parse jobs.json:', err);
  }
  return null;
}

function detectBrandMangling(jobSlug, localizedSlug, companyName) {
  const companyLower = (companyName || '').toLowerCase();
  for (const brand of PROTECTED_SLUG_FRAGMENTS) {
    if (jobSlug.includes(brand) && !localizedSlug.includes(brand)) {
      // Only flag if the brand actually matches the company (avoids false positives
      // from incidental substring overlaps).
      const brandPlain = brand.replace(/-/g, ' ');
      if (companyLower.includes(brandPlain) || companyLower.includes(brand)) {
        return brand;
      }
    }
  }
  return null;
}

function detectLiteralFlags(locale, slug) {
  const flags = LITERAL_FLAGS[locale] || [];
  return flags.filter((f) => slug.includes(f));
}

function isIdentical(itSlug, localizedSlug) {
  return itSlug && localizedSlug && itSlug === localizedSlug;
}

function writeReport(findings, metadata) {
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  lines.push('# Job Slug Translation Quality Audit');
  lines.push('');
  lines.push(`_Generated: ${metadata.generatedAt}_`);
  lines.push('');
  if (metadata.skipped) {
    lines.push(`> _Skipped: ${metadata.skipped}_`);
    lines.push('');
    writeFileSync(OUT_FILE, lines.join('\n'));
    return;
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Jobs scanned: **${metadata.totalJobs}**`);
  lines.push(`- Locales audited: **${metadata.locales.join(', ')}**`);
  lines.push(`- Jobs with at least one flag: **${findings.flaggedJobs}**`);
  lines.push('');
  lines.push('| Flag | Count |');
  lines.push('|------|------:|');
  lines.push(`| Brand-translated slug (brand name altered in localized slug) | ${findings.brandCount} |`);
  lines.push(`| Identical slug across locales (untranslated copy) | ${findings.identicalCount} |`);
  lines.push(`| Literal/mangled translation (heuristic dictionary hit) | ${findings.literalCount} |`);
  lines.push('');

  if (findings.brand.length > 0) {
    lines.push('## 1. Brand-translated slugs');
    lines.push('');
    lines.push('The protected brand appeared in the Italian slug but is missing (or altered) in the localized slug. **`restoreProtectedBrands()` in the AI pipeline should already prevent this** — any hit here is a regression.');
    lines.push('');
    lines.push('| Job ID | Locale | Brand | IT slug | Localized slug | Company |');
    lines.push('|--------|--------|-------|---------|----------------|---------|');
    findings.brand.slice(0, 100).forEach((f) => {
      lines.push(`| \`${f.id}\` | ${f.locale} | ${f.brand} | \`${f.itSlug}\` | \`${f.localizedSlug}\` | ${f.company} |`);
    });
    if (findings.brand.length > 100) lines.push(`| _…and ${findings.brand.length - 100} more_ | | | | | |`);
    lines.push('');
  }

  if (findings.identical.length > 0) {
    lines.push('## 2. Identical slugs across locales');
    lines.push('');
    lines.push('The localized slug is byte-identical to the Italian slug. Likely cause: translation fell back to source, or slugify produced the same shape for both languages.');
    lines.push('');
    lines.push('| Job ID | Locale | Slug | Company |');
    lines.push('|--------|--------|------|---------|');
    findings.identical.slice(0, 100).forEach((f) => {
      lines.push(`| \`${f.id}\` | ${f.locale} | \`${f.itSlug}\` | ${f.company} |`);
    });
    if (findings.identical.length > 100) lines.push(`| _…and ${findings.identical.length - 100} more_ | | | |`);
    lines.push('');
  }

  if (findings.literal.length > 0) {
    lines.push('## 3. Literal / mangled translations');
    lines.push('');
    lines.push('The localized slug contains a token from the heuristic "red flag" dictionary (e.g. `expediter`, `beschleuniger`). These are almost always over-translations of Italian role names that produced nonsensical local equivalents.');
    lines.push('');
    lines.push('| Job ID | Locale | Hit | Localized slug | IT slug |');
    lines.push('|--------|--------|-----|----------------|---------|');
    findings.literal.slice(0, 100).forEach((f) => {
      lines.push(`| \`${f.id}\` | ${f.locale} | ${f.hits.join(', ')} | \`${f.localizedSlug}\` | \`${f.itSlug}\` |`);
    });
    if (findings.literal.length > 100) lines.push(`| _…and ${findings.literal.length - 100} more_ | | | | |`);
    lines.push('');
  }

  lines.push('## Follow-ups');
  lines.push('');
  lines.push('- **G.2 (deferred):** human-review the top-50 flagged slugs against SEMrush keyword volumes and patch `slugByLocale` in `data/jobs.json` + cache. Tracked as separate workstream once this audit is triaged.');
  lines.push('- Any brand-mangling hit in section 1 indicates a regression in `restoreProtectedBrands()` — investigate the specific crawler parser.');
  lines.push('- Section 3 heuristic list is intentionally narrow; expand as new patterns surface.');
  lines.push('');

  writeFileSync(OUT_FILE, lines.join('\n'));
  console.log(`[slug-translation-audit] wrote → ${OUT_FILE}`);
}

function main() {
  const jobs = loadJobs();
  const generatedAt = new Date().toISOString();
  if (!jobs) {
    writeReport({}, { generatedAt, skipped: `data/jobs.json not found at ${JOBS_JSON}` });
    return;
  }

  const findings = { brand: [], identical: [], literal: [] };
  const locales = ['en', 'de', 'fr'];
  let flaggedJobs = 0;

  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    if (job.needsRetranslation === true) continue;
    const itSlug = job.slugByLocale?.it || job.slug;
    if (!itSlug) continue;
    const id = job.id || itSlug;
    const company = job.company || job.companyKey || '';
    let jobFlagged = false;

    for (const locale of locales) {
      const localizedSlug = job.slugByLocale?.[locale];
      if (!localizedSlug) continue;

      // 1. brand mangling
      const brand = detectBrandMangling(itSlug, localizedSlug, company);
      if (brand) {
        findings.brand.push({ id, locale, brand, itSlug, localizedSlug, company });
        jobFlagged = true;
      }

      // 2. identical (IT source shouldn't equal EN/DE/FR for multi-word slugs)
      if (isIdentical(itSlug, localizedSlug)) {
        findings.identical.push({ id, locale, itSlug, company });
        jobFlagged = true;
      }

      // 3. literal over-translation
      const hits = detectLiteralFlags(locale, localizedSlug);
      if (hits.length > 0) {
        findings.literal.push({ id, locale, hits, itSlug, localizedSlug });
        jobFlagged = true;
      }
    }
    if (jobFlagged) flaggedJobs++;
  }

  writeReport(
    {
      ...findings,
      brandCount: findings.brand.length,
      identicalCount: findings.identical.length,
      literalCount: findings.literal.length,
      flaggedJobs,
    },
    {
      generatedAt,
      totalJobs: jobs.length,
      locales,
    }
  );

  console.log(`[slug-translation-audit] ${jobs.length} jobs → brand=${findings.brand.length} identical=${findings.identical.length} literal=${findings.literal.length}`);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('slug-translation-audit.mjs');
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[slug-translation-audit] fatal:', err);
    try {
      writeReport({}, { generatedAt: new Date().toISOString(), skipped: `fatal: ${err instanceof Error ? err.message : String(err)}` });
    } catch { /* noop */ }
    process.exit(0);
  }
}

export { detectBrandMangling, detectLiteralFlags, isIdentical, PROTECTED_SLUG_FRAGMENTS, LITERAL_FLAGS };
