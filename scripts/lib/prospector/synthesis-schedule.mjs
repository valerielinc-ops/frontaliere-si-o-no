/**
 * Keep vacancy volume as the main synthesis signal while reserving capacity
 * for older, smaller employers so a high-volume tail cannot starve them.
 */
export function prioritizeSynthesisCandidates(candidates, limit) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max) return [];

  const oldestFirst = [...candidates].sort((a, b) =>
    String(a?.firstSeenAt || a?.updatedAt || '\uffff').localeCompare(String(b?.firstSeenAt || b?.updatedAt || '\uffff'))
    || String(a?.key || '').localeCompare(String(b?.key || '')));
  const byVacancyVolume = [...candidates].sort((a, b) =>
    (Number(b?.vacancyCount) || 0) - (Number(a?.vacancyCount) || 0)
    || String(a?.firstSeenAt || a?.updatedAt || '\uffff').localeCompare(String(b?.firstSeenAt || b?.updatedAt || '\uffff'))
    || String(a?.key || '').localeCompare(String(b?.key || '')));

  if (candidates.length <= max) return byVacancyVolume;
  const fairnessSlots = Math.max(1, Math.ceil(max * 0.25));
  const reserved = oldestFirst.slice(0, fairnessSlots);
  const reservedSet = new Set(reserved);
  return [
    ...reserved,
    ...byVacancyVolume.filter((candidate) => !reservedSet.has(candidate)),
  ].slice(0, max);
}
