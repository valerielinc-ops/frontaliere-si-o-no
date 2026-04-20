#!/usr/bin/env node
/**
 * snapshot-jobs-weekly.mjs — F5 snapshot writer
 *
 * Reads `data/jobs.json` (assumed already refreshed by assemble-jobs-dataset),
 * writes a compact weekly snapshot to
 *   `data/jobs-snapshots-history/{YYYY-WW}.json`
 *
 * Each row in the snapshot keeps just the fields needed by the build plugin:
 *   { slug, employer, employerKey?, city, role?, postedAt? }
 *
 * The snapshot file name uses the ISO 8601 week + ISO-week-year of the
 * moment the script runs. Running multiple times in the same ISO week
 * overwrites the file (last-writer-wins).
 *
 * Degradation: if `data/jobs.json` is missing, writes an empty snapshot
 * (schema-valid) and exits 0 so the workflow can commit a placeholder.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const JOBS_PATH = join(ROOT, 'data', 'jobs.json');
const HISTORY_DIR = join(ROOT, 'data', 'jobs-snapshots-history');

function isoWeekAndYear(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { week, year: date.getUTCFullYear() };
}

function normEmployerKey(employer, employerKey) {
  const raw = String(employerKey || employer || '').trim().toLowerCase();
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function main() {
  mkdirSync(HISTORY_DIR, { recursive: true });

  const now = new Date();
  const { week, year } = isoWeekAndYear(now);
  const fileKey = `${year}-${String(week).padStart(2, '0')}`;
  const filePath = join(HISTORY_DIR, `${fileKey}.json`);

  let jobs = [];
  if (existsSync(JOBS_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(JOBS_PATH, 'utf-8'));
      if (Array.isArray(raw)) jobs = raw;
    } catch (err) {
      console.warn(`[snapshot-jobs-weekly] failed to parse jobs.json: ${err?.message || err}`);
    }
  } else {
    console.warn('[snapshot-jobs-weekly] data/jobs.json not found — writing empty snapshot.');
  }

  const rows = [];
  for (const j of jobs) {
    if (!j || typeof j !== 'object') continue;
    if (j.expired) continue;
    const employer = String(j.company || '').trim();
    if (!employer) continue;
    rows.push({
      slug: String(j.slug || j.id || ''),
      employer,
      employerKey: j.companyKey || normEmployerKey(employer),
      city: String(j.addressLocality || j.location || '').trim(),
      role: String(j.title || '').trim() || undefined,
      postedAt: j.postedDate || j.datePosted || undefined,
    });
  }

  const snapshot = {
    week: fileKey,
    generatedAt: now.toISOString(),
    jobs: rows,
  };

  writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  console.log(
    `[snapshot-jobs-weekly] Wrote ${rows.length} rows to ${filePath.replace(ROOT + '/', '')}.`,
  );
}

main();
