import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './config.mjs';
import {
  classifyStaffingEmployer,
  loadStaffingRegistry,
} from './seco-staffing-classifier.mjs';

export const STAFFING_AUDIT_FILENAME = 'staffing-classifier-manual-sample.json';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function jobsFromDocument(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.jobs)) return document.jobs;
  if (Array.isArray(document?.rows)) return document.rows;
  return [];
}

function isLiveOffer(job = {}) {
  if (!job || typeof job !== 'object' || job.expired === true || job.active === false) return false;
  return !new Set(['archived', 'closed', 'expired', 'filled', 'inactive', 'removed'])
    .has(String(job.status || '').trim().toLowerCase());
}

function employerNameOf(job = {}) {
  return String(job.company || job.employerName || job.hiringOrganization?.name || job.employer?.name || '').trim();
}

function cantonOf(job = {}) {
  return String(job.canton || job.addressRegion || job.location?.addressRegion || '').trim().toUpperCase();
}

function roundRate(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : null;
}

function auditRecord(row) {
  return {
    employer: row.name,
    offers: row.offerCount,
    expected: row.expected,
    predicted: row.predicted,
    confidence: row.classification.confidence,
    reason: row.classification.reason,
  };
}

/**
 * Run the manually labelled, volume-weighted employer sample. The labels live
 * outside the classifier rules so the audit is a check on the rules rather
 * than a test that merely repeats their registry aliases.
 */
export function auditStaffingClassifier({
  dataRoot = DATA_ROOT,
  registryPath,
  auditPath = path.join(dataRoot, 'prospector', STAFFING_AUDIT_FILENAME),
} = {}) {
  let spec;
  try {
    spec = readJson(auditPath);
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'unavailable' : 'invalid', reason: 'manual-audit-file-unreadable' };
  }
  if (!spec || typeof spec.labels !== 'object' || Array.isArray(spec.labels)) {
    return { status: 'invalid', reason: 'manual-audit-labels-missing' };
  }
  const officialPath = path.join(dataRoot, 'jobs', 'by-crawler', 'seco-jobroom.json');
  let document;
  try { document = readJson(officialPath); } catch {
    return { status: 'unavailable', reason: 'official-slice-unreadable' };
  }
  const profiles = new Map();
  for (const job of jobsFromDocument(document).filter(isLiveOffer)) {
    const name = employerNameOf(job);
    if (!name) continue;
    if (!profiles.has(name)) profiles.set(name, { offerCount: 0, cantons: new Set(), undisclosedCount: 0 });
    const profile = profiles.get(name);
    profile.offerCount += 1;
    const canton = cantonOf(job);
    if (canton) profile.cantons.add(canton);
    if (job.employerDisclosed === false) profile.undisclosedCount += 1;
  }
  const sample = [...profiles.entries()]
    .map(([name, profile]) => ({ name, ...profile }))
    .sort((left, right) => right.offerCount - left.offerCount || left.name.localeCompare(right.name))
    .slice(0, Number(spec.sampleSize) || 100);
  const missingLabels = sample.map(({ name }) => name).filter((name) => !spec.labels[name]);
  const extraLabels = Object.keys(spec.labels).filter((name) => !profiles.has(name));
  if (missingLabels.length || sample.length !== Number(spec.sampleSize || 100)) {
    return {
      status: 'invalid',
      reason: 'manual-audit-sample-does-not-match-official-slice',
      sampleSize: sample.length,
      missingLabels,
      extraLabels,
    };
  }
  const registry = loadStaffingRegistry(registryPath || path.join(dataRoot, 'seco-staffing-registry.json'));
  const rows = sample.map((row) => {
    const classification = classifyStaffingEmployer(row.name, registry, {
      offerCount: row.offerCount,
      cantons: [...row.cantons],
      cantonCount: row.cantons.size,
      undisclosedCount: row.undisclosedCount,
    });
    return {
      ...row,
      expected: spec.labels[row.name],
      predicted: classification.classification,
      classification,
    };
  });
  const trueAgency = rows.filter((row) => row.expected === 'agency');
  const trueDirect = rows.filter((row) => row.expected === 'direct');
  const truePositive = rows.filter((row) => row.expected === 'agency' && row.predicted === 'agency').length;
  const falsePositiveRows = rows.filter((row) => row.expected === 'direct' && row.predicted === 'agency');
  const falseNegativeRows = rows.filter((row) => row.expected === 'agency' && row.predicted !== 'agency');
  return {
    status: 'ok',
    sampling: spec.sampling,
    manualBasis: spec.manualBasis,
    sampleSize: rows.length,
    agencyEmployers: trueAgency.length,
    directEmployers: trueDirect.length,
    truePositive,
    falsePositive: falsePositiveRows.length,
    falseNegative: falseNegativeRows.length,
    precision: roundRate(truePositive, truePositive + falsePositiveRows.length),
    recall: roundRate(truePositive, truePositive + falseNegativeRows.length),
    residualErrors: {
      falsePositives: falsePositiveRows.slice(0, 3).map(auditRecord),
      falseNegatives: falseNegativeRows.slice(0, 3).map(auditRecord),
    },
    reviewed: rows.map(auditRecord),
  };
}
