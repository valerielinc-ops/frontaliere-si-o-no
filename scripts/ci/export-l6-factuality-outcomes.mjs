#!/usr/bin/env node

/**
 * Read-only L6 outcome export from an independent editorial review ledger.
 *
 * The ledger is deliberately separate from quality-alert history and from
 * generator reports. Each line is a human/editorial review of one article and
 * locale, with an external source reference and explicit source/locale checks:
 *
 * {
 *   "reviewedAt": "2026-09-15T08:00:00.000Z",
 *   "articleId": "article-id",
 *   "locale": "it",
 *   "verdict": "supported|confirmed_defect|reopened",
 *   "reviewerType": "human|external-editorial",
 *   "observationRef": "quality-alert-id",
 *   "evidence": {
 *     "sourceRef": "editorial-source-ref",
 *     "externalSourceVerified": true,
 *     "localeVerified": true
 *   }
 * }
 *
 * No reviewer name, email, article body, or URL is needed. Missing, stale,
 * duplicate, model-authored, or partially evidenced rows never produce a
 * measured outcome. This script never edits content or source history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadLoopPolicy } from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L6';
export const DEFAULT_LEDGER_PATH = path.join('data', 'editorial-factuality-verdicts.jsonl');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'content-factuality-outcomes.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 36;

const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const VERDICTS = new Set(['supported', 'confirmed_defect', 'reopened']);
const REVIEWER_TYPES = new Set(['human', 'external-editorial']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function finiteDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function hoursBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

function readL6Policy(registryPath) {
  return loadLoopPolicy(registryPath, LOOP_ID).policy;
}

function policySourceRefs(policy) {
  const refs = policy?.outcome?.sourceRefs || policy?.sourceRefs || [];
  return Array.isArray(refs) ? refs.filter(text).map((ref) => ref.trim()) : [];
}

function sourceRefsForRow(evidence) {
  if (Array.isArray(evidence?.sourceRefs)) return evidence.sourceRefs.filter(text).map((ref) => ref.trim());
  return text(evidence?.sourceRef) ? [evidence.sourceRef.trim()] : [];
}

function modelLike(value) {
  return text(value) && /(?:^|[-_ ])(?:llm|model|ai)(?:$|[-_ ])/i.test(value);
}

/** Parse and independently validate every editorial ledger row. */
export function validateEditorialFactualityLedger(ledgerText, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  sourcePath = DEFAULT_LEDGER_PATH,
} = {}) {
  const issues = [];
  const warnings = [];
  const invalidRecords = [];
  const records = [];
  const seen = new Set();
  const lines = String(ledgerText ?? '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    const line = index + 1;
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      const reason = `ledger line ${line}: invalid JSON (${error.message})`;
      issues.push(reason);
      invalidRecords.push({ line, reason });
      continue;
    }
    const rowIssues = [];
    if (!isObject(record)) rowIssues.push('record is not an object');
    const evidence = isObject(record?.evidence) ? record.evidence : null;
    const reviewedAt = finiteDate(record?.reviewedAt);
    const identity = `${String(record?.articleId || '').trim()}\u0000${String(record?.locale || '').trim()}`;
    if (isObject(record)) {
      if (!reviewedAt) rowIssues.push('reviewedAt is missing or invalid');
      if (reviewedAt && reviewedAt.getTime() > now.getTime() + 5 * 60_000) rowIssues.push('reviewedAt is in the future');
      if (!text(record.articleId)) rowIssues.push('articleId is missing');
      if (!LOCALES.has(record.locale)) rowIssues.push('locale is missing or unsupported');
      if (!VERDICTS.has(record.verdict)) rowIssues.push('verdict is missing or unknown');
      if (!REVIEWER_TYPES.has(record.reviewerType) || modelLike(record.reviewerType)) {
        rowIssues.push('reviewerType must be human or external-editorial; model/LLM verdicts are not independent');
      }
      if (!text(record.observationRef)) rowIssues.push('observationRef is missing');
      if (!evidence) rowIssues.push('evidence is missing or not an object');
      if (evidence) {
        if (sourceRefsForRow(evidence).length === 0) rowIssues.push('evidence.sourceRef(s) is missing');
        if (evidence.externalSourceVerified !== true) rowIssues.push('evidence.externalSourceVerified must be true');
        if (evidence.localeVerified !== true) rowIssues.push('evidence.localeVerified must be true');
      }
      const modelFields = Object.keys(record).filter((key) => /(?:llm|model|ai|suggestion|recommendation|verdictSource)/i.test(key));
      if (modelFields.length) rowIssues.push(`model/suggestion fields are not allowed (${modelFields.join(', ')})`);
      if (seen.has(identity)) rowIssues.push('duplicate articleId + locale review');
    }
    if (rowIssues.length) {
      const reason = `ledger line ${line}: ${rowIssues.join(', ')}`;
      issues.push(reason);
      invalidRecords.push({ line, articleId: text(record?.articleId) ? record.articleId : null, locale: record?.locale || null, reason });
      continue;
    }
    seen.add(identity);
    records.push({
      ...record,
      line,
      reviewedAt: reviewedAt.toISOString(),
      sourceRefs: sourceRefsForRow(evidence),
    });
  }

  const latest = records.length
    ? new Date(Math.max(...records.map((record) => Date.parse(record.reviewedAt))))
    : null;
  const latestAgeHours = latest ? hoursBetween(now, latest) : null;
  const staleRecords = records.filter((record) => hoursBetween(now, new Date(record.reviewedAt)) > maxAgeHours);
  if (!records.length) issues.push('editorial factuality ledger has no valid records');
  if (staleRecords.length) {
    issues.push(`editorial factuality ledger has ${staleRecords.length} valid stale record(s) (max ${maxAgeHours}h)`);
  }
  if (latest && latestAgeHours < -0.0834) issues.push('latest editorial factuality review is in the future');
  if (records.length && records.every((record) => record.verdict === 'supported')) {
    warnings.push('editorial ledger contains no confirmed defect; this is a valid zero-defect sample only when fresh and independently evidenced');
  }
  const confirmedDefects = records.filter((record) => record.verdict === 'confirmed_defect' || record.verdict === 'reopened').length;
  const externallyVerifiedDefects = confirmedDefects;
  const reopenedDefects = records.filter((record) => record.verdict === 'reopened').length;
  const quality = !records.length
    ? 'unmeasurable'
    : (staleRecords.length ? 'stale' : (issues.length ? 'partial' : 'observed'));
  return {
    quality,
    independent: quality === 'observed',
    issues,
    warnings,
    records,
    invalidRecords,
    snapshot: {
      path: sourcePath,
      recordCount: records.length,
      reviewedArticles: records.length,
      confirmedDefects,
      externallyVerifiedDefects,
      reopenedDefects,
      invalidRecordCount: invalidRecords.length,
      latestReviewedAt: latest?.toISOString() || null,
      latestAgeHours: latestAgeHours === null ? null : Number(latestAgeHours.toFixed(3)),
      verdictCounts: Object.fromEntries([...VERDICTS].map((verdict) => [verdict, records.filter((record) => record.verdict === verdict).length])),
    },
  };
}

