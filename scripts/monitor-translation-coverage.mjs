#!/usr/bin/env node
/**
 * monitor-translation-coverage.mjs — allarme sulla quota `complete` della
 * history delle traduzioni (data/translation-stats-history.json).
 *
 * ─── Perché esiste ──────────────────────────────────────────────────────────
 * Fra il 24-09 e il 04-10 la quota `complete` è scesa dal 91% al 33% e la
 * coorte degli annunci di 24-48 ore dal 74% (11-09) al 12,6%, senza che niente
 * lo segnalasse: la mappa di convergenza (workspace issue 2) era ferma all'11-09
 * e la history veniva solo scritta. Ricontando lo stesso albero con i predicati
 * di prima e di dopo, un terzo del calo era MISURA (8f20e9e5ff5, 30-09, aveva
 * reso `isIncomplete()` più severo: −11,8 punti in un colpo) e due terzi DATO
 * (ondate di `needsRetranslation` dai crawler che translate-pending non smaltisce).
 *
 * ─── Regole ─────────────────────────────────────────────────────────────────
 * Serie: le righe `after` (lo stato dopo una run di traduzione, la stessa
 * serie su cui è scritta la condizione 1 della mappa), quota = complete/total.
 *
 * 1. MA3 (media mobile a 3 punti) dell'ultima riga più di 10 punti sotto il
 *    massimo MA3 degli ultimi 7 giorni → issue a titolo stabile.
 * 2. Coorte 24-48 h (`freshCohort` dell'ultima riga, contata da
 *    log-translation-stats.mjs) sotto il 50% complete → issue a titolo stabile.
 *    Sotto MIN_COHORT_JOBS annunci la coorte non decide: è rumore.
 *
 * Ogni allarme dice se il calo è «misura» o «dato» leggendo `predicateVersion`
 * (scripts/lib/incomplete-predicate-version.mjs) sulle righe che il confronto
 * attraversa: versioni diverse → «misura», tutte uguali → «dato». Una riga
 * senza `predicateVersion` (scritta prima del campo) rende il confronto
 * «predicato ignoto»: non si può escludere un cambio di misura, e dirlo «dato»
 * sarebbe falso.
 *
 * Non chiude le issue: il massimo a 7 giorni «dimentica» un crollo dopo una
 * settimana anche se la copertura resta bassa, quindi una misura pulita non
 * prova la guarigione. La chiusura resta sui criteri della mappa.
 *
 * Uso: node scripts/monitor-translation-coverage.mjs [--dry-run] [--history <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOW_DAYS = 7;
/** «oltre 10 punti»: un calo di esattamente 10 punti non scatta. */
export const MA3_DROP_THRESHOLD = 0.10;
export const COHORT_COMPLETE_FLOOR = 0.5;
export const MIN_COHORT_JOBS = 30;
export const KIND_DATA = 'dato';
export const KIND_MEASURE = 'misura';
export const KIND_UNKNOWN = 'predicato ignoto';

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_HISTORY = 'data/translation-stats-history.json';

export function ma3AlertTitle(kind) {
  return `[translation] quota complete MA3 -10pp sotto il max a 7 giorni (${kind}) — translation-stats-history`;
}

export function cohortAlertTitle(kind) {
  return `[translation] quota complete della coorte 24-48 h sotto il 50% (${kind}) — translation-stats-history`;
}

/** Le righe `after` misurabili, in ordine di tempo, con la loro quota. */
export function coverageSeries(history) {
  const rows = [];
  for (const row of Array.isArray(history) ? history : []) {
    if (!row || row.label !== 'after') continue;
    const t = Date.parse(row.timestamp);
    const total = Number(row.total);
    const complete = Number(row.complete);
    if (!Number.isFinite(t) || !Number.isFinite(total) || total <= 0 || !Number.isFinite(complete)) continue;
    rows.push({
      t,
      timestamp: row.timestamp,
      ratio: complete / total,
      predicateVersion: typeof row.predicateVersion === 'string' && row.predicateVersion
        ? row.predicateVersion
        : null,
      freshCohort: row.freshCohort ?? null,
    });
  }
  rows.sort((a, b) => a.t - b.t);
  for (let i = 0; i < rows.length; i++) {
    rows[i].ma3 = i >= 2 ? (rows[i].ratio + rows[i - 1].ratio + rows[i - 2].ratio) / 3 : null;
  }
  return rows;
}

