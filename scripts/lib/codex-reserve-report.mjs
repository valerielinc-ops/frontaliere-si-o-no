/**
 * Riserva Codex Luna Max di translate-pending: report per fase e verdetto.
 *
 * Decisione del proprietario H7 (2026-10-05): «utilizza codex luna max per le
 * traduzioni quando falliscono le chiavi». Nella fase 2b (cascata dei lavori)
 * il tier Codex di `free-translate.mjs` sta nella posizione di default: entra
 * quando DeepL e Azure non possono piu' servire la run (chiavi rifiutate,
 * quota esaurita o non configurate) e prima di Google Cloud e dei tier
 * gratuiti, entro il tetto per processo di FREE_TRANSLATE_CODEX_MAX_CALLS /
 * FREE_TRANSLATE_CODEX_MAX_MS. Le fasi 2d/2e lo tengono in coda (`last`).
 *
 * Ogni fase che traduce scrive, all'uscita del processo, un JSON con i
 * contatori del tier (`getCodexTierStats`) in TRANSLATE_CODEX_RESERVE_DIR. Due
 * lettori:
 *   - `log-translation-stats.mjs after` somma le fasi nella riga della storia
 *     (`codexReserve`): quante traduzioni ha fatto la riserva e quante ne ha
 *     rifiutate, run per run;
 *   - l'allarme delle credenziali di `translation-provider-readiness.mjs`: un
 *     provider a chiave rifiutato con la riserva che regge e' «degradato,
 *     coperto da Codex», non un'azione del proprietario; il rosso resta quando
 *     anche Codex fallisce o non c'e'.
 *
 * Puro tranne `installCodexReserveReport` e `readCodexReserveReports`, che
 * toccano il filesystem. Senza TRANSLATE_CODEX_RESERVE_DIR non scrive niente.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CODEX_RESERVE_DIR_ENV = 'TRANSLATE_CODEX_RESERVE_DIR';

// Stop del tier che dicono «la lane non funziona», non «budget speso»: le
// stringhe sono quelle di `_stopCodex` nella sezione Codex di free-translate.mjs.
const FAILURE_STOP_RE = /fallimenti consecutivi|non caricabile/;

function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Il report di una fase dai contatori del tier e della cascata. */
export function buildCodexReserveReport(phase, codexStats, cascadeStats = {}, { now = new Date() } = {}) {
  const s = codexStats || {};
  return {
    version: 1,
    phase: String(phase),
    writtenAt: now.toISOString(),
    position: s.position === 'last' ? 'last' : 'after-premium',
    lanePresent: s.lanePresent === true,
    premiumDown: s.premiumDown === true,
    calls: asCount(s.calls),
    maxCalls: asCount(s.maxCalls),
    textsSent: asCount(s.textsSent),
    spentMs: asCount(s.spentMs),
    maxMs: asCount(s.maxMs),
    accepted: asCount(s.accepted),
    rejected: asCount(s.rejected),
    stopReason: s.stopReason ? String(s.stopReason) : null,
    cascadeCalls: asCount(cascadeStats.calls),
  };
}

/**
 * Esito della riserva in UNA fase:
 *   - `failed`: Codex ha ricevuto richieste e non ha tradotto niente, si e'
 *     fermato per fallimenti, oppure doveva entrare (DeepL e Azure giu', lane
 *     presente, testi passati dalla cascata) e non ha fatto nemmeno una
 *     chiamata;
 *   - `unavailable`: niente lane (broker assente o spento) o budget a zero;
 *   - `ready`: lane presente e nessun segno di guasto (ha tradotto, oppure non
 *     e' servita).
 */
export function classifyCodexReserveReport(report) {
  if (!report || !report.lanePresent || report.maxCalls === 0) return 'unavailable';
  if (report.stopReason && FAILURE_STOP_RE.test(report.stopReason)) return 'failed';
  if (report.calls > 0 && report.accepted === 0) return 'failed';
  if (report.position === 'after-premium' && report.premiumDown && report.calls === 0 && report.cascadeCalls > 0
    && !report.stopReason) return 'failed';
  return 'ready';
}

/**
 * Verdetto della riserva per la run, dai report di tutte le fasi.
 * `covered` solo con almeno una fase `ready` e nessuna `failed`.
 */
export function codexReserveCoverage(reports) {
  const list = Array.isArray(reports) ? reports.filter(Boolean) : [];
  if (list.length === 0) {
    return { verdict: 'unknown', detail: 'no Codex reserve report from this run' };
  }
  const states = list.map((report) => ({ report, state: classifyCodexReserveReport(report) }));
  const describe = ({ report, state }) => `${report.phase}: ${state}, ${report.accepted} translated / ${report.rejected} rejected in ${report.calls}/${report.maxCalls} calls${report.stopReason ? ` (stopped: ${report.stopReason})` : ''}`;
  const detail = states.map(describe).join('; ');
  if (states.some(({ state }) => state === 'failed')) return { verdict: 'codex-failed', detail };
  if (!states.some(({ state }) => state === 'ready')) return { verdict: 'codex-unavailable', detail };
  return { verdict: 'covered', detail };
}

/** Somma delle fasi per la storia di translate-pending; `null` senza report. */
export function summarizeCodexReserve(reports) {
  const list = Array.isArray(reports) ? reports.filter(Boolean) : [];
  if (list.length === 0) return null;
  const sum = (key) => list.reduce((total, report) => total + asCount(report[key]), 0);
  return {
    calls: sum('calls'),
    textsSent: sum('textsSent'),
    translated: sum('accepted'),
    rejected: sum('rejected'),
    spentMs: sum('spentMs'),
    verdict: codexReserveCoverage(list).verdict,
    byPhase: Object.fromEntries(list.map((report) => [report.phase, {
      position: report.position,
      calls: report.calls,
      maxCalls: report.maxCalls,
      translated: report.accepted,
      rejected: report.rejected,
      stopReason: report.stopReason,
    }])),
  };
}

export function readCodexReserveReports(dir = process.env[CODEX_RESERVE_DIR_ENV]) {
  if (!dir || !fs.existsSync(dir)) return [];
  const reports = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (report && report.version === 1 && typeof report.phase === 'string') reports.push(report);
    } catch {
      // Un report illeggibile vale «non misurato» per quella fase.
    }
  }
  return reports;
}

/**
 * Registra la scrittura del report della fase all'uscita del processo, su ogni
 * strada (fine normale, return anticipato, process.exit). Senza
 * TRANSLATE_CODEX_RESERVE_DIR non fa niente. `getStats` legge i contatori al
 * momento dell'uscita, non ora.
 */
export function installCodexReserveReport(phase, getStats, { dir = process.env[CODEX_RESERVE_DIR_ENV] } = {}) {
  if (!dir) return false;
  process.once('exit', () => {
    try {
      const { codex, cascade } = getStats();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${String(phase).replace(/[^a-z0-9-]+/gi, '-')}.json`);
      fs.writeFileSync(file, `${JSON.stringify(buildCodexReserveReport(phase, codex, cascade), null, 2)}\n`);
    } catch (error) {
      console.warn(`⚠️  Codex reserve report not written (${error instanceof Error ? error.message : String(error)})`);
    }
  });
  return true;
}
