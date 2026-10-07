/**
 * Rate gate for defects measured on the post-deploy dist reassembled from
 * published shards.
 *
 * A reassembled dist is a mixed-vintage corpus: it can contain pages emitted
 * by source code that has already been fixed or removed. The owner-approved
 * exception for that corpus asks whether the emission regressed, not whether
 * every historical page is perfect. Source/local callers remain strict; this
 * module is only entered when the caller explicitly opts into historical mode.
 *
 * The comparison deliberately delegates its arithmetic to the shared
 * mixAdjustedRateGate helper. There is one feature here (the named check), but
 * using the same implementation as the other rate ratchets keeps the absolute
 * and rate conditions from drifting apart.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMixAdjustedTotalRegression } from './mixAdjustedRateGate.mjs';

export const HISTORICAL_CORPUS_LEDGER = 'data/sitemap-pages-historical-ratchet.json';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The validator's three blocking sub-checks; soft-404 remains strict. */
export const HISTORICAL_SITEMAP_CHECKS = Object.freeze([
  'audit:sitemap-canonicals',
  'validate:canonical',
  'validate:content-quality',
]);

const STRICT_TOLERANCE = Object.freeze({
  relPct: 0,
  absPp: 0,
  maxDeltaPp: Infinity,
  minAbsDelta: 0,
});

function ledgerPath(path = HISTORICAL_CORPUS_LEDGER) {
  return isAbsolute(path) ? path : join(ROOT, path);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validCheckEntry(entry) {
  return Boolean(
    entry
      && typeof entry === 'object'
      && finiteNonNegative(entry.ceilingRatePct)
      && entry.measurement
      && typeof entry.measurement === 'object'
      && Number.isInteger(entry.measurement.filesScanned)
      && entry.measurement.filesScanned > 0
      && Number.isInteger(entry.measurement.observedOffenders)
      && entry.measurement.observedOffenders >= 0
      && entry.measurement.observedOffenders <= entry.measurement.filesScanned,
  );
}

/**
 * Read the historical ledger without ever turning a missing/corrupt ledger
 * into a green result. The caller treats null as strict zero tolerance.
 */
export function readHistoricalCorpusLedgerOrNull(path = HISTORICAL_CORPUS_LEDGER) {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(path), 'utf8'));
    if (parsed?.version !== 1 || !parsed.checks || typeof parsed.checks !== 'object') return null;
    if (!HISTORICAL_SITEMAP_CHECKS.every((name) => validCheckEntry(parsed.checks[name]))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function strictVerdict({ check, offenders, filesScanned, reason }) {
  return {
    check,
    historicalCorpus: false,
    ratcheted: false,
    measured: filesScanned > 0,
    passed: offenders === 0,
    offenders,
    filesScanned,
    ratePct: filesScanned > 0 ? (offenders / filesScanned) * 100 : null,
    ceilingRatePct: null,
    expectedOffenders: null,
    regression: offenders > 0,
    reason,
    humanSummary: `${check}: ${offenders} offender(s) — strict zero-tolerance mode${reason ? ` (${reason})` : ''}`,
  };
}

/**
 * Judge one blocking sitemap sub-check.
 *
 * A malformed/missing ledger or an empty population is fail-closed. The
 * historical exception can only make a known, measured mixed-vintage draw
 * pass under its recorded rate ceiling; it cannot make an unreadable run
 * green.
 */
export function evaluateHistoricalCorpusRate({
  check,
  offenders,
  filesScanned,
  historicalCorpus,
  ledger,
}) {
  if (!historicalCorpus) {
    return strictVerdict({ check, offenders, filesScanned, reason: 'source/local validation' });
  }
  if (!ledger?.checks?.[check]) {
    return strictVerdict({ check, offenders, filesScanned, reason: 'historical ledger unavailable' });
  }
  if (!(filesScanned > 0)) {
    return {
      ...strictVerdict({ check, offenders, filesScanned, reason: 'empty historical population' }),
      historicalCorpus: true,
      measured: false,
      passed: false,
      regression: true,
    };
  }

  const entry = ledger.checks[check];
  const tolerance = { ...STRICT_TOLERANCE, ...(entry.tolerance ?? {}) };
  const comparison = evaluateMixAdjustedTotalRegression({
    scannedByFeature: { [check]: filesScanned },
    baseByFeature: {
      [check]: {
        ratePct: entry.ceilingRatePct,
        scanned: entry.measurement.filesScanned,
      },
    },
    tol: tolerance,
    actualOffenders: offenders,
    actualScanned: filesScanned,
    sampleRate: 1,
  });
  const ratePct = (offenders / filesScanned) * 100;
  const passed = !comparison.regression;
  const rate = ratePct.toFixed(6);
  const ceiling = Number(entry.ceilingRatePct).toFixed(6);
  const humanSummary = passed
    ? `${check}: ${offenders} offender(s) / ${filesScanned} sitemap URL(s) = ${rate}% — `
      + `historical corpus rate within ceiling ${ceiling}%`
    : `${check}: REGRESSION — ${offenders} offender(s) / ${filesScanned} sitemap URL(s) = ${rate}% `
      + `over historical ceiling ${ceiling}%`;

  return {
    check,
    historicalCorpus: true,
    ratcheted: true,
    measured: true,
    passed,
    offenders,
    filesScanned,
    ratePct: Number(ratePct.toFixed(7)),
    ceilingRatePct: entry.ceilingRatePct,
    expectedOffenders: Number(comparison.expectedOffenders.toFixed(2)),
    regression: comparison.regression,
    missingFeatures: comparison.missingFeatures,
    humanSummary,
  };
}
