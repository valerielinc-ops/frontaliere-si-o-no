// scripts/lib/job-alert-metrics.mjs
//
// Telemetria per fase del sender dei job alert (perf-plan PR 1). Ogni run deve
// dire da sola quanto tempo e quante operazioni Firestore spende in ciascuna
// fase: senza questo metro non si può verificare nessuna ottimizzazione.
//
// L'implementazione generica vive in `sender-metrics.mjs` (perf-plan email
// senders, A1), condivisa con gli altri sender; qui restano le fasi della
// jobalert, l'API storica (`createJobAlertMetrics`, riga `JOBALERT_METRICS`) e
// la tabella del Job Summary con i contatori specifici della jobalert.
//
// Privacy: i contatori sono aggregati. Nessuna email, nessun id di documento.

import {
  createSenderMetrics,
  formatSenderMetricsLine,
  fmt,
  mib,
  senderPhaseTableLines,
} from './sender-metrics.mjs';

export const JOB_ALERT_PHASES = Object.freeze([
  'retry',
  'load_alerts',
  'profiles',
  'aux_profiles',
  'planning',
  'live_link',
  'send',
  'persist',
  'enrich',
  'health',
]);

/**
 * @param {{ now?: () => number, memory?: () => {heapUsed: number, rss: number} }} [options]
 */
export function createJobAlertMetrics({ now, memory } = {}) {
  const base = createSenderMetrics({
    tag: 'JOBALERT',
    phases: JOB_ALERT_PHASES,
    ...(now ? { now } : {}),
    ...(memory ? { memory } : {}),
  });
  return {
    ...base,
    snapshot({ date = null, mode = null, indexMode = null } = {}) {
      return base.snapshot({ date, mode, indexMode });
    },
  };
}

/** La riga per il log: una sola, parsabile con `grep JOBALERT_METRICS`. */
export function formatJobAlertMetricsLine(snapshot) {
  return formatSenderMetricsLine('JOBALERT', snapshot);
}

/** Stessa informazione, per il Job Summary di GitHub Actions. */
export function formatJobAlertMetricsMarkdown(snapshot) {
  const out = senderPhaseTableLines(snapshot);
  const c = snapshot.counters || {};
  out.push('| Contatore | Valore |', '| --- | ---: |');
  const sendMs = snapshot.phases?.send?.ms || 0;
  const perSecond = sendMs > 0 && c.emailsSent > 0 ? (c.emailsSent / (sendMs / 1000)).toFixed(2) : '—';
  const rows = [
    ['modalità indice candidati', snapshot.indexMode || '—'],
    ['alert eleggibili', fmt(c.alertsEligible)],
    ['email pianificate / inviate', `${fmt(c.emailsPlanned)} / ${fmt(c.emailsSent)}`],
    ['email al secondo nella fase send', perSecond],
    ['live-link: sorgente', c.liveLinkSource || '—'],
    ['righe in finestra (cursorCandidateCount)', fmt(c.windowRows)],
    ['righe passate allo scorer', fmt(c.scoredRows)],
    ['alert pianificati con indice', fmt(c.indexedAlerts)],
    ['alert campionati (verifica legacy)', fmt(c.indexSampled)],
    ['indexMismatch', fmt(c.indexMismatch)],
    ['richieste HTTP live-link', fmt(c.liveLinkHttpRequests)],
    ['live-link risolti dal manifest', fmt(c.liveLinkManifestResolved)],
    ['alert in fail-open live-link', fmt(c.liveLinkFailOpen)],
    ['cadenceIndexViolations', fmt(c.cadenceIndexViolations)],
    ['heap di picco', mib(snapshot.heapPeakBytes)],
    ['RSS di picco', mib(snapshot.rssPeakBytes)],
  ];
  for (const [label, value] of rows) out.push(`| ${label} | ${value} |`);
  out.push('');
  // Tempo di planning per strategia (ms totali, al netto del vocabolario) e
  // costruzione una tantum di indice e vocabolari: dove va il tempo residuo.
  const strategies = Object.keys(c).filter((key) => key.startsWith('planMs.')).sort((a, b) => c[b] - c[a]);
  if (strategies.length > 0) {
    out.push('| Strategia di planning | Alert | ms totali | ms per alert |', '| --- | ---: | ---: | ---: |');
    for (const key of strategies) {
      const name = key.slice('planMs.'.length);
      const alerts = c[`planAlerts.${name}`] || 0;
      out.push(`| ${name} | ${fmt(alerts)} | ${fmt(c[key])} | ${alerts > 0 ? fmt(c[key] / alerts) : '—'} |`);
    }
    out.push('');
  }
  const vocabularies = Object.keys(c).filter((key) => key.startsWith('vocabularyBuildMs.')).sort();
  if (Number.isFinite(c.indexBuildMs) || vocabularies.length > 0) {
    out.push('| Costruzione una tantum | Valore |', '| --- | ---: |');
    if (Number.isFinite(c.indexBuildMs)) out.push(`| indice dei candidati | ${fmt(c.indexBuildMs)} ms |`);
    for (const key of vocabularies) {
      const locale = key.slice('vocabularyBuildMs.'.length);
      out.push(`| vocabolario ricerca [${locale}] | ${fmt(c[key])} ms, ${fmt(c[`vocabularyWords.${locale}`])} parole, ${mib(c[`vocabularyBytes.${locale}`])} |`);
    }
    out.push('');
  }
  return out.join('\n');
}
