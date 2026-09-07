#!/usr/bin/env node
/**
 * audit-expired-at-parsable.mjs
 *
 * 0-tolerance gate: every committed expired-archive entry must carry an
 * `expiredAt` that `Date.parse` can order.
 *
 * Why exists (issue #7736): both archive writers sort by `expiredAt` and then
 * cut at `EXPIRED_JOBS_CAP` (`assemble-jobs-dataset.mjs`,
 * `cleanup-jobs.mjs`). `compareExpiredAt` sends an entry whose value does not
 * parse to the TAIL by construction — the safe direction for a comparator on
 * its own, but past a cut at 5000 it means an entry that sat INSIDE the cap in
 * the input is pushed out of it, and the soft landing for a URL Google still
 * has indexed turns back into a 404.
 *
 * The ingress normalization in `normalizeExpiredAtEntries` keeps such a value
 * from ever reaching the cut. This gate is the observer that keeps the claim
 * honest: measured 0 bad out of 32.596 entries at decomposition time and 0 out
 * of 31.060 on 2026-09-06, with nothing watching either number. The RATE is
 * printed on every run — the measurement is the point, the binary verdict is
 * only its threshold.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const AGGREGATES = [
  path.join(ROOT, 'data', 'expired-jobs.json'),
  path.join(ROOT, 'public', 'data', 'expired-jobs.json'),
];
const SAMPLE_CAP = 10;

/** Mirrors `scripts/lib/expired-jobs-archive.mjs:isParsableExpiredAt`. */
const isParsable = (value) =>
  typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));

const readEntries = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const offenders = [];
const malformed = [];
let total = 0;

const auditFile = (file, label) => {
  const entries = readEntries(file);
  if (entries === null) {
    malformed.push(label);
    return 0;
  }
  total += entries.length;
  let bad = 0;
  for (const entry of entries) {
    if (isParsable(entry?.expiredAt)) continue;
    bad += 1;
    if (offenders.length < SAMPLE_CAP) {
      offenders.push({ file: label, slug: entry?.slug || '(no slug)', expiredAt: entry?.expiredAt });
    }
  }
  return bad;
};

let bad = 0;
const sliceFiles = fs.existsSync(SLICES_DIR)
  ? fs.readdirSync(SLICES_DIR).filter((f) => f.endsWith('.json')).sort()
  : [];
for (const f of sliceFiles) bad += auditFile(path.join(SLICES_DIR, f), `by-crawler/${f}`);

let aggregatesSeen = 0;
for (const file of AGGREGATES) {
  if (!fs.existsSync(file)) continue;
  aggregatesSeen += 1;
  bad += auditFile(file, path.relative(ROOT, file));
}

if (total > 0) {
  const rate = ((bad / total) * 100).toFixed(4);
  console.log(
    `[audit-expired-at-parsable] ${bad}/${total} entries without a parsable expiredAt (${rate}%) ` +
    `— ${sliceFiles.length} slices + ${aggregatesSeen} aggregates`,
  );
}

// Before the empty-archive exit, not after: a file that is not a JSON array
// contributes zero entries, so an archive whose files are all corrupt lands on
// `total === 0` and a zero-tolerance gate would pass it as «nothing to audit».
if (malformed.length > 0) {
  console.error(
    `\x1b[31m[audit-expired-at-parsable]\x1b[0m FAIL — ${malformed.length} archive files are not a JSON array:\n` +
    malformed.map((m) => `  - ${m}`).join('\n'),
  );
  process.exit(1);
}

if (total === 0) {
  console.log('[audit-expired-at-parsable] no expired archive on disk — nothing to audit');
  process.exit(0);
}

if (bad > 0) {
  console.error(
    `\x1b[31m[audit-expired-at-parsable]\x1b[0m FAIL — an unorderable expiredAt is repositioned ` +
    `against the EXPIRED_JOBS_CAP cut, dropping the soft landing for an indexed URL.\n` +
    `First ${Math.min(offenders.length, SAMPLE_CAP)} offenders:\n` +
    offenders.map((o) => `  - ${o.file} :: ${o.slug} :: expiredAt=${JSON.stringify(o.expiredAt)}`).join('\n') +
    `\nFix: the writers normalize at ingress (normalizeExpiredAtEntries); re-run the archival step ` +
    `that produced these files instead of editing the archive by hand.`,
  );
  process.exit(1);
}

console.log('\x1b[32m[audit-expired-at-parsable]\x1b[0m PASS — every expired entry has a parsable expiredAt');
