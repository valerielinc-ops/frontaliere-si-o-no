#!/usr/bin/env node
/**
 * audit-canonical-trailing-slash.mjs
 *
 * Hard gate: every `<link rel="canonical" href="…">` emitted into a dist/*.html
 * page MUST end with a trailing slash (or be a homepage / asset URL). The
 * canonical URL is the form Google indexes; emitting `…/articoli-frontaliere/foo`
 * (no slash) trains Google to canonicalize the no-slash form, which then
 * collides with the trailing-slash form used by the sitemap and internal
 * links. The result is ~2.5% of GSC impressions arriving on the wrong shape.
 *
 * This audit is the regression net for the canonicalPath trailing-slash fix
 * in services/seo/*.ts. Companion to `audit-sitemap-canonicals` — that one
 * checks self-canonicalisation, this one checks URL shape hygiene.
 *
 * Pass conditions for a canonical href:
 *   - equals `https://frontaliereticino.ch/` (homepage)              → OK
 *   - ends with `/`                                                  → OK
 *   - last path segment has a file extension (.html/.pdf/.xml/…)     → OK
 *
 * Fail condition:
 *   - canonical href present, not homepage, no extension, no slash   → FAIL
 *
 * WARN (does NOT fail the gate):
 *   - canonical href missing                                          → WARN
 *     (covered by audit-sitemap-canonicals; surfacing here keeps the
 *      two reports symmetric and easy to diff.)
 *
 * Run AFTER `npm run build` so dist/ is fresh.
 *
 * Usage:
 *   node scripts/audit-canonical-trailing-slash.mjs
 *   node scripts/audit-canonical-trailing-slash.mjs --limit=10000
 *
 * Pure Node, no deps.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditReport } from './lib/auditReport.mjs';
import { walkHtmlFiles, sampleFiles, resolveSamplingEnv } from './lib/audit-runner.mjs';
import { readHeadOrAll } from './lib/readHead.mjs';

// Bounded in-flight reads — same cap audit-hreflang and dropOverwrittenLocs
// use for this workload (pure I/O over dist/ on a 4-vCPU runner).
const IN_FLIGHT = 64;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const HOST = 'https://frontaliereticino.ch';
const HOST_ROOT = `${HOST}/`;

// File-extension regex for the last path segment. If the last segment after a
// slash contains a `.` followed by a short alphanumeric suffix, treat the URL
// as an asset (PDF, XML, sitemap-style HTML, etc.) and skip the slash check.
const ASSET_EXT_RE = /\/[^/?#]*\.[a-z0-9]{1,6}(?:\?|#|$)/i;

// ── CLI args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = new Map();
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? true);
  }
}

if (args.has('help') || args.has('h')) {
  process.stdout.write(
    'audit-canonical-trailing-slash.mjs — assert every dist/*.html <link rel="canonical"> ends with `/`\n' +
    '\n' +
    'Usage: node scripts/audit-canonical-trailing-slash.mjs [--limit=N]\n' +
    '  --limit=N      Cap number of HTML files scanned (useful for quick local runs).\n' +
    '\n' +
    'Run after `npm run build`. Exits 1 if any canonical lacks a trailing slash.\n'
  );
  process.exit(0);
}

const RAW_LIMIT = args.get('limit');
const LIMIT = RAW_LIMIT === undefined || RAW_LIMIT === true ? Infinity : Number(RAW_LIMIT);
const PRINT_LIMIT = 50;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

/**
 * Extract <link rel="canonical" href="..."> href from HTML. Tolerant of
 * attribute order and single/double/unquoted hrefs.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractCanonical(html) {
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
    const href =
      tag.match(/href\s*=\s*"([^"]+)"/i) ||
      tag.match(/href\s*=\s*'([^']+)'/i) ||
      tag.match(/href\s*=\s*([^"'\s>]+)/i);
    if (href && href[1]) return decodeEntities(href[1].trim());
  }
  return null;
}

/**
 * Classify a canonical href. Returns one of:
 *   - 'ok-homepage'         (host root)
 *   - 'ok-trailing-slash'   (ends with `/`)
 *   - 'ok-asset'            (has a file extension in the last segment)
 *   - 'fail-no-slash'       (everything else)
 *
 * @param {string} canonical
 * @returns {'ok-homepage'|'ok-trailing-slash'|'ok-asset'|'fail-no-slash'}
 */
