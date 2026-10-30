// scripts/lib/job-alert-funnel.mjs
//
// Il riepilogo di un invio di job alert, letto dall'alto in basso: da quanti
// alert si parte, perché ciascun gruppo esce dalla base, fino alle email che il
// provider ha accettato. Un solo modello alimenta il log e il Job Summary di
// GitHub Actions, così i due non possono divergere.
//
// L'unità è l'ALERT, non la persona: chi ha tre alert può ricevere fino a tre
// email nello stesso giorno. I destinatari unici sono riportati a parte.
//
// La contabilità è verificata, non presunta: ogni passaggio del funnel deve
// tornare su quello successivo. Se non torna, il riepilogo lo dichiara invece
// di mostrare un numero che sembra buono.

import { appendFileSync } from 'node:fs';

const OP = { START: '', MINUS: '−', EQUALS: '=', PLUS: '+', INFO: '' };

/** Migliaia col punto, come negli altri log italiani del repo. */
export function formatJobAlertCount(value) {
  if (value === Number.POSITIVE_INFINITY) return '∞';
  if (!Number.isFinite(value)) return '—';
  const digits = String(Math.trunc(Math.abs(value))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return value < 0 ? `−${digits}` : digits;
}

const num = (value) => (Number.isFinite(value) ? Math.trunc(value) : 0);

// Ordine delle righe = ordine con cui il sender decide. `hideWhenZero` nasconde
// i passaggi che nei run normali non esistono (la lista di test).
const ROWS = [
  { op: OP.START, key: 'archive', label: 'Alert attivi in archivio', reason: 'tutti gli alert con active = true' },
  { op: OP.MINUS, key: 'paused', label: 'in pausa', reason: "l'utente ha messo in pausa l'alert" },
  { op: OP.MINUS, key: 'companyImmediate', label: 'CompanyAlert immediati', reason: 'li invia send-company-alerts: nessun doppio invio' },
  { op: OP.MINUS, key: 'allowlist', label: 'fuori dalla lista di test', reason: 'TARGET_EMAIL: invio limitato a un destinatario', hideWhenZero: true },
  { op: OP.EQUALS, key: 'base', label: 'Base attiva' },
  { op: OP.MINUS, key: 'suppressionDeferred', label: 'lettura soppressioni fallita', reason: 'rinviati alla prossima esecuzione', hideWhenZero: true },
  { op: OP.MINUS, key: 'suppressed', label: 'soppressi (stop globale, bounce, reclamo, lista provider)', reason: 'nessun invio finché il consenso non torna' },
  { op: OP.MINUS, key: 'backfill', label: 'backfill senza base di iscrizione', reason: 'alert storico senza consenso verificabile' },
  { op: OP.MINUS, key: 'cooldown', label: 'cooldown newsletter 36 h', reason: 'rinviati: la newsletter è partita da poco' },
  { op: OP.MINUS, key: 'decayed', label: 'decaduti per cadenza', reason: "stato terminale: l'alert resta attivo e riparte se la persona torna" },
  { op: OP.MINUS, key: 'notDue', label: 'non in programma oggi', reason: 'cadenza: oggi non è il giorno di invio' },
  { op: OP.EQUALS, key: 'eligible', label: 'Eleggibili oggi' },
  { op: OP.MINUS, key: 'noCandidate', label: 'nessun annuncio nella finestra del destinatario', reason: "nessun annuncio nuovo dall'ultimo invio" },
  { op: OP.MINUS, key: 'emptyProfile', label: 'profilo senza segnali', reason: 'nessuna parola chiave, luogo o settore da confrontare' },
  { op: OP.MINUS, key: 'zeroMatch', label: 'nessun match', reason: 'nessun annuncio supera il matching' },
  { op: OP.MINUS, key: 'alreadySent', label: 'già inviati (deduplica)', reason: "gli annunci proposti erano già nelle email recenti" },
  { op: OP.MINUS, key: 'deadLinks', label: 'link pagina non più vivi', reason: 'annunci ritirati o non ancora pubblicati' },
  { op: OP.MINUS, key: 'quotaDeferred', label: 'rinviati per quota giornaliera', reason: 'limite dei provider raggiunto: restano per domani', hideWhenZero: true },
  { op: OP.EQUALS, key: 'planned', label: 'Email pianificate' },
  { op: OP.MINUS, key: 'failed', label: 'fallite (respinte dal provider)', reason: 'in coda per il retry' },
  { op: OP.EQUALS, key: 'sent', label: 'EMAIL INVIATE (accettate dal provider)' },
  { op: OP.INFO, key: 'ambiguous', label: 'di cui ambigue (accettate, esito non confermato)' },
  { op: OP.PLUS, key: 'retrySent', label: 'retry di invii dei giorni precedenti' },
  { op: OP.EQUALS, key: 'totalSent', label: 'TOTALE EMAIL INVIATE OGGI' },
];

/**
 * @param {Record<string, number>} input contatori raccolti da main() in
 *   send-job-alerts.mjs. Chiavi: vedi ROWS, più `sent`, `failed`, `ambiguous`,
 *   `retrySent`, `uniqueRecipients`.
 * @returns {{
 *   rows: Array<{op: string, label: string, reason: string, count: number}>,
 *   values: Record<string, number>,
 *   balanced: boolean,
 *   imbalance: number[],
 * }}
 */
// Ogni contatore parte da zero: un input incompleto (il ritorno anticipato senza
// alert passa solo quello che ha) non deve produrre NaN nella quadratura.
const COUNT_KEYS = [
  'archive', 'paused', 'companyImmediate', 'allowlist', 'base', 'suppressionDeferred',
  'suppressed', 'backfill', 'cooldown', 'decayed', 'notDue', 'eligible', 'noCandidate',
  'emptyProfile', 'zeroMatch', 'alreadySent', 'deadLinks', 'quotaDeferred', 'planned',
  'failed', 'sent', 'ambiguous', 'retrySent', 'uniqueRecipients',
];

export function buildJobAlertFunnel(input = {}) {
  const c = Object.fromEntries(COUNT_KEYS.map((key) => [key, num(input[key])]));
  const values = { ...c, totalSent: c.sent + c.retrySent };

  const rows = ROWS
    .filter((row) => !(row.hideWhenZero && !values[row.key]))
    .map((row) => ({ op: row.op, label: row.label, reason: row.reason ?? '', count: values[row.key] ?? 0 }));

  // Ogni differenza dovrebbe essere zero. Quattro passaggi:
  //   1. archivio − pausa − company − lista test = base
  //   2. base − soppressioni differite − soppressi − backfill − cooldown − decaduti − non in programma = eleggibili
  //   3. eleggibili − quota − nessun annuncio − profilo vuoto − no match − già inviati − link morti = pianificate
  //   4. pianificate − fallite = inviate
  const imbalance = [
    c.archive - c.paused - c.companyImmediate - c.allowlist - c.base,
    c.base - c.suppressionDeferred - c.suppressed - c.backfill - c.cooldown - c.decayed - c.notDue - c.eligible,
    c.eligible - c.quotaDeferred - c.noCandidate - c.emptyProfile - c.zeroMatch - c.alreadySent - c.deadLinks - c.planned,
    c.planned - c.failed - c.sent,
  ];

  return { rows, values, balanced: imbalance.every((d) => d === 0), imbalance };
}

function headlineFor(funnel, mode) {
  const v = funnel.values;
  if (mode === 'DRY RUN') {
    return `📬 DRY RUN — nessun invio: ${formatJobAlertCount(v.planned)} email sarebbero partite`;
  }
  return `📬 EMAIL INVIATE OGGI: ${formatJobAlertCount(v.totalSent)}`
    + ` — nuove ${formatJobAlertCount(v.sent)} · retry ${formatJobAlertCount(v.retrySent)}`
    + ` · destinatari unici ${formatJobAlertCount(v.uniqueRecipients)}`;
}

function imbalanceNote(funnel) {
  return `⚠️  Conteggio non quadrato (Δ ${funnel.imbalance.join(' / ')}): i numeri del funnel non tornano, non leggerli come definitivi.`;
}

/**
 * Le righe per il log. Una riga di titolo, una per passaggio, poi controllo
 * di quadratura e link audit. Nessuna tabella dei provider: quella la stampa
 * una volta sola il chiamante, a fine run.
 */
export function formatJobAlertFunnelLines(funnel, { date, mode, linkAudit = null } = {}) {
  const lines = [headlineFor(funnel, mode), `📋 Funnel job alert · ${date} · ${mode}`];
  for (const row of funnel.rows) {
    const prefix = row.op ? `${row.op} ` : '  ';
    lines.push(`   ${`${prefix}${row.label}`.padEnd(66)}${formatJobAlertCount(row.count).padStart(10)}`);
  }
  if (!funnel.balanced) lines.push(`   ${imbalanceNote(funnel)}`);
  if (linkAudit && linkAudit.batches > 0) {
    lines.push(`   🔗 Link audit: ${formatJobAlertCount(linkAudit.batches)} batch auditati · ${formatJobAlertCount(linkAudit.defects)} con difetti`);
  }
  return lines;
}

/** La riga di un singolo batch: quello che serve per seguire un invio lungo. */
export function formatJobAlertBatchLine(index, { sent = 0, failed = 0, ambiguous = 0, providerBreakdown = {} } = {}) {
  const providers = Object.entries(providerBreakdown)
    .map(([id, stats]) => `${id} ${formatJobAlertCount((stats.identified ?? 0) + (stats.ambiguous ?? 0))}`)
    .join(', ');
  return `   📦 Batch ${index} · inviate ${formatJobAlertCount(sent)} (ambigue ${formatJobAlertCount(ambiguous)})`
    + ` · fallite ${formatJobAlertCount(failed)}${providers ? ` · ${providers}` : ''}`;
}

/**
 * Il Job Summary di GitHub Actions: la prima cosa che si legge nella pagina del
 * run, senza aprire il log. Stesso modello del log, in tabella.
 */
export function formatJobAlertFunnelMarkdown(funnel, { date, mode, providers = [], linkAudit = null } = {}) {
  const out = [`## 📬 Funnel job alert · ${date} · ${mode}`, ''];
  out.push(`**${headlineFor(funnel, mode).replace(/^📬 /, '')}**`, '');
  out.push('| Passo | Alert | Motivo |', '| --- | ---: | --- |');
  for (const row of funnel.rows) {
    const bold = row.op === OP.EQUALS || row.op === OP.START;
    const label = bold ? `**${row.label}**` : row.label;
    const shown = row.op === OP.MINUS ? -row.count : row.count;
    const count = bold ? `**${formatJobAlertCount(shown)}**` : formatJobAlertCount(shown);
    const op = row.op === OP.PLUS ? '+ ' : row.op === OP.MINUS || row.op === OP.EQUALS ? `${row.op} ` : '';
    out.push(`| ${op}${label} | ${count} | ${row.reason} |`);
  }
  if (providers.length > 0) {
    out.push('', '### Provider email', '');
    out.push('| Provider | Configurato | Inviate in questo run | Sospese | Residuo oggi | Limite giornaliero |', '| --- | :---: | ---: | ---: | ---: | ---: |');
    for (const p of providers) {
      out.push(`| ${p.id} | ${p.configured ? '✅' : '❌'} | ${formatJobAlertCount(p.sent)} | ${formatJobAlertCount(p.benched)} | ${formatJobAlertCount(p.remaining)} | ${formatJobAlertCount(p.dailyLimit)} |`);
    }
  }
  out.push('');
  if (linkAudit && linkAudit.batches > 0) {
    out.push(`🔗 Link audit: ${formatJobAlertCount(linkAudit.batches)} batch auditati · ${formatJobAlertCount(linkAudit.defects)} con difetti`, '');
  }
  if (!funnel.balanced) out.push(imbalanceNote(funnel), '');
  return out.join('\n');
}

/**
 * Una riga per il log con i provider attivi: quante email ha accettato questo
 * run e quanta quota resta oggi. La tabella completa sta nel Job Summary, non nel
 * log, così il log non ripete la stessa tabella a ogni run.
 */
export function formatJobAlertProviderLine(providers = []) {
  const active = providers.filter((p) => p.configured);
  if (active.length === 0) return '';
  const parts = active.map((p) => {
    const quota = Number.isFinite(p.dailyLimit)
      ? ` (residuo ${formatJobAlertCount(p.remaining)} di ${formatJobAlertCount(p.dailyLimit)})`
      : ` (residuo ${formatJobAlertCount(p.remaining)})`;
    return `${p.id} ${formatJobAlertCount(p.sent)} inviate${quota}`;
  });
  return `   📮 Provider: ${parts.join(' · ')}`;
}

/** Accoda al Job Summary. Fuori da GitHub Actions non fa nulla. */
export function writeJobAlertStepSummary(markdown, { target = process.env.GITHUB_STEP_SUMMARY } = {}) {
  if (!target) return false;
  try {
    appendFileSync(target, `${markdown}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn(`   ⚠️  Job Summary non scritto: ${err?.message || err}`);
    return false;
  }
}
