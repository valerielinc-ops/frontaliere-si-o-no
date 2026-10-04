#!/usr/bin/env node

/**
 * Read-only L6 outcome export from an independent factuality review ledger.
 *
 * The ledger is deliberately separate from quality-alert history and from
 * generator reports. Each line reviews one article and locale. Three
 * `reviewerType` values are accepted:
 *
 * - `human` and `external-editorial`: an editorial review with an external
 *   source reference and explicit source/locale checks.
 * - `automated-source-check`: a deterministic check, without any model, that
 *   downloaded the external source cited by the article during the run and
 *   compared the article's figures with it. Authorised by the owner decision
 *   of 2026-09-24 in `DECISIONS.md` ("Loop L1-L11 automatici": the oracle is a
 *   pull from external systems, including the sources cited for L6).
 *
 * Editorial row:
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
 * Automated row (every field is required):
 *
 * {
 *   "reviewedAt": "2026-09-15T08:00:00.000Z",
 *   "articleId": "article-id",
 *   "locale": "de",
 *   "verdict": "supported|confirmed_defect",
 *   "reviewerType": "automated-source-check",
 *   "observationRef": "L6.source-check.article-id.de",
 *   "evidence": {
 *     "method": "figures-in-source+locale-numeric-parity",
 *     "sourceUrl": "https://www.example-authority.ch/source/",
 *     "sourceRefs": ["https://www.example-authority.ch/source/"],
 *     "sourceHttpStatus": 200,
 *     "sourceFetchedAt": "2026-09-15T07:59:00.000Z",
 *     "sourceSha256": "<64 lowercase hex chars of the downloaded body>",
 *     "figuresChecked": 4,
 *     "figuresMatched": 4,
 *     "missingFigures": ["only for confirmed_defect: the figures not found"],
 *     "externalSourceVerified": true,
 *     "localeVerified": true
 *   }
 * }
 *
 * An automated row only attests the figures it compared: it never claims
 * that the article is correct beyond them, and it always states how many
 * figures it checked. Its source must be an https URL on a third-party host
 * (not this site or its own mirrors, not an IP literal, not localhost), every
 * declared source ref must be that downloaded URL, and the download must carry
 * a full ISO timestamp, be fresh and precede the review. `supported` requires every checked figure to match;
 * `confirmed_defect` requires at least one missing figure, listed; an
 * automated check never emits `reopened`.
 *
 * No reviewer name, email, or article body is needed; only automated rows
 * carry a URL, and only the third-party source URL. Missing, stale, duplicate,
 * model-authored, or partially evidenced rows never produce a measured
 * outcome. This script never edits content or source history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LOOP_ID = 'L6';
export const DEFAULT_LEDGER_PATH = path.join('data', 'editorial-factuality-verdicts.jsonl');
export const DEFAULT_OUTCOME_PATH = path.join('data', 'content-factuality-outcomes.json');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 36;

const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const VERDICTS = new Set(['supported', 'confirmed_defect', 'reopened']);
export const AUTOMATED_REVIEWER_TYPE = 'automated-source-check';
const REVIEWER_TYPES = new Set(['human', 'external-editorial', AUTOMATED_REVIEWER_TYPE]);
export const AUTOMATED_METHOD = 'figures-in-source+locale-numeric-parity';
// Hosts that serve this project's own site, corpus or mirrors: a page there is
// never an independent source. Each entry also covers its subdomains.
const OWN_HOSTS = [
  'frontaliereticino.ch',
  'frontaliere-ticino.web.app',
  'frontaliere-ticino.firebaseapp.com',
  'nanakokyobashi-rgb.github.io',
  'valerielinc-ops.github.io',
];
const CLOCK_SKEW_MS = 5 * 60_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

function readJson(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function readL6Policy(registryPath) {
  const registry = readJson(registryPath, 'loop fleet registry');
  const policy = Array.isArray(registry.loops)
    ? registry.loops.find((loop) => loop?.loopId === LOOP_ID)
    : null;
  if (!isObject(policy)) throw new Error('L6 policy is missing from the loop fleet registry');
  return policy;
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

/**
 * Why a URL is not an independent third-party https source, or null.
 * Exported so the L6 producer (`scripts/lib/l6-source-check.mjs`) applies the
 * very rule that validates its rows instead of a copy that could drift.
 */
export function independentSourceUrlIssue(value) {
  if (!text(value)) return 'evidence.sourceUrl is missing';
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'evidence.sourceUrl is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'evidence.sourceUrl must use https';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (OWN_HOSTS.some((own) => host === own || host.endsWith(`.${own}`))) {
    return 'evidence.sourceUrl must not be this site or one of its mirrors (an own page is not an independent source)';
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'evidence.sourceUrl must not be localhost';
  if (host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return 'evidence.sourceUrl must not be an IP literal';
  }
  return null;
}

/**
 * Extra evidence an automated-source-check row must carry: proof that the
 * external source was downloaded in this run and that the verdict follows
 * from the figure counts. Rows of the other reviewer types are unaffected.
 */
