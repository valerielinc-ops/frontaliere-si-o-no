#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateD18Payload } from '../lib/employer-insights-cumulative-contract.mjs';

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function validateD18Artifact(payload) {
  const result = validateD18Payload(payload);
  return {
    ...result,
    summary: {
      schemaVersion: payload?.schemaVersion ?? null,
      metricVersion: payload?.metricVersion ?? null,
      window: payload?.requestedWindow ?? null,
      regimes: Object.fromEntries(['ga4', 'posthog'].map((source) => [source, payload?.sourceRegimes?.[source]?.status || 'non disponibile'])),
      coverageMatrix: payload?.coverageMatrix?.status || 'non disponibile',
      companies: Array.isArray(payload?.companies) ? payload.companies.length : 0,
    },
  };
}

function main() {
  const payloadPath = arg('--payload');
  if (!payloadPath) throw new Error('usage: validate-employer-insights-d18-payload.mjs --payload <file>');
  const payload = readJson(payloadPath);
  const result = validateD18Artifact(payload);
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
