#!/usr/bin/env node
/**
 * Measures how much of the evergreen topic pool is already consumed by
 * existing articles, per section (frontaliere / svizzera) — item 2a of
 * #6019 (parent), issue #6445.
 *
 * Before this script, the pool assembly (PRIORITY_EVERGREEN_TOPICS +
 * buildDynamicEvergreenTopics() + buildStructuralEvergreenTopics() for
 * frontaliere; the *_SVIZZERA equivalents for svizzera — see
 * scripts/create-article.mjs L10545-10547) and the duplicate check that
 * consumes it (preFlightEvergreenTopicCheck) were internal, unexported
 * functions: no tool could report how close either section is to
 * exhausting its pool (the saturation class of bug tracked in #3138).
 *
 * Run: node scripts/evergreen-pool-consumption.mjs [--json]
 */
import {
  PRIORITY_EVERGREEN_TOPICS,
  PRIORITY_EVERGREEN_TOPICS_SVIZZERA,
  buildDynamicEvergreenTopics,
  buildDynamicEvergreenTopicsSvizzera,
  preFlightEvergreenTopicCheck,
  loadExistingArticleSummaries,
} from './create-article.mjs';
import { buildStructuralEvergreenTopics } from './lib/evergreen-topic-generator.mjs';

const asJson = process.argv.includes('--json');

// Mirrors the section-aware pool assembly at create-article.mjs L10545-10547:
// only frontaliere draws from the structural (profession × comune) pool.
const POOLS = {
  frontaliere: [...PRIORITY_EVERGREEN_TOPICS, ...buildDynamicEvergreenTopics(), ...buildStructuralEvergreenTopics()],
  svizzera: [...PRIORITY_EVERGREEN_TOPICS_SVIZZERA, ...buildDynamicEvergreenTopicsSvizzera()],
};

const existingArticles = loadExistingArticleSummaries();

const results = Object.entries(POOLS).map(([section, pool]) => {
  const poolTotal = pool.length;
  let poolConsumed = 0;
  for (const candidate of pool) {
    if (preFlightEvergreenTopicCheck(candidate, existingArticles).duplicate) poolConsumed += 1;
  }
  const poolRemaining = poolTotal - poolConsumed;
  const poolConsumedPct = poolTotal > 0 ? Number(((poolConsumed / poolTotal) * 100).toFixed(1)) : 0;
  return { section, poolTotal, poolRemaining, poolConsumed, poolConsumedPct };
});

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`Existing articles (cross-section): ${existingArticles.length}\n`);
  for (const r of results) {
    console.log(`${r.section}:`);
    console.log(`  poolTotal:      ${r.poolTotal}`);
    console.log(`  poolConsumed:   ${r.poolConsumed} (${r.poolConsumedPct}%)`);
    console.log(`  poolRemaining:  ${r.poolRemaining}`);
    console.log('');
  }
}
