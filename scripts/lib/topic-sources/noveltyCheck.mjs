// scripts/lib/topic-sources/noveltyCheck.mjs
//
// Computes a novelty score in [0, 1] for a candidate keyword versus a list
// of existing IT article titles. 1 - max(jaccard_similarity).

import { jaccard } from './gscOrphans.mjs';

/**
 * @param {string} keyword
 * @param {string[]} existingTitles
 * @returns {number}
 */
export function noveltyScore(keyword, existingTitles) {
  if (!keyword) return 0;
  if (!Array.isArray(existingTitles) || existingTitles.length === 0) return 1;
  let maxSim = 0;
  for (const title of existingTitles) {
    const s = jaccard(keyword, title);
    if (s > maxSim) maxSim = s;
    if (maxSim >= 1) break;
  }
  return 1 - maxSim;
}

export default noveltyScore;
