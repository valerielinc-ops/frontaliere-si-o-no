#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateD18FirstRunEvidence,
  validateD18Payload,
} from '../lib/employer-insights-cumulative-contract.mjs';

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function validateD18Artifact(payload, { requireLiveGa4 = false } = {}) {
  const result = validateD18Payload(payload);
  const firstRun = requireLiveGa4 ? validateD18FirstRunEvidence(payload) : { ok: true, errors: [] };
  const errors = [...result.errors, ...firstRun.errors];
  return {
    ok: errors.length === 0,
    errors,
    summary: {
      schemaVersion: payload?.schemaVersion ?? null,
      metricVersion: payload?.metricVersion ?? null,
      window: payload?.requestedWindow ?? null,
      regimes: Object.fromEntries(['ga4', 'posthog'].map((source) => [source, payload?.sourceRegimes?.[source]?.status || 'non disponibile'])),
      coverageMatrix: payload?.coverageMatrix?.status || 'non disponibile',
      companies: Array.isArray(payload?.companies) ? payload.companies.length : 0,
      evidenceStatus: payload?.evidence?.status || 'non disponibile',
      runMode: payload?.evidence?.runMode || 'non disponibile',
      emissionIdStatus: payload?.evidence?.ga4?.emissionId?.status || 'non disponibile',
      blockers: Array.isArray(payload?.evidence?.blockers) ? payload.evidence.blockers : [],
    },
  };
}

function main() {
  const payloadPath = arg('--payload');
  if (!payloadPath) throw new Error('usage: validate-employer-insights-d18-payload.mjs --payload <file>');
  const payload = readJson(payloadPath);
  const requireLiveGa4 = process.argv.includes('--require-live-ga4');
  const result = validateD18Artifact(payload, { requireLiveGa4 });
  if (!result.ok) {
    for (const error of result.errors) console.error(`::error::${error}`);
    throw new Error(`D18 payload validation failed: ${result.errors.length} condition(s)`);
  }
  const summary = [
    '## Employer insights D18 bounded artifact',
    '',
    `- schema: ${result.summary.schemaVersion} (${result.summary.metricVersion})`,
    `- window: ${result.summary.window.from} → ${result.summary.window.to} (${result.summary.window.timezone})`,
    `- GA4 regime: ${result.summary.regimes.ga4}`,
    `- PostHog regime: ${result.summary.regimes.posthog}`,
    `- coverage matrix: ${result.summary.coverageMatrix}`,
    `- companies: ${result.summary.companies}`,
    `- run evidence: ${result.summary.evidenceStatus} (${result.summary.runMode})`,
    `- GA4 emission_id: ${result.summary.emissionIdStatus}`,
    ...(result.summary.blockers.length ? [`- blockers: ${result.summary.blockers.join(' | ')}`] : []),
    '- contract, provenance and reconciliation checks: pass',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
