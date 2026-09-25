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

// Salute della flotta: una "corsia" e' un provider con almeno un modello che
// risponde `pass` al ping. Il gate Mistral `-latest` (#892) e' l'unico che fa
// fallire lo smoke-test, quindi il crollo dell'intera flotta passava verde:
// 2026-09-24 (run 35995800618) 4 pass su 104, dopo che le run di produzione
// (newsletter 35976701363, snapshot lavori 35593110134) avevano gia' registrato
// decine di "All AI models failed". Corsie sane misurate negli artifact:
//   2026-09-01  7 (gemini, mistral, groq, openrouter, nvidia, omniroute, claude_cli)
//   2026-09-16  5 (gemini, cohere, nvidia, omniroute, claude_cli)
//   2026-09-22  2 (nvidia, omniroute — RC non caricato: no_key 100 su 105)
//   2026-09-24  2 (nvidia, omniroute — 402 su mistral/hf/cerebras/sambanova,
//                  catalogo GitHub Models non JSON, corsia Codex senza broker)
// Sotto 3 corsie la catena di produzione non ha piu' ridondanza fra provider
// indipendenti: e' il crollo, non una giornata con un provider giu'.
export const MIN_HEALTHY_PROVIDER_LANES = 3;

const RETIRED_STATUSES = new Set(['http_404', 'http_410']);

function lanesWithStatus(byProvider, status) {
  return Object.keys(byProvider).filter((lane) => byProvider[lane].statuses[status]).sort();
}

/**
 * @param {Array<{model: string, status: string}>} results
 * @param {(model: string) => string} providerOf
 */
export function summarizeAiFleetHealth(results, providerOf, { minHealthyLanes = MIN_HEALTHY_PROVIDER_LANES } = {}) {
  const rows = results || [];
  const byProvider = {};
  for (const row of rows) {
    const lane = providerOf(row.model);
    const entry = byProvider[lane] || (byProvider[lane] = { pass: 0, total: 0, statuses: {} });
    entry.total += 1;
    if (row.status === 'pass') entry.pass += 1;
    entry.statuses[row.status] = (entry.statuses[row.status] || 0) + 1;
  }
  const healthyLanes = Object.keys(byProvider).filter((lane) => byProvider[lane].pass > 0).sort();
  return {
    collapsed: healthyLanes.length < minHealthyLanes,
    healthyLanes,
    minHealthyLanes,
    passCount: rows.filter((row) => row.status === 'pass').length,
    modelCount: rows.length,
    // Cause esterne rese visibili, non trasformate in fix: credito/abbonamento
    // (402) e chiavi non arrivate dal Remote Config (no_key).
    billingLanes: lanesWithStatus(byProvider, 'http_402'),
    noKeyLanes: lanesWithStatus(byProvider, 'no_key'),
    retiredModels: rows.filter((row) => RETIRED_STATUSES.has(row.status)).map((row) => row.model),
    byProvider,
  };
}
