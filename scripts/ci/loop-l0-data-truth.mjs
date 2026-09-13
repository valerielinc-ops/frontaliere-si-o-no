#!/usr/bin/env node

/** L0 — Data Truth & Freshness. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTICLES_API_BASE } from '../lib/articles-api-base.mjs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import {
  buildDecision,
  buildObservation,
  loadLoopPolicy,
  validateActionClassAgainstPolicy,
} from '../lib/loop-fleet-contract.mjs';

export const LOOP_ID = 'L0';
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const DEFAULT_MAX_AGE_HOURS = 48;
export const REQUIRED_COUNTS = Object.freeze([
  'articles',
  'swissArticles',
  'sitemapBlogUrls',
  'sitemapBlogChUrls',
]);
const COMMIT_RE = /^[0-9a-f]{40}$/iu;

function hoursBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

function finiteDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function baseVerdict({ url, now, quality, ok, reason, issues = [], manifest = null }) {
  return {
    loopId: LOOP_ID,
    url,
    checkedAt: now.toISOString(),
    ok,
    quality,
    reason,
    issues,
    manifest,
  };
}

/**
 * Validate the remote contract without guessing missing values.
 * `zero` is reserved for an explicit zero count; a transport/JSON failure is
 * `unmeasurable`, and a missing field is `partial`.
 */
export function validateManifest(manifest, {
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  url = `${ARTICLES_API_BASE}/manifest.json`,
} = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return baseVerdict({ url, now, quality: 'unmeasurable', ok: false, reason: 'manifest is not a JSON object' });
  }
  const issues = [];
  if (!COMMIT_RE.test(String(manifest.commit || ''))) issues.push('commit is missing or is not a full git SHA');
  const generatedAt = finiteDate(manifest.generatedAt);
  if (!generatedAt) issues.push('generatedAt is missing or invalid');
  const counts = manifest.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    issues.push('counts object is missing');
  }
  const countValues = {};
  for (const key of REQUIRED_COUNTS) {
    const value = counts?.[key];
    if (!Number.isInteger(value) || value < 0) issues.push(`counts.${key} is missing or not a non-negative integer`);
    else countValues[key] = value;
  }
  if (Number.isInteger(countValues.articles) && countValues.articles === 0) issues.push('counts.articles is explicitly zero');
  if (Number.isInteger(countValues.swissArticles) && Number.isInteger(countValues.articles)
      && countValues.swissArticles > countValues.articles) issues.push('swissArticles exceeds articles');
  if (Number.isInteger(countValues.sitemapBlogUrls) && Number.isInteger(countValues.articles)
      && countValues.sitemapBlogUrls > countValues.articles) issues.push('sitemapBlogUrls exceeds articles');
  if (Number.isInteger(countValues.sitemapBlogChUrls) && Number.isInteger(countValues.swissArticles)
      && countValues.sitemapBlogChUrls > countValues.swissArticles) issues.push('sitemapBlogChUrls exceeds swissArticles');

  let ageHours = null;
  if (generatedAt) {
    ageHours = hoursBetween(now, generatedAt);
    if (ageHours < -0.0834) issues.push('generatedAt is in the future');
    if (ageHours > maxAgeHours) issues.push(`manifest is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`);
  }
  const snapshot = {
    source: 'corpus-api',
    url,
    commit: COMMIT_RE.test(String(manifest.commit || '')) ? manifest.commit : null,
    generatedAt: generatedAt?.toISOString() || null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)),
    counts: countValues,
  };
  let quality = 'observed';
  if (issues.some((issue) => /explicitly zero/u.test(issue))) quality = 'zero';
  else if (issues.length > 0) quality = issues.some((issue) => /missing|invalid|not a|object/u.test(issue)) ? 'partial' : 'stale';
  return baseVerdict({
    url,
    now,
    quality,
    ok: issues.length === 0,
    reason: issues.length === 0
      ? `manifest ${manifest.commit.slice(0, 8)} is complete and ${ageHours.toFixed(1)}h old`
      : issues.join('; '),
    issues,
    manifest: snapshot,
  });
}

export async function fetchManifest({
  url = `${ARTICLES_API_BASE}/manifest.json`,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const response = await fetchImpl(url, {
    redirect: 'follow',
    headers: { accept: 'application/json' },
  });
  if (!response?.ok) throw new Error(`manifest HTTP ${response?.status ?? 'unknown'}`);
  const body = await response.text();
  if (!body.trim()) throw new Error('manifest response is empty');
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`manifest JSON is invalid: ${error.message}`);
  }
}

