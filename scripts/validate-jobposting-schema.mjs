#!/usr/bin/env node
/**
 * validate-jobposting-schema.mjs
 *
 * Post-build walker that opens every HTML file in `dist/`, extracts
 * JSON-LD blocks of @type `JobPosting`, and asserts that every one of
 * the 9 mandatory fields required by CLAUDE.md rule #3 is present and
 * non-empty:
 *
 *   1. title
 *   2. description (≥ 50 chars — Google treats thinner strings as low quality)
 *   3. datePosted  (parseable ISO 8601)
 *   4. employmentType (schema.org enum)
 *   5. hiringOrganization.name
 *   6. jobLocation (Place with PostalAddress)
 *   7. jobLocation.address.postalCode
 *   8. jobLocation.address.streetAddress
 *   9. baseSalary (MonetaryAmount with currency + value.minValue>0 + value.maxValue>=min + value.unitText)
 *
 * Exits with code 1 and prints a summary of failing URLs when any
 * violation is found — blocks deploy.
 *
 * Usage:
 *   node scripts/validate-jobposting-schema.mjs
 *   npm run validate:jobposting-schema
 */

import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const MAX_ERRORS = 60;

const EMPLOYMENT_TYPES = new Set([
  'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY',
  'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER',
]);

// ── Filesystem walk ─────────────────────────────────────────────────────────
function walkHtml(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkHtml(full, out);
    else if (st.isFile() && full.endsWith('.html')) out.push(full);
  }
  return out;
}

// ── JSON-LD extraction ──────────────────────────────────────────────────────
function extractJsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch { /* skip unparseable */ }
  }
  return out;
}

function flattenBlocks(blocks) {
  const out = [];
  const seen = new WeakSet();
  function visit(obj) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) { for (const v of obj) visit(v); return; }
    out.push(obj);
    if (Array.isArray(obj['@graph'])) for (const v of obj['@graph']) visit(v);
  }
  for (const b of blocks) visit(b);
  return out;
}

// ── Field validation ────────────────────────────────────────────────────────
function isNonEmptyString(x) {
  return typeof x === 'string' && x.trim().length > 0;
}

function isValidIsoDate(x) {
  if (!isNonEmptyString(x)) return false;
  return !Number.isNaN(new Date(x).getTime());
}

function validateJobPosting(schema) {
  const errors = [];

  // 1. title
  if (!isNonEmptyString(schema.title)) errors.push('title missing/empty');

  // 2. description (≥50 chars)
  if (!isNonEmptyString(schema.description)) errors.push('description missing/empty');
  else if (schema.description.length < 50) errors.push(`description too short (${schema.description.length} < 50)`);

  // 3. datePosted
  if (!isValidIsoDate(schema.datePosted)) errors.push('datePosted missing/invalid');

  // 4. employmentType
  if (!isNonEmptyString(schema.employmentType)) errors.push('employmentType missing/empty');
  else if (!EMPLOYMENT_TYPES.has(schema.employmentType)) {
    errors.push(`employmentType="${schema.employmentType}" not in schema.org enum`);
  }

  // 5. hiringOrganization.name
  if (!schema.hiringOrganization || typeof schema.hiringOrganization !== 'object') {
    errors.push('hiringOrganization missing');
  } else if (!isNonEmptyString(schema.hiringOrganization.name)) {
    errors.push('hiringOrganization.name missing/empty');
  }

  // 6 – 8. jobLocation + nested postalCode + streetAddress
  const loc = schema.jobLocation;
  if (!loc || typeof loc !== 'object') {
    errors.push('jobLocation missing');
  } else {
    const addr = loc.address;
    if (!addr || typeof addr !== 'object') {
      errors.push('jobLocation.address missing');
    } else {
      if (!isNonEmptyString(addr.postalCode)) errors.push('jobLocation.address.postalCode missing/empty');
      else if (!/^\d{4,5}$/.test(String(addr.postalCode).trim())) errors.push(`jobLocation.address.postalCode="${addr.postalCode}" invalid`);
      if (!isNonEmptyString(addr.streetAddress)) errors.push('jobLocation.address.streetAddress missing/empty');
      if (!isNonEmptyString(addr.addressLocality)) errors.push('jobLocation.address.addressLocality missing/empty');
      if (!isNonEmptyString(addr.addressRegion)) errors.push('jobLocation.address.addressRegion missing/empty');
      if (addr.addressCountry !== 'CH') errors.push(`jobLocation.address.addressCountry="${addr.addressCountry}" should be "CH"`);
    }
  }

  // 9. baseSalary
  const sal = schema.baseSalary;
  if (!sal || typeof sal !== 'object') {
    errors.push('baseSalary missing');
  } else {
    if (!isNonEmptyString(sal.currency)) errors.push('baseSalary.currency missing/empty');
    if (!sal.value || typeof sal.value !== 'object') {
      errors.push('baseSalary.value missing');
    } else {
      const min = Number(sal.value.minValue);
      const max = Number(sal.value.maxValue);
      if (!(min > 0)) errors.push(`baseSalary.value.minValue=${sal.value.minValue} must be > 0`);
      if (!(max >= min)) errors.push(`baseSalary.value.maxValue=${sal.value.maxValue} must be >= minValue`);
      if (!isNonEmptyString(sal.value.unitText)) errors.push('baseSalary.value.unitText missing/empty');
    }
  }

  return errors;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const files = walkHtml(DIST);
  if (files.length === 0) {
    console.log(`[validate-jobposting-schema] No HTML files under ${DIST} — nothing to check.`);
    process.exit(0);
  }

  let pagesWithJobPosting = 0;
  let schemaCount = 0;
  const failures = [];

  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!html.includes('"JobPosting"') && !html.includes("'JobPosting'")) continue;

    const blocks = flattenBlocks(extractJsonLdBlocks(html));
    const postings = blocks.filter((b) => b && b['@type'] === 'JobPosting');
    if (postings.length === 0) continue;

    pagesWithJobPosting++;
    for (const posting of postings) {
      schemaCount++;
      const errors = validateJobPosting(posting);
      if (errors.length > 0) {
        failures.push({ file: relative(process.cwd(), file), errors });
      }
    }
  }

  console.log(
    `[validate-jobposting-schema] Scanned ${files.length} HTML files — ` +
    `${pagesWithJobPosting} pages carry ${schemaCount} JobPosting schemas.`,
  );

  if (failures.length === 0) {
    console.log('[validate-jobposting-schema] OK — every JobPosting has all 9 mandatory fields.');
    process.exit(0);
  }

  console.error(`[validate-jobposting-schema] FAIL — ${failures.length} schemas have missing/invalid mandatory fields:`);
  for (const f of failures.slice(0, MAX_ERRORS)) {
    console.error(`\n  ${f.file}`);
    for (const e of f.errors) console.error(`    · ${e}`);
  }
  if (failures.length > MAX_ERRORS) {
    console.error(`\n  … and ${failures.length - MAX_ERRORS} more.`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[validate-jobposting-schema] Crashed:', err);
  process.exit(1);
});