function classifyCanonical(canonical) {
  const trimmed = canonical.trim();
  if (trimmed === HOST || trimmed === HOST_ROOT) return 'ok-homepage';
  // Strip query/hash for the slash + extension test (Google treats those as
  // separate canonicals anyway; the question here is whether the *path* shape
  // is right).
  const pathPart = trimmed.split('#')[0].split('?')[0];
  if (pathPart.endsWith('/')) return 'ok-trailing-slash';
  if (ASSET_EXT_RE.test(pathPart + (trimmed.includes('?') ? '?' : ''))) {
    return 'ok-asset';
  }
  return 'fail-no-slash';
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DIST)) {
    process.stderr.write(
      `audit-canonical-trailing-slash: dist/ not found at ${DIST}. Run \`npm run build\` first.\n`
    );
    process.exit(2);
  }

  // Shared concurrent walker (scripts/lib/audit-runner.mjs) replaces this
  // file's own synchronous copy. Two deliberate differences, both safe here:
  // it skips dot-prefixed entries — dist/ dotfile HTML is already a
  // 0-tolerance failure in audit:no-dotfile-html, so nothing can hide behind
  // it — and it matches `.html` case-sensitively, which is the only casing
  // this build emits. The old walker's audit-reports/.audits exclusions are
  // reapplied below so prior report output can never be mistaken for source.
  const walked = await walkHtmlFiles(DIST);
  const allHtml = walked.filter(
    (p) => !p.includes(`${sep}audit-reports${sep}`) && !p.includes(`${sep}.audits${sep}`)
  );
  const limited = Number.isFinite(LIMIT) ? allHtml.slice(0, LIMIT) : allHtml;

  // Rotating sample — same mechanism as `audit:all` (scripts/lib/audit-runner
  // .mjs `sampleFiles`), driven by AUDIT_SAMPLE_RATE / AUDIT_SAMPLE_SALT. This
  // gate is 0-tolerance on a per-page property with no baseline to ratchet, so
  // sampling costs only the run in which an isolated offender first appears:
  // a systemic canonical-shape regression lands in every bucket. Never silent
  // (AGENTS.md non-negotiable #1) — the banner below prints on every sampled
  // run and the metadata goes into the audit report.
  const { rate, salt } = resolveSamplingEnv();
  const { sampled: htmlFiles, totalBuckets, activeBucket } = sampleFiles(limited, DIST, rate, salt);
  const sampling = totalBuckets > 1
    ? { totalBuckets, activeBucket, filesOnDisk: limited.length, filesScanned: htmlFiles.length }
    : null;
  if (sampling) {
    process.stdout.write(
      `audit-canonical-trailing-slash: SAMPLED run — bucket ${activeBucket + 1}/${totalBuckets}, ` +
        `scanning ${htmlFiles.length}/${limited.length} files ` +
        `(${((htmlFiles.length / limited.length) * 100).toFixed(1)}%). ` +
        `Full corpus coverage requires ${totalBuckets} consecutive runs (rotates via AUDIT_SAMPLE_SALT).\n`
    );
  }

  /** @type {{ category: 'fail-no-slash'|'missing-canonical', file: string, canonical: string|null }[]} */
  const offenders = [];
  let okCount = 0;
  let scanned = 0;

  // Bounded-concurrency scan. The per-file body is the previous sequential
  // logic verbatim; only the read is now head-limited and overlapped. Shared
  // accumulators are safe — lanes interleave solely at await points on a
  // single-threaded event loop.
  let cursor = 0;
  const lane = async () => {
    while (cursor < htmlFiles.length) {
      const file = htmlFiles[cursor++];
      const html = await readHeadOrAll(file);
      if (html === null) continue;
      scanned++;
      const canonical = extractCanonical(html);
      if (!canonical) {
        offenders.push({ category: 'missing-canonical', file, canonical: null });
        continue;
      }
      const verdict = classifyCanonical(canonical);
      if (verdict === 'fail-no-slash') {
        offenders.push({ category: 'fail-no-slash', file, canonical });
      } else {
        okCount++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IN_FLIGHT, htmlFiles.length) }, () => lane())
  );

  // Lanes finish out of order — sort so the report and CI log stay stable
  // between runs over identical input.
  offenders.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const counts = {
    'fail-no-slash': 0,
    'missing-canonical': 0,
  };
  for (const o of offenders) counts[o.category]++;

  process.stdout.write(
    `audit-canonical-trailing-slash: scanned ${scanned} dist/*.html file(s)` +
      (Number.isFinite(LIMIT) && allHtml.length > scanned ? ` (limited from ${allHtml.length})` : '') +
      `\n` +
      `OK: ${okCount}, fail-no-slash: ${counts['fail-no-slash']}, missing-canonical: ${counts['missing-canonical']}\n`
  );

  const hardFailers = offenders.filter((o) => o.category === 'fail-no-slash');
  const warners = offenders.filter((o) => o.category === 'missing-canonical');

  if (warners.length > 0) {
    process.stderr.write(
      `\nWARN: ${warners.length} HTML file(s) have no <link rel="canonical"> ` +
        `(separate concern — see audit-sitemap-canonicals).\n`
    );
    const slice = warners.slice(0, Math.min(PRINT_LIMIT, warners.length));
    for (const o of slice) {
      process.stderr.write(`[missing-canonical] ${relative(ROOT, o.file)}\n`);
    }
    if (warners.length > slice.length) {
      process.stderr.write(`… ${warners.length - slice.length} more\n`);
    }
  }

  // Write a per-spec snapshot at dist/.audits/canonical-trailing-slash.json so
  // ad-hoc consumers can inspect failures without learning the audit-reports
  // shape. The structured writeAuditReport call below remains the canonical
  // source for CI artifact upload.
  const auditsDir = join(DIST, '.audits');
  try {
    mkdirSync(auditsDir, { recursive: true });
  } catch {
    // ignore — the writeFileSync below will surface the real error
  }
  const snapshotPath = join(auditsDir, 'canonical-trailing-slash.json');
  const snapshot = {
    audit: 'canonical-trailing-slash',
    ranAt: new Date().toISOString(),
    scanned,
    ok: okCount,
    counts,
    failures: hardFailers.map((o) => ({
      file: relative(ROOT, o.file),
      canonical: o.canonical,
    })),
    warnings: warners.map((o) => ({
      file: relative(ROOT, o.file),
    })),
  };
  try {
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    process.stderr.write(`audit-canonical-trailing-slash: failed to write ${snapshotPath}: ${err.message}\n`);
  }

  const structuredOffenders = offenders.map((o) => ({
    path: relative(ROOT, o.file),
    feature: o.category,
    metric: 1,
    ratio: null,
    category: o.category,
    canonical: o.canonical,
  }));
  const byFeatureForReport = {};
  for (const o of offenders) {
    byFeatureForReport[o.category] = (byFeatureForReport[o.category] ?? 0) + 1;
  }

  if (hardFailers.length === 0) {
    await writeAuditReport({
      audit: 'canonical-trailing-slash',
      passed: true,
      threshold: { metric: 'count', value: 0, comparator: '<=' },
      offenders: structuredOffenders,
      byFeature: byFeatureForReport,
      extra: { categoryCounts: counts, htmlScanned: scanned },
    });
    process.exit(0);
  }

  process.stderr.write(
    `\nFAIL: canonical trailing-slash gate found ${hardFailers.length} offender(s).\n` +
      `Canonical hrefs MUST end with '/' (or be the homepage / an asset URL).\n` +
      `Root cause is usually a canonicalPath literal in services/seo/*.ts missing its trailing slash.\n\n`
  );

  const printed = Math.min(PRINT_LIMIT, hardFailers.length);
  for (let i = 0; i < printed; i++) {
    const o = hardFailers[i];
    process.stderr.write(`[fail-no-slash] ${relative(ROOT, o.file)} → ${o.canonical}\n`);
  }
  if (hardFailers.length > printed) {
    process.stderr.write(`… ${hardFailers.length - printed} more (see ${relative(ROOT, snapshotPath)} for full list)\n`);
  }

  await writeAuditReport({
    audit: 'canonical-trailing-slash',
    passed: false,
    threshold: { metric: 'count', value: 0, comparator: '<=' },
    offenders: structuredOffenders,
    byFeature: byFeatureForReport,
    extra: { categoryCounts: counts, htmlScanned: scanned },
  });
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`audit-canonical-trailing-slash crashed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
