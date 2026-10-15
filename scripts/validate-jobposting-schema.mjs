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
import {
  isNonEmptyString,
  validateMandatoryJobPostingFields,
} from './lib/jobposting-mandatory-fields.mjs';

const DIST = join(process.cwd(), 'dist');
const MAX_ERRORS = 60;

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

// ── Consumer-specific validation ───────────────────────────────────────────
// The nine mandatory fields are validated by the shared contract. These
// address details are stricter quality checks owned by this standalone gate.
function checkJobPostingAddressDetails(schema) {
  const errors = [];
  const address = schema?.jobLocation?.address;
  if (!address || typeof address !== 'object') return errors;

  if (!isNonEmptyString(address.addressLocality)) {
    errors.push('jobLocation.address.addressLocality missing/empty');
  }
  if (!isNonEmptyString(address.addressRegion)) {
    errors.push('jobLocation.address.addressRegion missing/empty');
  }
  // addressCountry MUST be present and a valid ISO 3166-1 alpha-2 code.
  // Most jobs are CH (Swiss Ticino employers), but foreign-listed remote
  // positions legitimately surface as LU, DE, IT, FR, AT, etc. — the
  // validator used to hardcode "CH" and rejected every non-Swiss country,
  // which masked the REAL failure mode (missing or malformed codes).
  if (!isNonEmptyString(address.addressCountry)) {
    errors.push('jobLocation.address.addressCountry missing/empty');
  } else if (!/^[A-Z]{2}$/.test(String(address.addressCountry).trim())) {
    errors.push(`jobLocation.address.addressCountry="${address.addressCountry}" is not a 2-letter ISO 3166-1 alpha-2 code`);
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
      const errors = [
        ...validateMandatoryJobPostingFields(posting).map(({ message }) => message),
        ...checkJobPostingAddressDetails(posting),
      ];
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
