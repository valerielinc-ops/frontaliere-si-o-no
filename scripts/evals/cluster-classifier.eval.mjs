#!/usr/bin/env node
/**
 * scripts/evals/cluster-classifier.eval.mjs
 *
 * Phase B+C — Cluster classifier eval suite.
 *
 * Runs the LLM cluster classifier (`classifyHeadlineClusters`) over the
 * ground-truth fixture (`tests/fixtures/cluster-classifier-cases.json`)
 * and reports per-cluster precision/recall + overall accuracy. When a
 * baseline exists, regression > 5pp blocks CI.
 *
 * LLM-as-judge enhancement: for each MISMATCH, calls the AI cluster a
 * second time with a "is this a reasonable disagreement?" prompt — if
 * yes, the mismatch is counted as a soft-pass and the headline is
 * tagged accordingly in the report (but not used to inflate accuracy).
 *
 * Usage:
 *   node scripts/evals/cluster-classifier.eval.mjs            # measure
 *   node scripts/evals/cluster-classifier.eval.mjs --baseline # write baseline
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { classifyHeadlineClusters } from '../lib/article-topic-selector.mjs';
import { CLUSTER_TAXONOMY } from '../lib/cluster-classifier-prompt.mjs';

const FIXTURE_PATH = 'tests/fixtures/cluster-classifier-cases.json';
const REPORT_PATH = 'data/cluster-classifier-eval.json';
const BASELINE_PATH = 'data/cluster-classifier-eval-baseline.json';
const REGRESSION_THRESHOLD_PP = 5; // accuracy drop in percentage points → fail

const args = process.argv.slice(2);
const isBaseline = args.includes('--baseline');

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Compute precision, recall, and support per cluster.
 *
 * Precision[c] = TP / (TP + FP)
 * Recall[c]    = TP / (TP + FN)  (= TP / support)
 * Support[c]   = number of ground-truth cases for cluster c
 */
function perClusterMetrics(cases, predictions) {
  const result = {};
  for (const c of CLUSTER_TAXONOMY) {
    result[c] = { precision: 0, recall: 0, support: 0, tp: 0, fp: 0, fn: 0 };
  }
  for (let i = 0; i < cases.length; i++) {
    const expected = cases[i].expected;
    const predicted = predictions[i];
    if (result[expected]) result[expected].support += 1;
    if (expected === predicted) {
      if (result[expected]) result[expected].tp += 1;
    } else {
      if (result[predicted]) result[predicted].fp += 1;
      if (result[expected]) result[expected].fn += 1;
    }
  }
  for (const c of CLUSTER_TAXONOMY) {
    const m = result[c];
    m.precision = (m.tp + m.fp) > 0 ? m.tp / (m.tp + m.fp) : 0;
    m.recall = (m.tp + m.fn) > 0 ? m.tp / (m.tp + m.fn) : 0;
  }
  return result;
}

/**
 * LLM-as-judge soft-pass check on a single mismatch. Returns true if
 * the judge thinks the disagreement is reasonable (e.g. ambiguous
 * headline that could plausibly land in either cluster).
 *
 * Best-effort — if the judge call fails, return false (count it as a
 * hard mismatch).
 */
async function judgeMismatch(headline, expected, predicted, callLLM) {
  if (typeof callLLM !== 'function') return false;
  const prompt = [
    'Sei un revisore esperto di contenuti per frontalieri italo-svizzeri.',
    `Headline: "${headline}"`,
    `Cluster atteso: ${expected}`,
    `Cluster predetto: ${predicted}`,
    '',
    "L'errore è ragionevole? (l'headline è ambiguo o copre più cluster?)",
    'Rispondi SOLO con "yes" o "no". Niente altro.',
  ].join('\n');
  try {
    const raw = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0, maxTokens: 8 },
    );
    const text = (typeof raw === 'string' ? raw : raw?.content || '').toLowerCase();
    return /\byes\b/.test(text);
  } catch {
    return false;
  }
}

async function main() {
  const fixturePath = resolve(FIXTURE_PATH);
  const fixture = loadJson(fixturePath);
  if (!fixture || !Array.isArray(fixture.cases)) {
    console.error(`[eval] fixture not found or malformed: ${fixturePath}`);
    process.exit(2);
  }

  const headlines = fixture.cases.map((c) => c.headline);
  console.error(`[eval] running cluster classifier on ${headlines.length} cases…`);

  let predictions;
  try {
    predictions = await classifyHeadlineClusters(headlines);
  } catch (e) {
    console.error(`[eval] classifier threw: ${e?.message || e}`);
    process.exit(2);
  }

  const total = fixture.cases.length;
  const correct = predictions.reduce((acc, p, i) => acc + (p === fixture.cases[i].expected ? 1 : 0), 0);
  const accuracy = total > 0 ? correct / total : 0;
  const perCluster = perClusterMetrics(fixture.cases, predictions);

  // Collect mismatches.
  const mismatches = [];
  for (let i = 0; i < total; i++) {
    if (predictions[i] !== fixture.cases[i].expected) {
      mismatches.push({
        headline: fixture.cases[i].headline,
        expected: fixture.cases[i].expected,
        predicted: predictions[i],
        softPass: false,
      });
    }
  }

  // LLM-as-judge soft-pass on mismatches.
  let softPasses = 0;
  if (mismatches.length > 0) {
    try {
      const aiMod = await import('../lib/ai-models.mjs');
      const callLLM = aiMod.callLLM;
      console.error(`[eval] judging ${mismatches.length} mismatches with LLM-as-judge…`);
      for (const m of mismatches) {
        const soft = await judgeMismatch(m.headline, m.expected, m.predicted, callLLM);
        if (soft) {
          m.softPass = true;
          softPasses += 1;
        }
      }
    } catch (e) {
      console.warn(`[eval] judge unavailable, mismatches counted as hard: ${e?.message || e}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    fixtureSize: total,
    correct,
    accuracy,
    softPasses,
    softPassAccuracy: total > 0 ? (correct + softPasses) / total : 0,
    perCluster,
    mismatches,
  };

  if (isBaseline) {
    writeJson(BASELINE_PATH, report);
    console.error(`[eval] baseline written to ${BASELINE_PATH}`);
  }

  writeJson(REPORT_PATH, report);
  console.error(`[eval] report written to ${REPORT_PATH}`);

  const baseline = !isBaseline ? loadJson(BASELINE_PATH) : null;
  const baselineAcc = baseline?.accuracy ?? null;

  const accPct = (accuracy * 100).toFixed(1);
  const baselinePct = baselineAcc != null ? (baselineAcc * 100).toFixed(1) : 'n/a';
  const deltaPct = baselineAcc != null ? ((accuracy - baselineAcc) * 100).toFixed(1) : 'n/a';
  console.log(`[eval] cluster-classifier: accuracy=${accPct}%, baseline=${baselinePct}%, delta=${deltaPct}pp, soft-passes=${softPasses}`);

  if (baselineAcc != null && (baselineAcc - accuracy) * 100 > REGRESSION_THRESHOLD_PP) {
    console.error(`[eval] FAIL — accuracy regressed by ${((baselineAcc - accuracy) * 100).toFixed(1)}pp (>${REGRESSION_THRESHOLD_PP}pp threshold)`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(`[eval] fatal: ${e?.stack || e}`);
  process.exit(2);
});
