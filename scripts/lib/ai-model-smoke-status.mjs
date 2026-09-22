function attemptedFailure(message) {
  const text = String(message || '');
  const marker = 'Errors: ';
  const causes = text.includes(marker)
    ? text.slice(text.indexOf(marker) + marker.length).split(/\s+\|\s+/u)
    : [text];
  return causes.findLast((cause) => !/skipped —/iu.test(cause)) || causes.at(-1) || text;
}

export function classifyAiModelSmokeFailure(message) {
  const cause = attemptedFailure(message);

  if (/catalogo GitHub Models non disponibile \(brownout \d+\)|publisher non osservabile[^|]*brownout \d+/iu.test(cause)) {
    return 'github_catalog_brownout';
  }
  if (/catalogo GitHub Models non disponibile[^|]*(JSON non valido|forma JSON non valida|envelope JSON ambiguo)/iu.test(cause)) {
    return 'github_catalog_invalid';
  }
  if (/catalogo GitHub Models non disponibile/iu.test(cause)) {
    return 'github_catalog_unavailable';
  }
  if (/publisher ambiguo nel catalogo/iu.test(cause)) return 'github_mapping_ambiguous';
  if (/nessun publisher osservato nel catalogo/iu.test(cause)) return 'github_mapping_unavailable';

  const http = cause.match(/\bHTTP\s+(\d{3})\b/u);
  if (/skipped — no API key/iu.test(cause)) return 'no_key';
  if (/skipped — exhausted/iu.test(cause)) return 'skipped_exhausted';
  if (/skipped — provider .* cooling down/iu.test(cause)) return 'cooldown';
  if (/skipped —/iu.test(cause)) return 'skipped';
  if (http) return `http_${http[1]}`;
  if (/timeout|ETIMEDOUT|abort/iu.test(cause)) return 'timeout';
  if (/ENOTFOUND|ECONNRESET|ECONN/iu.test(cause)) return 'net';
  if (/No API key|missing.+key/iu.test(cause)) return 'no_key';
  if (/all_models_failed|All models failed/iu.test(cause)) return 'all_failed';
  return 'error';
}

const GITHUB_FAULT_PRECEDENCE = [
  'github_catalog_brownout',
  'github_catalog_invalid',
  'github_catalog_unavailable',
  'github_mapping_ambiguous',
  'github_mapping_unavailable',
];

export function summarizeGitHubModelsVerification(results, bareRoster) {
  const roster = [...new Set((bareRoster || []).map(String))].sort();
  const rosterSet = new Set(roster);
  const observed = (results || []).filter((result) => rosterSet.has(result.model));
  const counts = observed.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});
  const fault = GITHUB_FAULT_PRECEDENCE.find((status) => counts[status]);
  const allPassed = roster.length > 0
    && observed.length === roster.length
    && observed.every((result) => result.status === 'pass');

  return {
    state: fault || (allPassed ? 'verified' : 'inconclusive'),
    rosterBareCount: roster.length,
    observedCount: observed.length,
    affectedModels: fault ? observed.filter((result) => result.status === fault).map((result) => result.model) : [],
    counts,
  };
}
