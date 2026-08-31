#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  createTranslationObservabilitySnapshot,
  advanceTranslationObservabilityState,
  buildTranslationObservabilityReport,
  finalizeTranslationObservabilityReport,
  unpackTranslationObservabilityState,
} from './lib/translation-observability.mjs';

const SELF = fileURLToPath(import.meta.url);
function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    out[key] = argv[index + 1];
  }
  return out;
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function existingJson(file) { return file && fs.existsSync(file) ? json(file) : null; }
function run(argv) {
  const value = args(argv);
  if (value.mode === 'start') {
    const snapshot = createTranslationObservabilitySnapshot(json(value.jobs), { now: Date.parse(value.now || '') || Date.now() });
    writeJsonAtomic(value.output, snapshot, { compact: true });
    return snapshot;
  }
  if (value.mode === 'finish') {
    const final = createTranslationObservabilitySnapshot(json(value.jobs));
    let previousState = null;
    let stateIssue = null;
    try {
      previousState = existingJson(value.state);
      if (previousState) unpackTranslationObservabilityState(previousState);
    } catch {
      previousState = null;
      stateIssue = 'persisted_state_invalid';
    }
    const requestedAdvance = value.advanceState === 'true';
    const validFinal = requestedAdvance && value.outcome === 'success' && !stateIssue;
    const observation = advanceTranslationObservabilityState({
      previousState,
      final,
      validFinal,
      stateIssue,
      skipReason: requestedAdvance ? 'true_final_outcome_not_success' : 'state_advance_not_requested',
    });
    const report = buildTranslationObservabilityReport({
      before: json(value.before), final, runId: value.runId,
      startedAt: value.startedAt, finishedAt: value.finishedAt || new Date().toISOString(), sourceCommit: value.sourceCommit, outcome: value.outcome,
      generationObservation: observation,
    });
    const finalized = finalizeTranslationObservabilityReport(report, null);
    writeJsonAtomic(value.output, finalized, { compact: true });
    if (observation.advanced && value.stateOutput) writeJsonAtomic(value.stateOutput, observation.state, { compact: true });
    return finalized;
  }
  if (value.mode === 'finalize') {
    const report = finalizeTranslationObservabilityReport(json(value.report), value.finalCommit);
    writeJsonAtomic(value.output || value.report, report, { compact: true });
    return report;
  }
  throw new TypeError('Usage: --mode start|finish|finalize with required paths');
}
if (path.resolve(process.argv[1] || '') === SELF) {
  try { const report = run(process.argv.slice(2)); process.stdout.write(`${report.digest || report.jobSetDigest}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
export { run as runTranslationObservabilityCollector };
