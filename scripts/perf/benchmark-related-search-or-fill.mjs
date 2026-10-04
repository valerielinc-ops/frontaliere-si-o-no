#!/usr/bin/env node
/**
 * Paired benchmark for the related-search OR-fill execution plan.
 *
 * Usage:
 *   node scripts/perf/benchmark-related-search-or-fill.mjs
 *
 * Each scenario creates one deterministic set of posting lists and runs both
 * the pre-PR full-corpus scan and the current touched-index plan against that
 * exact input. The single accepted index keeps the OR loop traversing every
 * score bucket, which models the occupation predicate rejecting nearly all
 * sparse candidates while retaining an observable result-equivalence check.
 */

const CORPUS_SIZE = 349_000;
const FULL_SCORE = 6;
const MIN_SCORE = 1;
const MAX_JOBS = 30;
const ITERATIONS = 9;
const WARMUPS = 2;

const SCENARIOS = [
  { name: 'sparse', touchedCount: 12_000 },
  { name: 'dense', touchedCount: 280_000 },
];

function buildPostingLists(touchedCount) {
  const touched = Array.from({ length: touchedCount }, (_, position) => {
    if (position === 0) return 0;
    return 1 + ((position * 7919) % (CORPUS_SIZE - 1));
  });
  const lists = Array.from({ length: FULL_SCORE }, () => []);

  for (let position = 0; position < touched.length; position++) {
    const score = 1 + (position % (FULL_SCORE - 1));
    for (let level = 0; level < score; level++) lists[level].push(touched[position]);
  }
  for (const list of lists) list.sort((a, b) => a - b);
  return lists;
}

function fillBefore(lists) {
  const scores = new Uint8Array(CORPUS_SIZE);
  const touched = [];
  for (const list of lists) {
    for (const idx of list) {
      if (scores[idx] === 0) touched.push(idx);
      scores[idx]++;
    }
  }

  const out = [];
  for (let score = FULL_SCORE - 1; score >= MIN_SCORE && out.length < MAX_JOBS; score--) {
    for (let idx = 0; idx < scores.length && out.length < MAX_JOBS; idx++) {
      if (scores[idx] === score && idx === 0) out.push(idx);
    }
  }
  return out;
}

function fillAfter(lists) {
  const scores = new Uint8Array(CORPUS_SIZE);
  const touched = [];
  for (const list of lists) {
    for (const idx of list) {
      if (scores[idx] === 0) touched.push(idx);
      scores[idx]++;
    }
  }

  const scoreLevels = FULL_SCORE - MIN_SCORE;
  if (scoreLevels <= 0) return [];
  const touchedSortCost = touched.length > 1 ? Math.ceil(Math.log2(touched.length)) : 0;
  const useTouchedOrder =
    touched.length * (scoreLevels + touchedSortCost) < scores.length * scoreLevels;
  const orderedTouched = useTouchedOrder ? touched.sort((a, b) => a - b) : null;

  const out = [];
  for (let score = FULL_SCORE - 1; score >= MIN_SCORE && out.length < MAX_JOBS; score--) {
    if (orderedTouched) {
      for (const idx of orderedTouched) {
        if (out.length >= MAX_JOBS) break;
        if (scores[idx] === score && idx === 0) out.push(idx);
      }
    } else {
      for (let idx = 0; idx < scores.length && out.length < MAX_JOBS; idx++) {
        if (scores[idx] === score && idx === 0) out.push(idx);
      }
    }
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(fn, lists) {
  for (let i = 0; i < WARMUPS; i++) fn(lists);
  const timings = [];
  let signature = '';
  for (let i = 0; i < ITERATIONS; i++) {
    const started = process.hrtime.bigint();
    const result = fn(lists);
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    signature = `${result.length}:${result.join(',')}`;
  }
  return { medianMs: median(timings), signature };
}

console.log(`[related-search-or-fill-bench] corpus=${CORPUS_SIZE} fullScore=${FULL_SCORE} minScore=${MIN_SCORE} iterations=${ITERATIONS}`);
for (const scenario of SCENARIOS) {
  const lists = buildPostingLists(scenario.touchedCount);
  const before = measure(fillBefore, lists);
  const after = measure(fillAfter, lists);
  if (before.signature !== after.signature) {
    throw new Error(`${scenario.name}: before/after result mismatch (${before.signature} vs ${after.signature})`);
  }
  console.log(
    `[related-search-or-fill-bench] ${scenario.name} touched=${scenario.touchedCount} `
    + `before=${before.medianMs.toFixed(2)}ms after=${after.medianMs.toFixed(2)}ms `
    + `speedup=${(before.medianMs / after.medianMs).toFixed(2)}x result=${after.signature}`,
  );
}
