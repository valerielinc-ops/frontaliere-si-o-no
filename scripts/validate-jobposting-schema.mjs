#!/usr/bin/env node
/**
 * validate-jobposting-schema.mjs
 *
 * Post-build walker that opens every HTML file in `dist/`, extracts
 * JSON-LD blocks of @type `JobPosting`, and asserts the shared contract of
 * scripts/lib/jobposting-mandatory-fields.mjs (owner decision 2026-10-24):
 *
 *   required, non-empty: title, description (≥ 50 chars), datePosted
 *   (parseable ISO 8601), hiringOrganization.name, jobLocation with a
 *   complete PostalAddress, employmentType (schema.org enum), baseSalary
 *   (currency + value.minValue>0 + value.maxValue>=min when present +
 *   value.unitText), and validThrough (parseable ISO 8601). The canonical
 *   builder supplies safe defaults when the source omits non-critical values.
 *
 * Exits with code 1 and prints a summary of failing URLs when any
 * violation is found — blocks deploy.
 *
 * Usage:
 *   node scripts/validate-jobposting-schema.mjs
 *   npm run validate:jobposting-schema
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  isNonEmptyString,
  validateMandatoryJobPostingFields,
} from './lib/jobposting-mandatory-fields.mjs';

const DIST = join(process.cwd(), 'dist');
const MAX_ERRORS = 60;

// ── Filesystem walk + read: bounded concurrency, sequential order ──────────
// Until 2026-10 this walk was `readdirSync` + one `statSync` per entry, and the
// reads were awaited one at a time: on the rehydrated production dist (millions
// of one-directory-per-page HTML files) the gate issued every syscall strictly
// in series, and on deploy 39946751902 it alone took 4404 s — the last 73 min
// of validate-dist, one Node process on a 4 vCPU runner, run after every other
// walker by design (FULL-DIST SERIAL PHASE). Overlapping the syscalls is the
// lever `scripts/audit-spa-bundle-injection.mjs` (#5432) already proved.
//
// PURE I/O SCHEDULING — COVERAGE AND VERDICT ARE UNCHANGED:
//   • same file set: every entry whose stat() (which follows symlinks, as the
//     old statSync did) is a regular file named *.html, at any depth, no
//     directory skipped; unreadable directories/entries/files are skipped
//     exactly as before;
//   • same counters and the same per-posting checks;
//   • same OUTPUT ORDER: each file carries its position in the sequential
//     depth-first walk (the index path of its readdir entries), and failures
//     are reported sorted by it — the very order the old loop produced them.
// SCAN_CONCURRENCY bounds the syscalls in flight; libuv's fs pool (4 threads
// by default) is the real ceiling, the surplus keeps it saturated.
const SCAN_CONCURRENCY = Math.max(1, Number(process.env.JOBPOSTING_SCAN_CONCURRENCY) || 32);

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/** Lexicographic comparison of two walk-order index paths. */
function compareOrder(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Visit every HTML file under `root` with `onFile(full, html, order)`.
 * Returns the number of HTML files found (read or not, like the old list).
 */
async function scanHtml(root, onFile) {
  const limit = createLimiter(SCAN_CONCURRENCY);
  let found = 0;
  const visitDir = async (dir, order) => {
    let entries;
    try {
      entries = await limit(() => readdir(dir));
    } catch {
      return;
    }
    // Batches keep the in-flight promise count bounded on 100k-entry dirs.
    const BATCH = 256;
    for (let start = 0; start < entries.length; start += BATCH) {
      const slice = entries.slice(start, start + BATCH);
      await Promise.all(slice.map(async (name, k) => {
        const full = join(dir, name);
        const childOrder = [...order, start + k];
        let st;
        try {
          st = await limit(() => stat(full));
        } catch {
          return;
        }
        if (st.isDirectory()) {
          await visitDir(full, childOrder);
        } else if (st.isFile() && full.endsWith('.html')) {
          found++;
          let html;
          try {
            html = await limit(() => readFile(full, 'utf8'));
          } catch {
            return;
          }
          onFile(full, html, childOrder);
        }
      }));
    }
  };
  await visitDir(root, []);
  return found;
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
// The complete mandatory field set is validated by the shared contract. These
// address details are stricter quality checks owned by this standalone gate.
function checkJobPostingAddressDetails(schema) {
  const errors = [];
  const address = schema?.jobLocation?.address;
  if (!address || typeof address !== 'object') return errors;

  // addressLocality/addressCountry presence is part of the shared contract.
  if (!isNonEmptyString(address.addressRegion)) {
    errors.push('jobLocation.address.addressRegion missing/empty');
  }
  // addressCountry MUST be present and a valid ISO 3166-1 alpha-2 code.
  // Most jobs are CH (Swiss Ticino employers), but foreign-listed remote
  // positions legitimately surface as LU, DE, IT, FR, AT, etc. — the
  // validator used to hardcode "CH" and rejected every non-Swiss country,
  // which masked the REAL failure mode (missing or malformed codes).
  if (isNonEmptyString(address.addressCountry) && !/^[A-Z]{2}$/.test(String(address.addressCountry).trim())) {
    errors.push(`jobLocation.address.addressCountry="${address.addressCountry}" is not a 2-letter ISO 3166-1 alpha-2 code`);
  }
  return errors;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  let pagesWithJobPosting = 0;
  let schemaCount = 0;
  const failures = [];

  const fileCount = await scanHtml(DIST, (file, html, order) => {
    if (!html.includes('"JobPosting"') && !html.includes("'JobPosting'")) return;

    const blocks = flattenBlocks(extractJsonLdBlocks(html));
    const postings = blocks.filter((b) => b && b['@type'] === 'JobPosting');
    if (postings.length === 0) return;

    pagesWithJobPosting++;
    postings.forEach((posting, k) => {
      schemaCount++;
      const errors = [
        ...validateMandatoryJobPostingFields(posting).map(({ message }) => message),
        ...checkJobPostingAddressDetails(posting),
      ];
      if (errors.length > 0) {
        failures.push({ file: relative(process.cwd(), file), errors, order: [...order, k] });
      }
    });
  });
  if (fileCount === 0) {
    console.log(`[validate-jobposting-schema] No HTML files under ${DIST} — nothing to check.`);
    process.exit(0);
  }
  failures.sort((x, y) => compareOrder(x.order, y.order));

  console.log(
    `[validate-jobposting-schema] Scanned ${fileCount} HTML files — ` +
    `${pagesWithJobPosting} pages carry ${schemaCount} JobPosting schemas.`,
  );

  if (failures.length === 0) {
    console.log('[validate-jobposting-schema] OK — every JobPosting has the complete mandatory field contract.');
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
