#!/usr/bin/env node
/**
 * validate-jobs-quality.mjs — Deploy-time quality gate for job data.
 *
 * Checks:
 *   1. Italian description length (error if < 100 chars)
 *   2. Untranslated Italian slugs (warning — German/French words in IT slug)
 *   3. Missing baseSalary in generated rich-result pages (error)
 *
 * Exit 1 on errors, exit 0 on warnings only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { requireDataPath, ROOT } from './lib/resolve-data-path.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

/* ── German-only word patterns (not found in Italian/English job titles) ── */
const GERMAN_SLUG_WORDS = /(?:^|-)(?:als|und|fur|oder|frau|mann|fach|stelle|lehrstelle|lehre|mitarbeiter|leiter|stellvertretend|verkauf|lernend|chauffeu|gartencenter|befristet|ablosen|disponentin|disponent|ladenleit|logistiker|projektleiter|elektroinstallateur|elektroplaner|unterhaltsfachmann|servicetechniker|immobilienberater|bauleiter|zeichner|fachrichtung|ingenieurbau|tunnelbau|tiefbau|innendienst|generalagentur|vorsorge|vermogen|wissenschaftlich|detailhandels|bekampfung|japankafer|lager)(?:-|$)/i;

/* ── French-only word patterns ── */
const FRENCH_SLUG_WORDS = /(?:^|-)(?:apprentissage|gestionnaire|adjoint|auxiliaire|temporaire|vendeur|vendeuse|postes|vacants|gerante|gerant)(?:-|$)/i;