function reportMarkdown(verdict, observation, decision) {
  const lines = [
    `## L0 Data Truth & Freshness — ${verdict.ok ? 'OK' : 'ACTION REQUIRED'}`,
    '',
    `- Quality: **${verdict.quality}**`,
    `- Source: ${verdict.url}`,
    `- Reason: ${verdict.reason}`,
    `- Primary metric: ${observation.primaryMetric}`,
    `- Decision: **${decision.decision}** (${decision.actionClass})`,
    `- Rollback: ${decision.rollbackPlan}`,
  ];
  if (verdict.issues.length) lines.push('', '### Evidence', ...verdict.issues.map((issue) => `- ${issue}`));
  return `${lines.join('\n')}\n`;
}

function writeReports(reportDir, verdict, observation, decision) {
  if (!reportDir) return [];
  const dir = path.resolve(reportDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['l0-observation.json', observation],
    ['l0-decision.json', decision],
    ['l0-report.md', reportMarkdown(verdict, observation, decision)],
  ];
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return files.map(([name]) => path.join(dir, name));
}

function issueBody(verdict, decision) {
  return [
    `L0 ha rilevato che il manifest del corpus non può essere usato come fonte affidabile.`,
    '',
    `- Source: ${verdict.url}`,
    `- Quality: ${verdict.quality}`,
    `- Reason: ${verdict.reason}`,
    `- Decision: ${decision.decision} / ${decision.actionClass}`,
    '',
    'Azione sicura: mantenere l’ultima superficie valida, correggere il publisher o il trasporto e rieseguire il controllo. Nessun valore viene sintetizzato e nessun file pubblico viene sovrascritto da questo reporter.',
    '',
    'Comando di verifica: `node scripts/ci/loop-l0-data-truth.mjs --json --dry-run`',
  ].join('\n');
}

function writeResult(reportDir, { verdict, issued, quarantined }) {
  if (!reportDir) return null;
  const file = path.join(path.resolve(reportDir), 'l0-result.json');
  fs.writeFileSync(file, `${JSON.stringify({
    loopId: LOOP_ID,
    ok: verdict.ok,
    quality: verdict.quality,
    issueCount: verdict.issues.length,
    issued,
    quarantined,
  }, null, 2)}\n`);
  return file;
}

