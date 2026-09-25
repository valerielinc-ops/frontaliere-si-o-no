#!/usr/bin/env node
/**
 * meta-translation-audit.mjs — Workstream G.3
 *
 * Flags job-level `titleByLocale` / `descriptionByLocale` where the
 * localized value is byte-identical to the Italian source (likely a
 * copy-paste fallback that isn't actually translated). Also flags
 * near-identical titles that differ only by case / trailing punctuation,
 * and descriptions whose first 80 characters match the Italian source.
 *
 * Output:
 *   docs/seo-reports/meta-translation-audit.md
 *
 * Reads `data/jobs.json` (gitignored). Skips gracefully if absent.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const JOBS_JSON = join(ROOT, 'data', 'jobs.json');
const OUT_DIR = join(ROOT, 'docs', 'seo-reports');
const OUT_FILE = join(OUT_DIR, 'meta-translation-audit.md');

const PREFIX_MATCH_CHARS = 80;
const LOCALES = ['en', 'de', 'fr'];

function normalizeForCompare(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?…]+$/g, '').trim();
}

function loadJobs() {
  if (!existsSync(JOBS_JSON)) return null;
  try {
    const parsed = JSON.parse(readFileSync(JOBS_JSON, 'utf-8'));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.jobs)) return parsed.jobs;
    if (parsed && typeof parsed === 'object') {
      const values = Object.values(parsed);
      if (values.every((v) => v && typeof v === 'object' && ('titleByLocale' in v || 'title' in v))) return values;
    }
  } catch (err) {
    console.warn('[meta-translation-audit] could not parse jobs.json:', err);
  }
  return null;
}

function writeReport(findings, metadata) {
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  lines.push('# Job Meta-translation Audit');
  lines.push('');
  lines.push(`_Generated: ${metadata.generatedAt}_`);
  lines.push('');
  if (metadata.skipped) {
    lines.push(`> _Skipped: ${metadata.skipped}_`);
    writeFileSync(OUT_FILE, lines.join('\n'));
    return;
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Jobs scanned: **${metadata.totalJobs}**`);
  lines.push(`- Locales audited: **${LOCALES.join(', ')}**`);
  lines.push('');
  lines.push('| Flag | Count |');
  lines.push('|------|------:|');
  lines.push(`| Identical title (locale == IT) | ${findings.titleIdentical.length} |`);
  lines.push(`| Near-identical title (case/punct only) | ${findings.titleNearIdentical.length} |`);
  lines.push(`| Missing title translation | ${findings.titleMissing.length} |`);
  lines.push(`| Identical description (locale == IT) | ${findings.descIdentical.length} |`);
  lines.push(`| Identical description prefix (first ${PREFIX_MATCH_CHARS} chars) | ${findings.descPrefixMatch.length} |`);
  lines.push(`| Missing description translation | ${findings.descMissing.length} |`);
  lines.push('');

  function renderTable(title, rows, headers, renderer) {
    if (rows.length === 0) return;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| ' + headers.join(' | ') + ' |');
    lines.push('|' + headers.map(() => '------').join('|') + '|');
    rows.slice(0, 75).forEach((r) => lines.push('| ' + renderer(r).join(' | ') + ' |'));
    if (rows.length > 75) lines.push(`_…and ${rows.length - 75} more_`);
    lines.push('');
  }

  renderTable(
    'Identical titles (locale copy of IT)',
    findings.titleIdentical,
    ['Job ID', 'Locale', 'IT title'],
    (r) => [`\`${r.id}\``, r.locale, r.itTitle.replace(/\|/g, '\\|')]
  );
  renderTable(
    'Near-identical titles (differ only by case / trailing punct)',
    findings.titleNearIdentical,
    ['Job ID', 'Locale', 'IT', 'Localized'],
    (r) => [`\`${r.id}\``, r.locale, r.itTitle.replace(/\|/g, '\\|'), r.localized.replace(/\|/g, '\\|')]
  );
  renderTable(
    'Identical descriptions (locale copy of IT)',
    findings.descIdentical,
    ['Job ID', 'Locale', 'Prefix'],
    (r) => [`\`${r.id}\``, r.locale, (r.itDesc || '').slice(0, 80).replace(/\|/g, '\\|')]
  );
  renderTable(
    `Identical description prefixes (first ${PREFIX_MATCH_CHARS} chars match)`,
    findings.descPrefixMatch,
    ['Job ID', 'Locale', 'Prefix'],
    (r) => [`\`${r.id}\``, r.locale, (r.prefix || '').replace(/\|/g, '\\|')]
  );

  lines.push('## Follow-ups');
  lines.push('');
  lines.push('- Hits here indicate the localization pipeline is emitting the IT source instead of a real translation — investigate `scripts/lib/job-localization-pipeline.mjs` fallbacks.');
  lines.push('- Jobs flagged with `needsRetranslation: true` are already excluded from this audit.');
  lines.push('');

  writeFileSync(OUT_FILE, lines.join('\n'));
  console.log(`[meta-translation-audit] wrote → ${OUT_FILE}`);
}

function main() {
  const jobs = loadJobs();
  const generatedAt = new Date().toISOString();
  if (!jobs) {
    writeReport(null, { generatedAt, skipped: `data/jobs.json not found at ${JOBS_JSON}` });
    return;
  }

  const findings = {
    titleIdentical: [], titleNearIdentical: [], titleMissing: [],
    descIdentical: [], descPrefixMatch: [], descMissing: [],
  };

  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    if (job.needsRetranslation === true) continue;
    const id = job.id || job.slug || 'unknown';
    const itTitle = job.titleByLocale?.it || job.title || '';
    const itDesc = job.descriptionByLocale?.it || job.description || '';
    if (!itTitle && !itDesc) continue;

    for (const locale of LOCALES) {
      const lTitle = job.titleByLocale?.[locale];
      const lDesc = job.descriptionByLocale?.[locale];

      // Titles
      if (itTitle) {
        if (!lTitle) {
          findings.titleMissing.push({ id, locale, itTitle });
        } else if (lTitle === itTitle) {
          findings.titleIdentical.push({ id, locale, itTitle });
        } else if (normalizeForCompare(lTitle) === normalizeForCompare(itTitle)) {
          findings.titleNearIdentical.push({ id, locale, itTitle, localized: lTitle });
        }
      }

      // Descriptions
      if (itDesc) {
        if (!lDesc) {
          findings.descMissing.push({ id, locale });
        } else if (lDesc === itDesc) {
          findings.descIdentical.push({ id, locale, itDesc });
        } else {
          const itPrefix = itDesc.slice(0, PREFIX_MATCH_CHARS).trim();
          const lPrefix = lDesc.slice(0, PREFIX_MATCH_CHARS).trim();
          if (itPrefix && itPrefix === lPrefix) {
            findings.descPrefixMatch.push({ id, locale, prefix: itPrefix });
          }
        }
      }
    }
  }

  writeReport(findings, { generatedAt, totalJobs: jobs.length });
  console.log(`[meta-translation-audit] titleIdentical=${findings.titleIdentical.length} titleNear=${findings.titleNearIdentical.length} descIdentical=${findings.descIdentical.length} descPrefix=${findings.descPrefixMatch.length}`);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('meta-translation-audit.mjs');
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[meta-translation-audit] fatal:', err);
    try {
      writeReport(null, { generatedAt: new Date().toISOString(), skipped: `fatal: ${err instanceof Error ? err.message : String(err)}` });
    } catch { /* noop */ }
    process.exit(0);
  }
}

export { normalizeForCompare, PREFIX_MATCH_CHARS, LOCALES };