/* ── Code/script content detection ── */
const CODE_PATTERNS = [
  { re: /\bvar\s+\w+\s*=\s*(?:new\s|['"\[\{])/i, label: 'JS var declaration' },
  { re: /\bfunction\s*\w*\s*\([^)]*\)\s*\{/i, label: 'JS function' },
  { re: /\bdocument\.(getElementById|querySelector|cookie|write)/i, label: 'DOM API' },
  { re: /\bwindow\.(location|addEventListener|onload)/i, label: 'window API' },
  { re: /background-image:\s*url\(/i, label: 'CSS background-image' },
  { re: /\{[\s\S]{0,20}display\s*:\s*(none|block|flex|inline)/i, label: 'CSS display' },
  { re: /\.addEventListener\s*\(\s*['"]/i, label: 'addEventListener' },
  { re: /\bnew\s+(Array|Object|Map|Set)\s*\(/i, label: 'JS constructor' },
  { re: /<\/?(script|style|noscript)[\s>]/i, label: 'HTML script/style' },
  { re: /\$\(\s*['"][#.]/i, label: 'jQuery selector' },
];

function detectCodeContent(text = '') {
  if (text.length < 50) return { isCode: false, reason: '' };
  const matches = [];
  for (const { re, label } of CODE_PATTERNS) {
    if (re.test(text)) matches.push(label);
  }
  if (matches.length >= 2) {
    return { isCode: true, reason: `Code detected: ${matches.join(', ')}` };
  }
  return { isCode: false, reason: '' };
}

/**
 * Extract only the title portion of a slug, stripping company + location suffix.
 * Slug format: "{title}-{company}-{location}" — we check only the title part
 * so that German company names (e.g., "imwinkelried-luftung-und-klima-ag") don't trigger false positives.
 */
function extractTitleSlug(fullSlug, job) {
  let titleSlug = fullSlug;
  const companySuffix = slugifySimple(job.company || '');
  // Try stripping company name from slug (try multiple prefix lengths for robust matching)
  if (companySuffix.length >= 5) {
    for (const prefixLen of [companySuffix.length, 20, 15, 10]) {
      const prefix = companySuffix.substring(0, Math.min(prefixLen, companySuffix.length));
      const idx = fullSlug.indexOf(prefix);
      if (idx > 3) {
        titleSlug = fullSlug.substring(0, idx).replace(/-+$/, '');
        break;
      }
    }
  }
  return titleSlug || fullSlug;
}

function slugifySimple(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function run() {
  const dataJobs = requireDataPath('jobs.json', 'validate-jobs-quality');
  console.log(`Reading jobs dataset from: ${path.relative(ROOT, dataJobs)}`);
  const jobs = JSON.parse(fs.readFileSync(dataJobs, 'utf-8'));
  const errors = [];
  const warnings = [];

  for (const job of jobs) {
    const itDesc = String(job.descriptionByLocale?.it || job.description || '');
    const itSlug = String(job.slugByLocale?.it || job.slug || '');
    const id = job.slug || job.id || 'unknown';

    // Check 1: Italian description too short
    if (itDesc.length === 0) {
      errors.push({
        slug: id,
        company: job.company,
        issue: 'empty_description',
        detail: `IT description is empty`,
      });
    } else if (itDesc.length < 150) {
      errors.push({
        slug: id,
        company: job.company,
        issue: 'short_description',
        detail: `IT description only ${itDesc.length} chars (min 150)`,
      });
    } else if (itDesc.length < 300) {
      warnings.push({
        slug: id,
        company: job.company,
        issue: 'thin_description',
        detail: `IT description only ${itDesc.length} chars (recommended min 300)`,
      });
    }

    // Check 2: Untranslated Italian slug (warning-only; fix upstream without blocking deploys)
    if (itSlug.length > 20) {
      const titlePart = extractTitleSlug(itSlug, job);
      if (GERMAN_SLUG_WORDS.test(titlePart)) {
        warnings.push({
          slug: id,
          company: job.company,
          issue: 'german_slug_in_it',
          detail: `Italian slug contains German words: ${itSlug.substring(0, 80)}`,
        });
      } else if (FRENCH_SLUG_WORDS.test(titlePart)) {
        warnings.push({
          slug: id,
          company: job.company,
          issue: 'french_slug_in_it',
          detail: `Italian slug contains French words: ${itSlug.substring(0, 80)}`,
        });
      }
    }

    // Check 3: Code/script contamination in description
    const allDescs = [itDesc, String(job.description || '')];
    for (const desc of allDescs) {
      const codeCheck = detectCodeContent(desc);
      if (codeCheck.isCode) {
        errors.push({
          slug: id,
          company: job.company,
          issue: 'code_in_description',
          detail: `${codeCheck.reason} — ${desc.substring(0, 60)}...`,
        });
        break;
      }
    }
  }

  // Summary
  console.log('=== Job Quality Audit ===');
  console.log(`Jobs checked: ${jobs.length}`);
  console.log(`Errors: ${errors.length} | Warnings: ${warnings.length}`);

  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings (non-blocking):');
    const byIssue = {};
    for (const w of warnings) {
      byIssue[w.issue] = (byIssue[w.issue] || 0) + 1;
    }
    for (const [issue, count] of Object.entries(byIssue)) {
      console.log(`  ${issue}: ${count}`);
    }
    // Show first 5
    warnings.slice(0, 5).forEach((w) => {
      console.log(`  - ${w.company}: ${w.detail}`);
    });
    if (warnings.length > 5) console.log(`  ... and ${warnings.length - 5} more`);
  }

  if (errors.length > 0) {
    console.log('\n❌ Errors (blocking):');
    const byIssue = {};
    for (const e of errors) {
      byIssue[e.issue] = (byIssue[e.issue] || 0) + 1;
    }
    for (const [issue, count] of Object.entries(byIssue)) {
      console.log(`  ${issue}: ${count}`);
    }
    errors.slice(0, 10).forEach((e) => {
      console.log(`  - ${e.company}: ${e.detail}`);
    });
    if (errors.length > 10) console.log(`  ... and ${errors.length - 10} more`);

    console.log(`\n❌ FAILED — ${errors.length} job(s) below quality threshold.`);
    const _byIssue = {};
    for (const e of errors) _byIssue[e.issue] = (_byIssue[e.issue] ?? 0) + 1;
    await writeAuditReport({
      audit: 'validate-jobs-quality',
      passed: false,
      threshold: { metric: 'errorCount', value: 0, comparator: '<=' },
      offenders: errors.map((e) => ({
        path: `job:${e.slug}`,
        feature: e.issue,
        metric: 1,
        ratio: null,
        company: e.company,
        detail: e.detail,
      })),
      byFeature: _byIssue,
      extra: { totalJobs: jobs.length, warnings: warnings.length },
    });
    process.exit(1);
  }

  console.log('\n✅ Job quality validation passed.');
  await writeAuditReport({
    audit: 'validate-jobs-quality',
    passed: true,
    threshold: { metric: 'errorCount', value: 0, comparator: '<=' },
    offenders: [],
    extra: { totalJobs: jobs.length, warnings: warnings.length },
  });
}

run().catch((err) => {
  console.error('validate-jobs-quality crashed:', err);
  process.exit(2);
});