export async function runL0({
  now = new Date(),
  url = `${ARTICLES_API_BASE}/manifest.json`,
  registryPath = DEFAULT_REGISTRY_PATH,
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  fetchImpl = globalThis.fetch,
  issue = false,
  apply = false,
  reportDir = null,
  createIssueImpl = createGithubIssue,
  logger = console,
} = {}) {
  let loopRegistry = null;
  let loopPolicy = null;
  let actionPolicy = null;
  let verdict;
  try {
    ({ registry: loopRegistry, policy: loopPolicy } = loadLoopPolicy(registryPath, LOOP_ID));
    const manifest = await fetchManifest({ url, fetchImpl });
    verdict = validateManifest(manifest, { now, maxAgeHours, url });
  } catch (error) {
    verdict = baseVerdict({
      url,
      now,
      quality: 'unmeasurable',
      ok: false,
      reason: error.message,
    });
  }
  const actionClass = verdict.ok ? 'observe' : 'issue+quarantine';
  if (loopRegistry && loopPolicy) {
    try {
      actionPolicy = validateActionClassAgainstPolicy(loopRegistry, LOOP_ID, actionClass);
    } catch (error) {
      loopRegistry = null;
      loopPolicy = null;
      verdict = baseVerdict({
        url,
        now,
        quality: 'unmeasurable',
        ok: false,
        reason: error.message,
      });
    }
  }
  const measurable = verdict.quality !== 'unmeasurable' && verdict.quality !== 'partial' && verdict.quality !== 'missing';
  const generatedAt = finiteDate(verdict.manifest?.generatedAt);
  const observationStart = generatedAt && generatedAt.getTime() <= now.getTime()
    ? generatedAt.toISOString()
    : now.toISOString();
  const observation = buildObservation({
    loopId: LOOP_ID,
    goal: loopPolicy?.goal || 'Data Truth & Freshness',
    owner: loopPolicy?.owner || 'CDO / Chief Trust',
    oracle: loopPolicy?.oracle || 'independent corpus manifest and HTTP contract',
    hypothesis: 'A complete, fresh manifest is required before downstream data decisions.',
    sourceSnapshot: verdict.manifest || { source: 'corpus-api', url, commit: null },
    observationWindow: { start: observationStart, end: now.toISOString(), timezone: 'UTC' },
    cohort: 'published-corpus-manifest',
    numerator: measurable ? (verdict.ok ? 1 : 0) : null,
    denominator: measurable ? 1 : null,
    primaryMetric: loopPolicy?.primaryMetric || 'fresh_complete_manifest_rate',
    guardrails: loopPolicy?.guardrails || ['missing is not zero', 'last valid surface remains untouched'],
    minimumSample: loopPolicy?.minimumSample || 1,
    actionClass,
    quality: verdict.quality,
    recordedAt: now.toISOString(),
  });
  const decision = buildDecision({
    loopId: LOOP_ID,
    goal: loopPolicy?.goal || 'Data Truth & Freshness',
    owner: loopPolicy?.owner || 'CDO / Chief Trust',
    oracle: loopPolicy?.oracle || 'independent corpus manifest and HTTP contract',
    sourceSnapshot: observation.sourceSnapshot,
    observationWindow: observation.observationWindow,
    cohort: observation.cohort,
    decision: verdict.ok ? 'observing' : 'candidate',
    reason: verdict.reason,
    actionClass,
    rollbackPlan: 'discard runner-local quarantine evidence; keep the previous published surface',
    startedAt: observation.observationWindow.start,
    expiresAt: new Date(now.getTime() + (loopPolicy?.lifecycle.candidateTtlHours || 2) * 3_600_000).toISOString(),
    decidedAt: now.toISOString(),
  });
  const files = writeReports(reportDir, verdict, observation, decision);
  let issued = false;
  let quarantined = false;
  if (apply && !verdict.ok && reportDir && actionPolicy) {
    fs.writeFileSync(path.join(path.resolve(reportDir), 'l0-quarantine.json'), `${JSON.stringify({
      loopId: LOOP_ID,
      quarantinedAt: now.toISOString(),
      source: verdict.url,
      reason: verdict.reason,
      actionClass,
      requiredAutonomy: actionPolicy.requiredAutonomy,
      maxAutonomy: loopPolicy.maxAutonomy,
      previousSurfaceUntouched: true,
    }, null, 2)}\n`);
    quarantined = true;
  }
  if (issue && !verdict.ok) {
    await createIssueImpl({
      title: 'L0 Data Truth: corpus manifest is not usable',
      description: issueBody(verdict, decision),
      priority: 2,
      labels: ['monitoring', 'data-quality', 'loop-l0'],
      workflow: 'Loop L0 Data Truth',
    });
    issued = true;
  }
  const resultFile = writeResult(reportDir, { verdict, issued, quarantined });
  if (resultFile) files.push(resultFile);
  logger.log(`[L0] ${verdict.ok ? 'OK' : 'NOT MEASURABLE'} — ${verdict.reason}`);
  return { verdict, observation, decision, files, issued, quarantined };
}

function parseArgs(argv) {
  const valueAfter = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] || fallback;
  };
  const maxAgeHours = Number(valueAfter('--max-age-hours', DEFAULT_MAX_AGE_HOURS));
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error('--max-age-hours must be a finite positive number');
  }
  return {
    json: argv.includes('--json'),
    issue: argv.includes('--issue'),
    apply: argv.includes('--apply'),
    strict: argv.includes('--strict'),
    dryRun: argv.includes('--dry-run'),
    url: valueAfter('--url', `${ARTICLES_API_BASE}/manifest.json`),
    registryPath: valueAfter('--registry', DEFAULT_REGISTRY_PATH),
    maxAgeHours,
    reportDir: valueAfter('--report-dir', process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'loop-fleet-l0') : null),
  };
}

export async function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const runLogger = options.json
    ? { ...logger, log: () => {} }
    : logger;
  const result = await runL0({ ...options, issue: options.issue && !options.dryRun, logger: runLogger });
  if (options.json) logger.log(JSON.stringify({
    verdict: result.verdict,
    observation: result.observation,
    decision: result.decision,
    issued: result.issued,
    quarantined: result.quarantined,
  }, null, 2));
  if (options.strict && !result.verdict.ok) process.exitCode = 2;
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L0] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
