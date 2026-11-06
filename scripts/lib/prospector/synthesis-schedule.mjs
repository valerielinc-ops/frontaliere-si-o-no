import {
  compareCoveragePriority,
  selectWithRestCantonQuota,
} from './coverage-priority.mjs';

function compareOldest(a, b) {
  return String(a?.firstSeenAt || a?.updatedAt || '\uffff').localeCompare(String(b?.firstSeenAt || b?.updatedAt || '\uffff'))
    || String(a?.key || '').localeCompare(String(b?.key || ''));
}

function compareVolume(a, b) {
  return (Number(b?.vacancyCount) || 0) - (Number(a?.vacancyCount) || 0)
    || compareOldest(a, b);
}

function selectSynthesisPool(candidates, limit, now) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max || !candidates.length) return [];

  const oldestFirst = [...candidates].sort((a, b) => compareCoveragePriority(a, b, now, compareOldest));
  const byVacancyVolume = [...candidates].sort((a, b) => compareCoveragePriority(a, b, now, compareVolume));
  if (candidates.length <= max) return byVacancyVolume;
  const fairnessSlots = Math.max(1, Math.ceil(max * 0.25));
  const reserved = oldestFirst.slice(0, fairnessSlots);
  const reservedSet = new Set(reserved);
  return [
    ...reserved,
    ...byVacancyVolume.filter((candidate) => !reservedSet.has(candidate)),
  ].slice(0, max);
}

/**
 * Keep vacancy volume as the main synthesis signal while reserving capacity
 * for older, smaller employers so a high-volume tail cannot starve them. The
 * cross-stage frontier quota is applied outside that fairness policy.
 */
export function parseSynthesisLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('--limit must be a non-negative safe integer');
  }
  return limit;
}

export function prioritizeSynthesisCandidates(candidates, limit, now = Date.now()) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max) return [];

  return selectWithRestCantonQuota(candidates, max, {
    compare: (a, b) => compareCoveragePriority(a, b, now, compareVolume),
    selectPool: (pool, budget) => selectSynthesisPool(pool, budget, now),
  });
}