/** «misura», «dato» o «predicato ignoto» per le righe che un confronto attraversa. */
export function classifyKind(rows) {
  if (rows.some((row) => !row.predicateVersion)) return KIND_UNKNOWN;
  return new Set(rows.map((row) => row.predicateVersion)).size > 1 ? KIND_MEASURE : KIND_DATA;
}

/**
 * Il verdetto sulla history. Pura.
 *
 * @returns {{
 *   points: number,
 *   ma3: { fired: boolean, current: number|null, max: number|null, maxAt: string|null,
 *          drop: number|null, kind: string|null },
 *   cohort: { fired: boolean, measured: boolean, total: number, complete: number,
 *             ratio: number|null, kind: string|null },
 * }}
 */
export function evaluateCoverage(history, {
  windowDays = WINDOW_DAYS,
  dropThreshold = MA3_DROP_THRESHOLD,
  cohortFloor = COHORT_COMPLETE_FLOOR,
  minCohort = MIN_COHORT_JOBS,
} = {}) {
  const series = coverageSeries(history);
  const verdict = {
    points: series.length,
    ma3: { fired: false, current: null, max: null, maxAt: null, drop: null, kind: null },
    cohort: { fired: false, measured: false, total: 0, complete: 0, ratio: null, kind: null },
  };
  if (series.length === 0) return verdict;
  const lastIndex = series.length - 1;
  const last = series[lastIndex];
  const windowStart = last.t - windowDays * DAY_MS;
  const firstInWindow = series.findIndex((row) => row.t >= windowStart);
  const windowRows = series.slice(firstInWindow);

  if (last.ma3 != null) {
    let maxIndex = -1;
    for (let i = firstInWindow; i <= lastIndex; i++) {
      if (series[i].ma3 == null) continue;
      if (maxIndex === -1 || series[i].ma3 > series[maxIndex].ma3) maxIndex = i;
    }
    const max = series[maxIndex].ma3;
    const drop = max - last.ma3;
    // Le righe che il confronto attraversa: dalla prima che entra nella MA3 del
    // massimo all'ultima. Un cambio di predicato lì dentro sposta la misura.
    const spanned = series.slice(Math.max(0, maxIndex - 2), lastIndex + 1);
    verdict.ma3 = {
      // Confronto in punti interi di decimillesimi: 0,90 − 0,80 in virgola
      // mobile vale 0,1000000000000001 e farebbe scattare un calo di 10 punti
      // esatti, che la regola («oltre 10 punti») esclude.
      fired: Math.round(drop * 1e4) > Math.round(dropThreshold * 1e4),
      current: last.ma3,
      max,
      maxAt: series[maxIndex].timestamp,
      drop,
      kind: classifyKind(spanned),
    };
  }

  const cohort = last.freshCohort;
  const total = Number(cohort?.total);
  const complete = Number(cohort?.complete);
  if (Number.isFinite(total) && Number.isFinite(complete) && total >= minCohort) {
    const ratio = complete / total;
    verdict.cohort = {
      fired: ratio < cohortFloor,
      measured: true,
      total,
      complete,
      ratio,
      kind: classifyKind(windowRows),
    };
  } else if (Number.isFinite(total) && Number.isFinite(complete)) {
    verdict.cohort = { ...verdict.cohort, total, complete, ratio: total > 0 ? complete / total : null };
  }
  return verdict;
}

