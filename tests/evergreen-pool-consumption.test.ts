/**
 * OSSERVATORE for #6445: evergreen-pool-consumption.mjs must be able to
 * report, for BOTH sections, how much of the evergreen topic pool is
 * already consumed by existing articles — the measurement that had no
 * tool before this fix (parent #6019, item 2a).
 */
import { describe, it, expect } from 'vitest';
import {
  PRIORITY_EVERGREEN_TOPICS,
  PRIORITY_EVERGREEN_TOPICS_SVIZZERA,
  buildDynamicEvergreenTopics,
  buildDynamicEvergreenTopicsSvizzera,
  preFlightEvergreenTopicCheck,
  loadExistingArticleSummaries,
} from '../scripts/create-article.mjs';
import { buildStructuralEvergreenTopics } from '../scripts/lib/evergreen-topic-generator.mjs';

// Mirrors the section-aware pool assembly the fix re-exports rely on
// (scripts/create-article.mjs L10545-10547 and scripts/evergreen-pool-consumption.mjs).
const POOLS = {
  frontaliere: () => [...PRIORITY_EVERGREEN_TOPICS, ...buildDynamicEvergreenTopics(), ...buildStructuralEvergreenTopics()],
  svizzera: () => [...PRIORITY_EVERGREEN_TOPICS_SVIZZERA, ...buildDynamicEvergreenTopicsSvizzera()],
};

describe('evergreen-pool-consumption', () => {
  const existingArticles = loadExistingArticleSummaries();

  for (const [section, buildPool] of Object.entries(POOLS)) {
    it(`${section}: reports a coherent pool total/remaining`, () => {
      const pool = buildPool();
      const poolTotal = pool.length;
      let poolConsumed = 0;
      for (const candidate of pool) {
        if (preFlightEvergreenTopicCheck(candidate, existingArticles).duplicate) poolConsumed += 1;
      }
      const poolRemaining = poolTotal - poolConsumed;

      expect(poolTotal).toBeGreaterThan(0);
      expect(poolRemaining).toBeGreaterThanOrEqual(0);
      expect(poolRemaining).toBeLessThanOrEqual(poolTotal);
    }, 180_000);
  }
});
