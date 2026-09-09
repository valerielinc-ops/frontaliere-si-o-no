#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EMPLOYER_INSIGHTS_COVERAGE_FLOOR,
  EMPLOYER_INSIGHTS_SOURCES,
} from '../lib/employer-insights-contract.mjs';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function expectedDocumentWindow(window) {
  return { ...window, inclusive: '[from,to)' };
}

export function validateEmployerInsightsPayload(
  payload,
  {
    currentDocumentCount,
    expectedSource,
    coverageFloor = EMPLOYER_INSIGHTS_COVERAGE_FLOOR,
  } = {},
) {
  const errors = [];
  const source = payload?.source;
  const coverage = payload?.coverage;
  const window = payload?.window;
  const documents = payload?.documents;
  const expectedCount = finiteNumber(currentDocumentCount);

  if (!EMPLOYER_INSIGHTS_SOURCES.includes(expectedSource)) {
    errors.push(`expected source must be one of ${[...EMPLOYER_INSIGHTS_SOURCES].join(', ')}`);
  }
  if (source !== expectedSource || !source) {
    errors.push('payload.source must declare the expected source');
  }
  if (coverage?.source !== expectedSource || !coverage?.source) {
    errors.push('coverage.source must declare the expected source');
  }
  if (!Number.isInteger(payload?.schemaVersion) || payload.schemaVersion < 1) {
    errors.push('payload.schemaVersion is missing or invalid');
  }
  if (!validIso(payload?.generatedAt)) errors.push('payload.generatedAt must be an ISO timestamp');
  if (!window || !validIso(window.from) || !validIso(window.to) || Date.parse(window.from) >= Date.parse(window.to)) {
    errors.push('payload.window must have ordered from/to timestamps');
  }
  if (typeof window?.timezone !== 'string' || !window.timezone.trim()) {
    errors.push('payload.window.timezone is required');
  }

  const sourceObserved = finiteNumber(coverage?.sourceObserved);
  const returned = finiteNumber(coverage?.returned);
  if (sourceObserved == null || sourceObserved <= 0) {
    errors.push('coverage.sourceObserved must be > 0');
  }
  if (returned == null || returned < 0) {
    errors.push('coverage.returned must be a non-negative number');
  }
  if (sourceObserved != null && sourceObserved > 0 && returned != null) {
    if (returned > sourceObserved) errors.push('coverage.returned cannot exceed sourceObserved');
    if (returned / sourceObserved < coverageFloor) {
      errors.push('coverage returned/sourceObserved is below 90%');
    }
  }
  if (coverage?.truncated !== false) errors.push('coverage.truncated must be false');

  const totalRows = finiteNumber(coverage?.totalRows);
  const returnedRows = finiteNumber(coverage?.returnedRows);
  if (totalRows == null || returnedRows == null || returnedRows !== totalRows) {
    errors.push('coverage returnedRows must equal totalRows');
  }
  if (finiteNumber(coverage?.pages) == null || finiteNumber(coverage?.pages) <= 0) {
    errors.push('coverage.pages must be a positive number');
  }
  if (typeof coverage?.snapshotId !== 'string' || !coverage.snapshotId) {
    errors.push('coverage.snapshotId is required');
  }
  if (typeof coverage?.queryHash !== 'string' || !coverage.queryHash) {
    errors.push('coverage.queryHash is required');
  }

  if (expectedCount == null || expectedCount <= 0) {
    errors.push('current employer snapshot count must be > 0');
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    errors.push('payload.documents must be a non-empty array');
  } else if (expectedCount != null && expectedCount > 0) {
    const minimumDocuments = Math.ceil(expectedCount * coverageFloor);
    if (documents.length < minimumDocuments) {
      errors.push(`document coverage is below 90%: ${documents.length}/${expectedCount}`);
    }
  }

  const expectedWindow = window ? expectedDocumentWindow(window) : null;
  const companyKeys = new Set();
  for (const document of Array.isArray(documents) ? documents : []) {
    const companyKey = document?.companyKey;
    if (typeof companyKey !== 'string' || !companyKey || companyKeys.has(companyKey)) {
      errors.push(`document companyKey is empty or duplicated: ${companyKey || '<missing>'}`);
    }
    companyKeys.add(companyKey);
    if (document?.source !== expectedSource || document?.provenance?.source !== expectedSource) {
      errors.push(`document source is not ${expectedSource}: ${companyKey || '<missing>'}`);
    }
    if (expectedWindow && !sameJson(document?.window, expectedWindow)) {
      errors.push(`document window does not match payload window: ${companyKey || '<missing>'}`);
    }
    if (document?.coverage?.source !== expectedSource) {
      errors.push(`document coverage source is not ${expectedSource}: ${companyKey || '<missing>'}`);
    }
    if (document?.limits?.events?.truncated !== false) {
      errors.push(`event coverage is truncated: ${companyKey || '<missing>'}`);
    }
    if (document?.limits?.adsSerialized?.truncated !== false || document?.limits?.adsSerialized?.limit !== null) {
      errors.push(`ad serialization is truncated or capped: ${companyKey || '<missing>'}`);
    }
    if (document?.provenance?.truncated !== false) {
      errors.push(`document provenance is truncated: ${companyKey || '<missing>'}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    coverage: {
      sourceObserved,
      returned,
      ratio: sourceObserved > 0 && returned != null ? returned / sourceObserved : null,
      documents: Array.isArray(documents) ? documents.length : 0,
      currentDocuments: expectedCount,
    },
  };
}

function arg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const payloadPath = arg('--payload');
  const currentPath = arg('--current');
  const expectedSource = arg('--source');
  if (!payloadPath || !currentPath || !expectedSource) {
    throw new Error('usage: validate-employer-insights-payload.mjs --payload <file> --current <file> --source <posthog|ga4>');
  }

  const payload = readJson(payloadPath);
  const current = readJson(currentPath);
  const result = validateEmployerInsightsPayload(payload, {
    currentDocumentCount: current?.count,
    expectedSource,
  });
  if (!result.ok) {
    for (const error of result.errors) console.error(`::error::${error}`);
    throw new Error(`fail-closed payload validation: ${result.errors.length} condition(s) failed`);
  }

  const summary = [
    '## Employer insights dry-run gate',
    '',
    `- source: ${expectedSource}`,
    `- window: ${payload.window.from} → ${payload.window.to} (${payload.window.timezone})`,
    `- source events returned: ${result.coverage.returned}/${result.coverage.sourceObserved} (${(result.coverage.ratio * 100).toFixed(2)}%)`,
    `- companies: ${result.coverage.documents}/${result.coverage.currentDocuments} (floor ${(EMPLOYER_INSIGHTS_COVERAGE_FLOOR * 100).toFixed(0)}%)`,
    '- source/window/provenance/truncation checks: pass',
  ].join('\n');
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, summary + '\n');

  const gatePath = arg('--gate-out');
  if (gatePath) {
    fs.writeFileSync(gatePath, `${JSON.stringify({
      source: expectedSource,
      window: payload.window,
      sourceObserved: result.coverage.sourceObserved,
      returned: result.coverage.returned,
      coverageRatio: result.coverage.ratio,
      companies: result.coverage.documents,
      currentCompanies: result.coverage.currentDocuments,
      minimumCompanies: Math.ceil(result.coverage.currentDocuments * EMPLOYER_INSIGHTS_COVERAGE_FLOOR),
      snapshotId: payload.coverage.snapshotId,
    }, null, 2)}\n`);
  }
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
