#!/usr/bin/env node

/**
 * Validate an exported webcam/provider shadow sample without making network or
 * provider calls.
 *
 * The input is either an array of rows or `{ observations: [...] }`. Rows are
 * written by the traffic scheduler into append-only Firestore history; an
 * operator can export them to JSON and pass that file here. Accuracy is only
 * measured when the export also contains the offline candidate field
 * `candidateWaitMinutes`. A missing candidate is a hard failure, never a
 * reason to treat the baseline as ready.
 *
 * @manual-tool
 * Reason: this offline validator consumes a Firestore observation export chosen
 * by an operator; no automated workflow owns a safe, canonical export input.
 */

import fs from 'node:fs';
import { assessWebcamWaitBaseline } from '../functions/src/trafficProviderMesh.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/validate-webcam-baseline.mjs <observations.json>');
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (error) {
  console.error(`Cannot read baseline observations: ${error.message}`);
  process.exit(2);
}

const observations = Array.isArray(payload) ? payload : payload?.observations;
const report = assessWebcamWaitBaseline(observations);
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exit(1);
