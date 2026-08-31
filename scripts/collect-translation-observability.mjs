#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  createTranslationObservabilitySnapshot,
  buildTranslationObservabilityReport,
  finalizeTranslationObservabilityReport,
} from './lib/translation-observability.mjs';

const SELF = fileURLToPath(import.meta.url);
function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) out[argv[index]?.slice(2)] = argv[index + 1];
  return out;
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function run(argv) {
  const value = args(argv);
  if (value.mode === 'start') {
    const snapshot = createTranslationObservabilitySnapshot(json(value.jobs), { now: Date.parse(value.now || '') || Date.now() });
    writeJsonAtomic(value.output, snapshot, { compact: true });
    return snapshot;
  }
  if (value.mode === 'finish') {
    const report = buildTranslationObservabilityReport({
      before: json(value.before), final: createTranslationObservabilitySnapshot(json(value.jobs)), runId: value.runId,
      startedAt: value.startedAt, finishedAt: value.finishedAt || new Date().toISOString(), sourceCommit: value.sourceCommit, outcome: value.outcome,
    });
    writeJsonAtomic(value.output, finalizeTranslationObservabilityReport(report, null), { compact: true });
    return report;
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