function valuesFromVerdict(verdict) {
  const measurable = verdict?.independent === true && verdict.quality === 'observed';
  return {
    reviewedArticles: measurable && integer(verdict.snapshot?.reviewedArticles) ? verdict.snapshot.reviewedArticles : null,
    confirmedDefects: measurable && integer(verdict.snapshot?.confirmedDefects) ? verdict.snapshot.confirmedDefects : null,
    externallyVerifiedDefects: measurable && integer(verdict.snapshot?.externallyVerifiedDefects) ? verdict.snapshot.externallyVerifiedDefects : null,
    reopenedDefects: measurable && integer(verdict.snapshot?.reopenedDefects) ? verdict.snapshot.reopenedDefects : null,
  };
}

export function buildL6FactualityOutcome({ verdict, policy, now = new Date(), ledgerPath = DEFAULT_LEDGER_PATH } = {}) {
  const values = valuesFromVerdict(verdict);
  const independent = verdict?.independent === true && Object.values(values).every((value) => value !== null);
  const latestReviewedAt = verdict?.snapshot?.latestReviewedAt || null;
  const refs = policySourceRefs(policy);
  return {
    generatedAt: now.toISOString(),
    independent,
    ...values,
    evidence: {
      source: independent
        ? 'independent editorial factuality ledger'
        : 'independent editorial factuality ledger unavailable or invalid',
      sourceRefs: refs,
      externalSourceVerified: independent,
      localeVerified: independent,
      reviewerTypes: ['human', 'external-editorial'],
      latestReviewedAt,
      status: independent ? 'verified' : 'unverified',
    },
    export: {
      schemaVersion: 1,
      sourcePath: ledgerPath,
      readOnly: true,
      generatorIsNotOracle: true,
      publishedContentUntouched: true,
      humanVerdictRequired: true,
      invalidRecordCount: verdict?.invalidRecords?.length || 0,
      mutationsPerformed: false,
    },
    _meta: {
      generatedAt: now.toISOString(),
      source: 'editorial factuality ledger, read-only aggregation',
      purpose: 'Independent source/locale verdict outcome for Loop L6',
      ledgerPath,
    },
  };
}