function pct(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function kindExplanation(kind) {
  if (kind === KIND_MEASURE) {
    return '**Misura:** `predicateVersion` cambia fra le righe confrontate, cioè `isIncomplete()` o un suo modulo è cambiato. '
      + 'Prima di cercare una regressione dei dati, ricontare lo stesso albero col predicato di prima e di dopo '
      + '(la differenza è la parte di calo dovuta alla misura).';
  }
  if (kind === KIND_DATA) {
    return '**Dato:** tutte le righe confrontate hanno lo stesso `predicateVersion`: il predicato non è cambiato, '
      + 'il calo è nei dati (annunci nuovi non tradotti, ondate di `needsRetranslation`, cascata di traduzione ferma).';
  }
  return '**Predicato ignoto:** almeno una riga confrontata è stata scritta prima del campo `predicateVersion`, '
    + 'quindi un cambio di misura non si può escludere. Si risolve da solo quando la finestra contiene solo righe col campo.';
}

export function ma3AlertBody(verdict) {
  const m = verdict.ma3;
  return [
    `La media mobile a 3 punti della quota \`complete\` (righe \`after\` di \`${DEFAULT_HISTORY}\`) è **${pct(m.current)}**, `
      + `**${(m.drop * 100).toFixed(1)} punti** sotto il massimo dei 7 giorni (**${pct(m.max)}** al ${m.maxAt}).`,
    '',
    kindExplanation(m.kind),
    '',
    `Soglia: oltre ${(MA3_DROP_THRESHOLD * 100).toFixed(0)} punti. Comando: \`node scripts/monitor-translation-coverage.mjs --dry-run\`.`,
    'Contesto: mappa di convergenza delle traduzioni, workspace issue 2.',
  ].join('\n');
}

export function cohortAlertBody(verdict) {
  const c = verdict.cohort;
  return [
    `Gli annunci visti per la prima volta fra 24 e 48 ore fa sono complete al **${pct(c.ratio)}** `
      + `(${c.complete} su ${c.total}), sotto il ${(COHORT_COMPLETE_FLOOR * 100).toFixed(0)}%. `
      + 'La mappa chiede tutte e quattro le lingue entro 24 ore dal primo avvistamento.',
    '',
    kindExplanation(c.kind),
    '',
    'Comando: `node scripts/monitor-translation-coverage.mjs --dry-run`. Contesto: mappa di convergenza delle traduzioni, workspace issue 2.',
  ].join('\n');
}

export function formatVerdict(verdict) {
  const m = verdict.ma3;
  const c = verdict.cohort;
  return [
    `📈 translation coverage — ${verdict.points} righe after`,
    `   MA3 attuale ${pct(m.current)} · max 7g ${pct(m.max)} (${m.maxAt ?? 'n/a'}) · calo ${m.drop == null ? 'n/a' : `${(m.drop * 100).toFixed(1)} pp`}`
      + ` · ${m.fired ? `ALLARME (${m.kind})` : 'ok'}`,
    `   coorte 24-48 h ${c.measured ? `${c.complete}/${c.total} (${pct(c.ratio)})` : `non misurata (${c.total} job, minimo ${MIN_COHORT_JOBS})`}`
      + ` · ${c.fired ? `ALLARME (${c.kind})` : 'ok'}`,
  ];
}

function parseArgs(argv) {
  const args = { dryRun: false, history: DEFAULT_HISTORY };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--history') args.history = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const history = JSON.parse(fs.readFileSync(args.history, 'utf8'));
  if (!Array.isArray(history)) throw new Error(`${args.history}: not a JSON array`);
  const verdict = evaluateCoverage(history);
  const lines = formatVerdict(verdict);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }

  const alerts = [];
  if (verdict.ma3.fired) alerts.push({ title: ma3AlertTitle(verdict.ma3.kind), description: ma3AlertBody(verdict) });
  if (verdict.cohort.fired) alerts.push({ title: cohortAlertTitle(verdict.cohort.kind), description: cohortAlertBody(verdict) });
  if (alerts.length === 0 || args.dryRun) {
    for (const alert of alerts) console.log(`[dry-run] ${alert.title}`);
    return;
  }

  const { createGithubIssue } = await import('./lib/github-issue-creator.mjs');
  let failed = 0;
  for (const alert of alerts) {
    const result = await createGithubIssue({
      ...alert,
      priority: 2,
      labels: ['translation'],
      workflow: 'translation-coverage-monitor',
    });
    if (result?.persisted === false) failed++;
    console.log(`   issue: ${alert.title} → ${result?.url ?? result?.number ?? 'n/a'}`);
  }
  // Un allarme non consegnato non è una run verde: lo step di failure del
  // workflow lo riporta.
  if (failed > 0) process.exitCode = 1;
}

const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`monitor-translation-coverage: ${err.stack || err.message}`);
    process.exit(1);
  });
}
