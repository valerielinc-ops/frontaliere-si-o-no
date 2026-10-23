/**
 * Canonical population reader for the GSC Coverage 404 producer.
 *
 * `data/url-inspection-results.json` belongs to the job-orphan synchronizer;
 * it is not the population used by the 404/alias audit. Keeping this boundary
 * in one small reader prevents the URL Inspection sweep from silently mixing
 * those two cohorts again.
 */
import fs from 'node:fs';
import path from 'node:path';

export const GSC_COVERAGE_FILE = 'data/gsc-coverage-404s.json';

const UNKNOWN_REASONS = new Set([
  'outside-gsc-property',
  'invalid-path',
  'ambiguous-routing',
  'no-demonstrated-destination',
  'unsafe-destination',
]);

function normalizePath(value) {
  const raw = String(value || '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')
    || raw.includes('?') || raw.includes('#') || raw.includes('\\')) {
    throw new Error(`invalid GSC Coverage path: ${value}`);
  }
  const normalized = `/${raw.replace(/^\/+/, '')}`.replace(/\/+/g, '/');
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`unsafe GSC Coverage path: ${value}`);
  }
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

function readSnapshot(file) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read canonical GSC Coverage population ${file}: ${error?.message || error}`);
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`canonical GSC Coverage population is not an object: ${file}`);
  }
  if (!Array.isArray(snapshot.paths)) {
    throw new Error(`canonical GSC Coverage population has no paths array: ${file}`);
  }
  return snapshot;
}

/**
 * Read the source-backed GSC cohort and its explicitly excluded residue.
 * Invalid paths fail closed: a malformed producer output must not become an
 * inspection candidate or an implicit redirect.
 */
export function readCanonicalGscCoverage(rootDir = process.cwd()) {
  const file = path.resolve(rootDir, GSC_COVERAGE_FILE);
  const snapshot = readSnapshot(file);
  const seen = new Set();
  const paths = [];
  for (const raw of snapshot.paths) {
    const normalized = normalizePath(raw);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }

  const unresolved = Array.isArray(snapshot.unresolved) ? snapshot.unresolved.map((entry) => {
    if (!entry || entry.kind !== 'unknown' || !UNKNOWN_REASONS.has(entry.reason)) {
      throw new Error(`canonical GSC Coverage population has an invalid unresolved entry: ${file}`);
    }
    return {
      path: entry.path === null ? null : normalizePath(entry.path),
      reason: entry.reason,
    };
  }) : [];

  return {
    source: typeof snapshot.source === 'string' ? snapshot.source : 'unknown',
    lastUpdated: typeof snapshot.lastUpdated === 'string' ? snapshot.lastUpdated : null,
    paths,
    unresolved,
    observedRows: Number.isSafeInteger(snapshot.population?.observedRows)
      ? snapshot.population.observedRows
      : null,
  };
}

export function gscCoveragePopulationSummary(population) {
  return {
    sourceBacked: Array.isArray(population?.paths) ? population.paths.length : 0,
    unresolved: Array.isArray(population?.unresolved) ? population.unresolved.length : 0,
    observedRows: Number.isSafeInteger(population?.observedRows) ? population.observedRows : null,
  };
}