export function buildUnavailableL6FactualityOutcome({ now = new Date(), ledgerPath = DEFAULT_LEDGER_PATH, policy = {} } = {}) {
  return {
    generatedAt: now.toISOString(),
    independent: false,
    reviewedArticles: null,
    confirmedDefects: null,
    externallyVerifiedDefects: null,
    reopenedDefects: null,
    evidence: {
      source: 'independent editorial factuality ledger unavailable',
      sourceRefs: policySourceRefs(policy),
      externalSourceVerified: false,
      localeVerified: false,
      status: 'unavailable',
    },
    export: {
      schemaVersion: 1,
      sourcePath: ledgerPath,
      readOnly: true,
      unavailable: true,
      generatorIsNotOracle: true,
      publishedContentUntouched: true,
      mutationsPerformed: false,
    },
    _meta: {
      generatedAt: now.toISOString(),
      source: 'independent editorial factuality ledger unavailable',
      purpose: 'Explicit fail-closed placeholder; never a factuality verdict',
      ledgerPath,
    },
  };
}

export function exportL6({
  ledgerPath = DEFAULT_LEDGER_PATH,
  outputPath = DEFAULT_OUTCOME_PATH,
  registryPath = DEFAULT_REGISTRY_PATH,
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
} = {}) {
  const policy = readL6Policy(registryPath);
  const absoluteLedger = path.resolve(ledgerPath);
  if (!fs.existsSync(absoluteLedger)) throw new Error(`editorial factuality ledger is missing: ${ledgerPath}`);
  const verdict = validateEditorialFactualityLedger(fs.readFileSync(absoluteLedger, 'utf8'), { now, maxAgeHours, sourcePath: ledgerPath });
  const outcome = buildL6FactualityOutcome({ verdict, policy, now, ledgerPath });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(outcome, null, 2)}\n`);
  return { outcome, verdict };
}

function parseArgs(argv) {
  const valueAfter = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] || fallback;
  };
  const maxAgeHours = Number(valueAfter('--max-age-hours', String(DEFAULT_MAX_AGE_HOURS)));
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('--max-age-hours must be a finite positive number');
  return {
    json: argv.includes('--json'),
    unavailable: argv.includes('--unavailable'),
    ledgerPath: valueAfter('--ledger', DEFAULT_LEDGER_PATH),
    outputPath: valueAfter('--out', null),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    maxAgeHours,
  };
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  if (!text(options.outputPath)) throw new Error('--out is required');
  const now = new Date();
  const policy = readL6Policy(options.registryPath);
  let result;
  if (options.unavailable) {
    result = { outcome: buildUnavailableL6FactualityOutcome({ now, ledgerPath: options.ledgerPath, policy }), verdict: null };
    fs.mkdirSync(path.dirname(path.resolve(options.outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(options.outputPath), `${JSON.stringify(result.outcome, null, 2)}\n`);
  } else {
    result = exportL6(options);
  }
  logger.log(options.json ? JSON.stringify(result.outcome, null, 2) : `[L6] editorial outcome exported (${result.outcome.independent ? 'verified' : 'unavailable/unverified'})`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[L6] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