function automatedSourceCheckIssues(record, evidence, reviewedAt, { now, maxAgeHours }) {
  const issues = [];
  if (evidence.method !== AUTOMATED_METHOD || modelLike(evidence.method)) {
    issues.push(`evidence.method must be ${AUTOMATED_METHOD} for ${AUTOMATED_REVIEWER_TYPE}`);
  }
  const urlIssue = independentSourceUrlIssue(evidence.sourceUrl);
  if (urlIssue) issues.push(urlIssue);
  if (text(evidence.sourceUrl)) {
    // Checked on the raw fields, not on sourceRefsForRow(): that helper drops
    // non-text entries and ignores sourceRef when sourceRefs exists, so junk
    // or a second declared source would slip through.
    const url = evidence.sourceUrl.trim();
    const refs = evidence.sourceRefs;
    const refsExact = Array.isArray(refs)
      ? refs.length > 0 && refs.every((ref) => typeof ref === 'string' && ref.trim() === url)
      : typeof evidence.sourceRef === 'string' && evidence.sourceRef.trim() === url;
    const singleRefCoherent = evidence.sourceRef === undefined
      || (typeof evidence.sourceRef === 'string' && evidence.sourceRef.trim() === url);
    if (!refsExact || !singleRefCoherent) {
      issues.push('evidence.sourceRefs must contain exactly evidence.sourceUrl (the declared source is the downloaded one)');
    }
  }
  if (evidence.sourceHttpStatus !== 200) issues.push(`evidence.sourceHttpStatus must be 200 for ${AUTOMATED_REVIEWER_TYPE}`);
  const fetchedAt = typeof evidence.sourceFetchedAt === 'string' && ISO_TIMESTAMP.test(evidence.sourceFetchedAt)
    ? finiteDate(evidence.sourceFetchedAt)
    : null;
  if (!fetchedAt) {
    issues.push('evidence.sourceFetchedAt is missing or not a full ISO timestamp');
  } else {
    if (fetchedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) issues.push('evidence.sourceFetchedAt is in the future');
    if (hoursBetween(now, fetchedAt) > maxAgeHours) issues.push(`evidence.sourceFetchedAt is older than ${maxAgeHours}h`);
    if (reviewedAt && fetchedAt.getTime() > reviewedAt.getTime() + CLOCK_SKEW_MS) {
      issues.push('evidence.sourceFetchedAt is later than reviewedAt');
    }
  }
  if (typeof evidence.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.sourceSha256)) {
    issues.push('evidence.sourceSha256 must be 64 lowercase hex characters');
  }
  const checked = evidence.figuresChecked;
  const matched = evidence.figuresMatched;
  const checkedValid = Number.isInteger(checked) && checked >= 1;
  if (!checkedValid) issues.push('evidence.figuresChecked must be an integer >= 1');
  const matchedValid = Number.isInteger(matched) && matched >= 0 && (!checkedValid || matched <= checked);
  if (!matchedValid) issues.push('evidence.figuresMatched must be an integer between 0 and evidence.figuresChecked');
  if (checkedValid && matchedValid) {
    if (record.verdict === 'supported' && matched !== checked) {
      issues.push('supported requires evidence.figuresMatched === evidence.figuresChecked');
    }
    if (record.verdict === 'confirmed_defect') {
      if (matched >= checked) issues.push('confirmed_defect requires evidence.figuresMatched < evidence.figuresChecked');
      if (!Array.isArray(evidence.missingFigures) || evidence.missingFigures.length === 0 || !evidence.missingFigures.every(text)) {
        issues.push('confirmed_defect requires evidence.missingFigures as a non-empty list of non-empty strings');
      }
    }
  }
  if (record.verdict === 'reopened') issues.push(`reopened is not allowed for ${AUTOMATED_REVIEWER_TYPE}`);
  return issues;
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
        rowIssues.push('reviewerType must be human, external-editorial or automated-source-check; model/LLM verdicts are not independent');
      }
      if (!text(record.observationRef)) rowIssues.push('observationRef is missing');
      if (!evidence) rowIssues.push('evidence is missing or not an object');
      if (evidence) {
        if (sourceRefsForRow(evidence).length === 0) rowIssues.push('evidence.sourceRef(s) is missing');
        if (evidence.externalSourceVerified !== true) rowIssues.push('evidence.externalSourceVerified must be true');
        if (evidence.localeVerified !== true) rowIssues.push('evidence.localeVerified must be true');
        if (record.reviewerType === AUTOMATED_REVIEWER_TYPE) {
          rowIssues.push(...automatedSourceCheckIssues(record, evidence, reviewedAt, { now, maxAgeHours }));
        }
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
      reviewerTypes: [...REVIEWER_TYPES],
      latestReviewedAt,
      status: independent ? 'verified' : 'unverified',
    },
    export: {
      schemaVersion: 1,
      sourcePath: ledgerPath,
      readOnly: true,
      generatorIsNotOracle: true,
      publishedContentUntouched: true,
      modelVerdictsRejected: true,
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
