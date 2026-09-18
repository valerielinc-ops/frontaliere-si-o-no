#!/usr/bin/env node
/**
 * scan-unreported-failures.mjs — la rete di sicurezza GLOBALE sui workflow rossi.
 *
 * ─── Il buco che tappa ───────────────────────────────────────────────────
 *
 * Su questo repo l'apertura di una issue di fallimento è cablata DENTRO i
 * workflow, con uno step `if: failure()` che chiama `github-issue-creator`.
 * Misurato il 2026-09-18 su `origin/main`: **125 file di workflow su 283** hanno
 * quello step, **158 no**. Un workflow senza step non apre niente, e nessuno se
 * ne accorge: `audit-parser-quality` è rimasto rosso 438 h (98 run consecutive),
 * `post-merge-followup` 161 h, `translation-schedule-v2-shadow` non è MAI stato
 * verde in 19 run.
 *
 * Ci sono due classi che nessuno step interno può coprire, nemmeno cablandolo
 * in tutti e 283 i file:
 *
 *   A. STARTUP FAILURE con ZERO JOB. La run esce `conclusion: failure` senza
 *      eseguire un solo job, quindi lo step reporter non parte per definizione.
 *      Caso reale: run 35343423193 di `sync-pharmacy-duties`
 *      (2026-09-18T12:12:13Z, `event: schedule`) — `jobs.total_count: 0`,
 *      nessun check-run, nessuna annotation. Invisibile a `if: failure()`.
 *   B. WORKFLOW DORMIENTE. Un workflow che non gira più non FALLISCE: non
 *      produce alcuna run, quindi non c'è nessun `failure()` da intercettare e
 *      nemmeno un `workflow_run` da cui partire. Lo copre `--dormant` qui sotto.
 *
 * Per questo la scansione è CENTRALE e non uno step per workflow: è la stessa
 * conclusione a cui il repo è già arrivato per il lato che CHIUDE — vedi
 * `close-recovered-failure-issues.yml`, «without wiring a per-workflow step into
 * ~300 YAML files» — e questa è la metà simmetrica, quella che APRE.
 *
 * ─── Perché non è una copia di scan-failed-runs.mjs del corpus ───────────
 *
 * Il corpus ha già una scansione centrale (`scripts/ci/scan-failed-runs.mjs`),
 * registrata `corpus-only` in `loop-sync-manifest.json` con la motivazione che è
 * «un candidato a risalire» al sito. Non la si copia perché metà di quel file è
 * dominio del corpus (`buildLostArticleReport`, la non-consegna di `issue-fix`,
 * le soglie misurate sulla generazione articoli) e perché QUI la scala è
 * diversa. Quel che serve davvero è già sul sito e si riusa invece di
 * riscriverlo:
 *   - `createGithubIssue` (scripts/lib/github-issue-creator.mjs) — dedup sul
 *     prefisso di 60 char, commento di ricorrenza, reopen guardato.
 *   - `TITLE_RE` (scripts/ci/close-recovered-failure-issues.mjs) — la famiglia
 *     di titoli che il chiuditore centrale sa richiudere.
 * Nessuno dei due file viene modificato: sono `mode: identical` nel manifest, e
 * toccarli qui creerebbe `site-ahead` per un vantaggio nullo.
 *
 * ─── `cancelled` NON suona l'allarme ─────────────────────────────────────
 *
 * La query chiede `status=failure` e basta: `cancelled` non entra MAI in questo
 * scanner, by construction — non per un filtro che si può dimenticare. È
 * deliberato e non è un buco: `timeout-minutes` marca il job `cancelled`, e quel
 * caso ha già il suo proprietario in `scan-job-timeouts.mjs`, che lo prova con
 * l'annotation «exceeded … maximum execution time» invece di trattare ogni
 * `cancelled` come un guasto. Nella finestra 48 h misurata qui c'erano 1.083 run
 * `cancelled`: un `|| cancelled()` le avrebbe trasformate in allarmi, e la
 * supersessione di un concurrency group è la causa più comune di tutte.
 *
 * ─── La dedup, e la prova che regge a questa scala ───────────────────────
 *
 * Misura del 2026-09-18, finestra di 48 h su questo repo:
 *   - 14.969 run totali, di cui 9.824 verdi;
 *   - 930 `conclusion: failure`, ma 610 sono `pull_request` (+38 fra
 *     `pull_request_review` e `pull_request_target`): quelle le governa il ciclo
 *     di review della PR, non questo scanner;
 *   - restano 281 run non-PR, che ricadono su **32 file di workflow distinti**;
 *   - il filtro «`main` oppure `schedule`» (sotto) ne tiene 226 su 31 workflow e
 *     scarta 55 run di rumore su branch di feature (52 delle quali di
 *     `tests.yml`, che è un gate di PR e su un branch altrui non è un guasto di
 *     questo repo).
 *
 * Quindi il caso peggiore è ~226 run rosse → **al massimo 31 thread**, uno per
 * workflow, e in regime stazionario molti meno: `createGithubIssue` trova la
 * issue aperta dal prefisso del titolo e COMMENTA la ricorrenza invece di
 * aprirne un'altra. Senza dedup sarebbero 226 issue in due giorni, cioè la
 * valanga che renderebbe la coda di triage inutilizzabile.
 *
 * ─── Il campo `name` della REST API è una trappola ───────────────────────
 *
 * `GET /actions/runs` restituisce in `.name` il nome della RUN (quello che
 * `run-name:` calcola), NON il `name:` del workflow. Su questo repo
 * `code-checks-review.yml` usa un `run-name` templato e produce nomi come
 * `Code checks and review · fix/issue-8380 · workflow_dispatch`: raggruppando per
 * `.name` un singolo workflow si sbriciola in DECINE di pseudo-workflow, uno per
 * branch — la dedup salterebbe e ogni branch aprirebbe la sua issue. Misurato:
 * 31 dei 61 «workflow» ottenuti raggruppando per `.name` erano quello stesso
 * file. Qui si raggruppa per `workflow_id`/`.path` e il `name:` vero si risolve
 * da `GET /actions/workflows`, che è anche l'UNICO nome che
 * `close-recovered-failure-issues.mjs` sa ri-risolvere con `gh run list -w`.
 *
 * ─── Il bucket di rate limit di Actions è separato da `core` ─────────────
 *
 * `gh api rate_limit` può mostrare quota mentre una chiamata Actions rende 403.
 * Costo per passata, dimensionato di conseguenza:
 *   - modalità failure (oraria): ~3 chiamate per l'elenco workflow + ~3 per le
 *     run rosse della finestra + 1 `gh issue list` + 1 lettura job per ogni
 *     workflow effettivamente segnalato (≤ MAX_ISSUES).
 *   - modalità `--dormant` (GIORNALIERA, non oraria, proprio per questo): 1
 *     chiamata per workflow schedulato, oggi 180. Una al giorno è il prezzo che
 *     rende il controllo possibile; orario costerebbe 4.320 chiamate/giorno sul
 *     bucket più stretto.
 *
 * ─── Uso ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/ci/scan-unreported-failures.mjs [--dry-run]
 *   node scripts/ci/scan-unreported-failures.mjs --dormant [--dry-run]
 *
 * Env: GH_REPO/GITHUB_REPOSITORY, GH_TOKEN, IGNORE_WORKFLOWS (nomi separati da
 * virgola), UNREPORTED_SCAN_LOOKBACK_MINUTES, UNREPORTED_SCAN_MAX_ISSUES,
 * DORMANT_GRACE_MULTIPLIER, ENABLE_FAILURE_REPORT=false per disattivare.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { TITLE_RE } from './close-recovered-failure-issues.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const DRY_RUN = process.argv.includes('--dry-run');
const DORMANT_MODE = process.argv.includes('--dormant');
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

/**
 * Finestra di scansione. Default 75 min su un cron orario: la sovrapposizione è
 * voluta, copre il jitter del cron e una passata saltata senza lasciare un buco.
 */
const LOOKBACK_MINUTES = intFromEnv('UNREPORTED_SCAN_LOOKBACK_MINUTES', 75);

/**
 * Orizzonte della query `created=>=`, che NON è il filtro.
 *
 * Il filtro vero è `updated_at >= since`; la query può discriminare solo per
 * `created`. Una run rimasta in coda a lungo e fallita DENTRO la finestra ha un
 * `created_at` molto più vecchio, e con un orizzonte stretto non uscirebbe
 * nemmeno dalla query: nessuna issue, nessun warning. Su questo repo la coda di
 * concorrenza arriva a ~1 h di attesa reale, quindi l'orizzonte tiene 25 h di
 * margine sopra la finestra.
 */
const RUN_QUERY_HORIZON_MINUTES = LOOKBACK_MINUTES + 25 * 60;

/**
 * Cap per passata. Non è un limite di quota ma un freno anti-valanga: se una
 * modifica di piattaforma rendesse rossi 200 workflow insieme, meglio 20 issue e
 * un warning forte che 200 issue che seppelliscono la coda. Il resto rientra
 * alla passata dopo, e il troncamento si DICE (un cap silenzioso si legge come
 * «tutto coperto»).
 */
const MAX_ISSUES = intFromEnv('UNREPORTED_SCAN_MAX_ISSUES', 20);

/** Cap di sicurezza sul listing delle issue aperte, con warning se raggiunto. */
const OPEN_ISSUE_LISTING_CAP = 1000;

/**
 * Quante cadenze perse prima di chiamare dormiente un workflow schedulato.
 *
 * 3 e non 1: il cron di GitHub Actions non è un orologio — salta le esecuzioni
 * sotto carico e le ritarda di decine di minuti. A 1 ogni ritardo diventerebbe
 * un falso allarme. Misurato il 2026-09-18: i 55 workflow con ultima run oltre
 * 48 h erano TUTTI settimanali e legittimi, e a moltiplicatore 3 un settimanale
 * suona solo dopo 21 giorni — cioè dopo tre cadenze davvero mancate.
 */
const DORMANT_GRACE_MULTIPLIER = intFromEnv('DORMANT_GRACE_MULTIPLIER', 3);

const IGNORE = new Set(
  String(process.env.IGNORE_WORKFLOWS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function repoFlag() {
  return REPO ? ['--repo', REPO] : [];
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const msg = String(e?.message || '').slice(0, 200);
    if (allowFailure) {
      console.warn(`[scan-unreported-failures] gh ${args.slice(0, 3).join(' ')} fallito: ${msg}`);
      return null;
    }
    throw e;
  }
}

/**
 * `gh api --paginate` concatena le pagine come array JSON separati quando si usa
 * `--jq`. Si chiede il campo già estratto e si splicano le pagine.
 */
function ghApiList(apiPath, jqExpr, { allowFailure = true } = {}) {
  const out = gh(['api', apiPath, '--paginate', '--jq', jqExpr], { allowFailure });
  if (out === null || out === '') return [];
  const rows = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // Una riga illeggibile è un dato perso, non un motivo per perdere le altre.
      console.warn(`[scan-unreported-failures] riga JSON illeggibile ignorata: ${t.slice(0, 80)}`);
    }
  }
  return rows;
}

/* ── filtro delle run ────────────────────────────────────────────────── */

/**
 * Va segnalata, o è rumore che ha già un altro proprietario?
 *
 * - `pull_request*`: il rosso di una PR è governato dal ciclo di review della
 *   PR, che lo mette davanti agli occhi di chi la sta seguendo. Segnalarlo qui
 *   aprirebbe una issue per ogni PR rossa: 610 run in 48 h su questo repo.
 * - `main` oppure `schedule`: è la condizione che separa un guasto DI QUESTO
 *   REPO dal rosso di un branch di lavoro altrui. `tests.yml` è il caso che lo
 *   prova — 59 run rosse non-PR in 48 h, di cui 52 su branch di feature (il
 *   fleet di agenti che lavora) e 7 su `main`. Le 7 su `main` sono guasti veri e
 *   passano; le 52 no. Un allowlist di nomi «workflow gate di PR» darebbe lo
 *   stesso esito oggi e sarebbe da manutenere a ogni workflow nuovo.
 * - `cancelled` non compare in questa funzione perché non arriva mai fin qui:
 *   la query chiede `status=failure`. Vedi l'intestazione.
 */
export function isReportableRun(run, { since, ignore = IGNORE } = {}) {
  if (!run || run.conclusion !== 'failure') return false;
  if (String(run.event || '').startsWith('pull_request')) return false;
  if (run.head_branch !== 'main' && run.event !== 'schedule') return false;
  if (ignore.has(run.workflow_name)) return false;
  const stamp = run.updated_at || run.created_at;
  if (since && !(stamp && Date.parse(stamp) >= Date.parse(since))) return false;
  return true;
}

/* ── cadenza dichiarata da un cron ───────────────────────────────────── */

const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * I valori ammessi di UN campo cron, o `null` se il campo non è interpretabile.
 *
 * `null` è load-bearing: un campo che non si sa leggere NON deve diventare «gira
 * ogni minuto» né «non gira mai». Chi chiama salta il workflow e lo dice, invece
 * di aprire una issue su una cadenza inventata.
 */
export function cronFieldValues(field, min, max, names = null) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const m = part.match(/^(\*|\d+|[a-z]{3})(?:-(\d+|[a-z]{3}))?(?:\/(\d+))?$/i);
    if (!m) return null;
    const [, rawFrom, rawTo, rawStep] = m;
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step < 1) return null;
    const resolve = (tok) => {
      if (tok === undefined) return undefined;
      if (/^\d+$/.test(tok)) return Number(tok);
      const n = names?.[tok.toLowerCase()];
      return n === undefined ? null : n;
    };
    let from;
    let to;
    if (rawFrom === '*') {
      from = min;
      to = max;
    } else {
      from = resolve(rawFrom);
      if (from === null || from === undefined) return null;
      to = rawTo === undefined ? (rawStep === undefined ? from : max) : resolve(rawTo);
      if (to === null || to === undefined) return null;
    }
    if (from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/**
 * Intervallo massimo, in minuti, fra due esecuzioni consecutive dell'unione dei
 * cron passati. `null` quando nessun cron è interpretabile.
 *
 * ponytail: forza bruta su una finestra di 70 giorni invece di un motore cron
 * (nessuna dipendenza cron installata, e aggiungerne una per questo sarebbe
 * sproporzionato). 70 giorni bastano a misurare anche un mensile; l'ora viene
 * saltata in blocco quando non è ammessa, quindi il costo reale è di poche
 * decine di migliaia di iterazioni per workflow. Se un giorno servisse la
 * precisione su cadenze più rare di un mese, qui va un vero parser.
 */
export function maxCronGapMinutes(crons, { windowDays = 70 } = {}) {
  const parsed = [];
  for (const expr of crons) {
    const f = String(expr).trim().split(/\s+/);
    if (f.length !== 5) continue;
    const minute = cronFieldValues(f[0], 0, 59);
    const hour = cronFieldValues(f[1], 0, 23);
    const dom = cronFieldValues(f[2], 1, 31);
    const month = cronFieldValues(f[3], 1, 12, MONTH_NAMES);
    // `7` è domenica come `0`: si normalizza dopo aver accettato 0-7.
    const dowRaw = cronFieldValues(f[4], 0, 7, DOW_NAMES);
    if (!minute || !hour || !dom || !month || !dowRaw) continue;
    const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
    parsed.push({
      minute,
      hour,
      dom,
      month,
      dow,
      // Semantica cron standard: se ENTRAMBI dom e dow sono ristretti, scatta
      // quando matcha l'UNO O L'ALTRO, non l'intersezione.
      domRestricted: f[2] !== '*',
      dowRestricted: f[4] !== '*',
    });
  }
  if (!parsed.length) return null;

  const fires = [];
  const start = Date.UTC(2026, 0, 1);
  for (let day = 0; day < windowDays; day += 1) {
    const dayStart = start + day * 86_400_000;
    const d = new Date(dayStart);
    const month = d.getUTCMonth() + 1;
    const dom = d.getUTCDate();
    const dow = d.getUTCDay();
    const active = parsed.filter((p) => {
      if (!p.month.has(month)) return false;
      if (p.domRestricted && p.dowRestricted) return p.dom.has(dom) || p.dow.has(dow);
      if (p.domRestricted) return p.dom.has(dom);
      if (p.dowRestricted) return p.dow.has(dow);
      return true;
    });
    if (!active.length) continue;
    for (let h = 0; h < 24; h += 1) {
      const hourActive = active.filter((p) => p.hour.has(h));
      if (!hourActive.length) continue;
      for (let m = 0; m < 60; m += 1) {
        if (hourActive.some((p) => p.minute.has(m))) {
          fires.push(day * 1440 + h * 60 + m);
        }
      }
    }
  }
  if (fires.length < 2) return null;
  let gap = 0;
  for (let i = 1; i < fires.length; i += 1) gap = Math.max(gap, fires[i] - fires[i - 1]);
  return gap || null;
}

/** I `cron:` e il `name:` dichiarati da un file di workflow, letti testualmente. */
export function workflowScheduleFromSource(source) {
  const text = String(source);
  const head = text.split(/^jobs:/m)[0];
  const nameMatch = text.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].replace(/\s+#.*$/, '').trim() : null;
  const crons = [...head.matchAll(/^\s*-\s*cron:\s*['"]?([^'"#\n]+)['"]?/gm)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  return { name, crons };
}

/* ── chi ha già una issue aperta ─────────────────────────────────────── */

/**
 * I nomi di workflow che hanno GIÀ una issue di fallimento aperta.
 *
 * Serve a non aprire un SECONDO thread per un workflow che si segnala da sé: 125
 * file su 283 hanno il proprio step `if: failure()` e usano il titolo
 * `Workflow Failure: <nome>`, che ha un prefisso di dedup diverso da quello che
 * scrive questo scanner. Senza questo controllo lo stesso guasto avrebbe due
 * issue, una per meccanismo.
 *
 * Una lettura fallita rende `null`, non un Set vuoto: `[]` si leggerebbe come
 * «nessuna issue aperta → apri tutto», cioè un duplicato per ogni workflow rosso
 * proprio quando l'API è in difficoltà. Chi chiama si ferma.
 */
export function openFailureIssueWorkflows() {
  const raw = gh(
    ['issue', 'list', '--state', 'open', '--limit', String(OPEN_ISSUE_LISTING_CAP),
      '--json', 'number,title', ...repoFlag()],
    { allowFailure: true },
  );
  if (raw === null) return null;
  let issues;
  try {
    issues = JSON.parse(raw || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(issues)) return null;
  if (issues.length >= OPEN_ISSUE_LISTING_CAP) {
    console.warn(
      `::warning::[scan-unreported-failures] cap di ${OPEN_ISSUE_LISTING_CAP} raggiunto sul listing `
        + 'delle issue aperte: la canonica di qualche workflow può essere fuori elenco.',
    );
  }
  const byWorkflow = new Map();
  for (const issue of issues) {
    const m = TITLE_RE.exec(String(issue?.title || ''));
    if (m) byWorkflow.set(m[1].trim(), issue.number);
  }
  return byWorkflow;
}

/* ── modalità failure ───────────────────────────────────────────────── */

/** `workflow_id` → `{ name, path, state }`, il solo nome che il chiuditore sa risolvere. */
function registeredWorkflows() {
  const rows = ghApiList(
    `repos/${REPO || '{owner}/{repo}'}/actions/workflows?per_page=100`,
    '.workflows[] | {id, name, path, state, created_at}',
  );
  const byId = new Map();
  for (const w of rows) if (w?.id) byId.set(String(w.id), w);
  return byId;
}

export function runBody({ run, workflowName, jobs }) {
  const total = jobs?.total_count;
  const failed = (jobs?.jobs || []).filter((j) => j?.conclusion === 'failure');
  const lines = [];
  lines.push(`Il workflow \`${workflowName}\` è uscito \`failure\` e **nessuno step interno l'ha segnalato**.`);
  lines.push('');
  lines.push(`- run: ${run.html_url}`);
  lines.push(`- event: \`${run.event}\` · branch: \`${run.head_branch}\``);
  lines.push(`- iniziata: ${run.created_at} · aggiornata: ${run.updated_at}`);
  lines.push('');
  if (total === 0) {
    lines.push('**Startup failure: zero job.** La run è `failure` con `jobs.total_count: 0` —');
    lines.push('non ha eseguito nemmeno un job, quindi nessuno step `if: failure()` poteva');
    lines.push('partire e nessun check-run esiste. Le cause tipiche sono un YAML non valido');
    lines.push('sul branch di default, una `${{ }}` che non si valuta, un `uses:` che non si');
    lines.push('risolve o un secret/permission mancante in testa al workflow.');
  } else if (failed.length) {
    lines.push('Job falliti:');
    for (const j of failed.slice(0, 10)) {
      const step = (j.steps || []).find((s) => s?.conclusion === 'failure');
      lines.push(`- \`${j.name}\`${step ? ` — step: \`${step.name}\`` : ''}\n  ${j.html_url}`);
    }
  } else {
    lines.push('_(l\'API non riporta job falliti per questa run: fallimento a livello di run.)_');
  }
  lines.push('');
  lines.push('---');
  lines.push('Aperta da `scripts/ci/scan-unreported-failures.mjs` (scansione centrale).');
  lines.push('Si richiude da sé quando la run successiva di questo workflow è verde');
  lines.push('(`close-recovered-failure-issues.yml`).');
  return lines.join('\n');
}

async function scanFailures() {
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60_000).toISOString();
  const horizon = new Date(Date.now() - RUN_QUERY_HORIZON_MINUTES * 60_000).toISOString();

  const openIssues = openFailureIssueWorkflows();
  if (openIssues === null) {
    // Fail-CLOSED: senza sapere che cosa è già aperto, aprire significa
    // duplicare. Un rosso vero rientra alla passata dopo; un duplicato no.
    console.error('::error::[scan-unreported-failures] listing delle issue aperte illeggibile — nessuna issue aperta in questa passata.');
    return 1;
  }

  const workflows = registeredWorkflows();
  const runs = ghApiList(
    `repos/${REPO || '{owner}/{repo}'}/actions/runs`
      + `?created=%3E%3D${encodeURIComponent(horizon)}&status=failure&per_page=100`,
    '.workflow_runs[] | {id, workflow_id, event, head_branch, conclusion,'
      + ' created_at, updated_at, html_url, path}',
  );

  const reportable = [];
  for (const run of runs) {
    const wf = workflows.get(String(run.workflow_id));
    const workflowName = wf?.name || null;
    if (!isReportableRun({ ...run, workflow_name: workflowName }, { since })) continue;
    if (!workflowName) {
      console.warn(`::warning::[scan-unreported-failures] run ${run.id} senza workflow risolvibile (${run.path}) — saltata.`);
      continue;
    }
    reportable.push({ ...run, workflowName });
  }

  // Un solo thread per workflow: si tiene la run più recente, le altre sono la
  // stessa condizione che ricorre.
  const byWorkflow = new Map();
  for (const run of reportable) {
    const prev = byWorkflow.get(run.workflowName);
    if (!prev || Date.parse(run.updated_at) > Date.parse(prev.updated_at)) {
      byWorkflow.set(run.workflowName, run);
    }
  }

  console.log(
    `[scan-unreported-failures] ${runs.length} run rosse nell'orizzonte → `
      + `${reportable.length} segnalabili nella finestra di ${LOOKBACK_MINUTES} min → `
      + `${byWorkflow.size} workflow distinti${DRY_RUN ? ' (dry-run)' : ''}.`,
  );

  let opened = 0;
  let skipped = 0;
  const pending = [...byWorkflow.entries()];
  for (let i = 0; i < pending.length; i += 1) {
    const [workflowName, run] = pending[i];
    const already = openIssues.get(workflowName);
    if (already) {
      skipped += 1;
      console.log(`[scan-unreported-failures] ${workflowName}: issue #${already} già aperta → nessun secondo thread.`);
      continue;
    }
    if (opened >= MAX_ISSUES) {
      const rest = pending.length - i;
      console.warn(
        `::warning::[scan-unreported-failures] cap di ${MAX_ISSUES} issue raggiunto — `
          + `${rest} workflow rossi NON segnalati in questa passata: `
          + `${pending.slice(i).map(([n]) => n).join(', ')}. Rientrano alla prossima.`,
      );
      break;
    }

    const jobs = DRY_RUN
      ? null
      : JSON.parse(gh(['api', `repos/${REPO || '{owner}/{repo}'}/actions/runs/${run.id}/jobs?per_page=100`], { allowFailure: true }) || 'null');
    const title = `CI Failure: ${workflowName}`;
    const description = runBody({ run, workflowName, jobs });

    if (DRY_RUN) {
      console.log(`[scan-unreported-failures] (dry-run) aprirebbe "${title}" per ${run.html_url}`);
      opened += 1;
      continue;
    }

    const issue = await createGithubIssue({
      title,
      description,
      priority: 2,
      labels: ['automation', 'ci-failure'],
      workflow: workflowName,
    });
    if (!issue?.number || issue.persisted !== true) {
      console.error(`::error::[scan-unreported-failures] apertura NON confermata per ${workflowName} (${run.html_url}).`);
      return 1;
    }
    console.log(`[scan-unreported-failures] ${workflowName} → #${issue.number}`);
    opened += 1;
  }

  console.log(`[scan-unreported-failures] fatto — ${opened} aperte, ${skipped} già coperte (dry-run=${DRY_RUN}).`);
  return 0;
}

/* ── modalità dormienti ─────────────────────────────────────────────── */

export function dormantBody({ workflowName, crons, gapMinutes, lastRunAt, thresholdHours }) {
  const lines = [];
  lines.push(`Il workflow schedulato \`${workflowName}\` **ha smesso di girare**.`);
  lines.push('');
  lines.push(`- cron dichiarato: ${crons.map((c) => `\`${c}\``).join(', ')}`);
  lines.push(`- cadenza attesa: una run ogni ${Math.round(gapMinutes / 60)} h al massimo`);
  lines.push(`- ultima run: ${lastRunAt || '**nessuna run registrata**'}`);
  lines.push(`- soglia di allarme: ${Math.round(thresholdHours)} h senza run (${DORMANT_GRACE_MULTIPLIER} cadenze mancate)`);
  lines.push('');
  lines.push('Un workflow dormiente non FALLISCE: non produce alcuna run, quindi nessuno');
  lines.push('step `if: failure()` e nessun trigger `workflow_run` può accorgersene. È il');
  lines.push('motivo per cui questo controllo esiste separato dalla scansione dei rossi.');
  lines.push('');
  lines.push('Cause tipiche: il cron è stato rimosso o commentato; GitHub ha disabilitato');
  lines.push('lo schedule per inattività del repository; il workflow è stato disattivato a');
  lines.push('mano; un YAML non valido sul branch di default impedisce QUALSIASI trigger');
  lines.push('(in quel caso il file è rotto, non lo schedule).');
  lines.push('');
  lines.push('---');
  lines.push('Aperta da `scripts/ci/scan-unreported-failures.mjs --dormant`.');
  lines.push('Si richiude da sé quando il workflow torna a girare verde');
  lines.push('(`close-recovered-failure-issues.yml`).');
  return lines.join('\n');
}

async function scanDormant() {
  const openIssues = openFailureIssueWorkflows();
  if (openIssues === null) {
    console.error('::error::[scan-unreported-failures] listing delle issue aperte illeggibile — nessuna issue aperta in questa passata.');
    return 1;
  }

  // La cadenza si legge dal FILE sul branch di default (è quello che GitHub
  // usa per schedulare), lo stato e l'id dal registro API.
  const byPath = new Map();
  for (const wf of registeredWorkflows().values()) byPath.set(wf.path, wf);

  const candidates = [];
  for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const relPath = `.github/workflows/${file}`;
    const wf = byPath.get(relPath);
    if (!wf) continue;
    if (wf.state !== 'active') continue;
    const { crons } = workflowScheduleFromSource(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
    if (!crons.length) continue;
    if (IGNORE.has(wf.name)) continue;
    const gapMinutes = maxCronGapMinutes(crons);
    if (!gapMinutes) {
      console.warn(
        `::warning::[scan-unreported-failures] cron non interpretabile in ${relPath} `
          + `(${crons.join(' | ')}) — dormienza NON verificata per questo workflow.`,
      );
      continue;
    }
    candidates.push({ wf, crons, gapMinutes });
  }

  console.log(`[scan-unreported-failures --dormant] ${candidates.length} workflow schedulati e attivi da verificare.`);

  let opened = 0;
  let checked = 0;
  for (const { wf, crons, gapMinutes } of candidates) {
    const thresholdMinutes = gapMinutes * DORMANT_GRACE_MULTIPLIER;
    const rows = ghApiList(
      `repos/${REPO || '{owner}/{repo}'}/actions/workflows/${wf.id}/runs?per_page=1`,
      '.workflow_runs[] | {created_at}',
    );
    checked += 1;
    const lastRunAt = rows[0]?.created_at || null;
    // Senza run non si distingue «morto» da «appena aggiunto»: si usa la data di
    // registrazione del workflow come sostituto dell'ultima run.
    const reference = lastRunAt || wf.created_at;
    if (!reference) continue;
    const idleMinutes = (Date.now() - Date.parse(reference)) / 60_000;
    if (!(idleMinutes > thresholdMinutes)) continue;

    const already = openIssues.get(wf.name);
    if (already) {
      console.log(`[scan-unreported-failures --dormant] ${wf.name}: issue #${already} già aperta → skip.`);
      continue;
    }
    if (opened >= MAX_ISSUES) {
      console.warn(
        `::warning::[scan-unreported-failures --dormant] cap di ${MAX_ISSUES} raggiunto — `
          + 'altri workflow dormienti NON segnalati in questa passata.',
      );
      break;
    }

    const title = `CI Failure: ${wf.name}`;
    const description = dormantBody({
      workflowName: wf.name,
      crons,
      gapMinutes,
      lastRunAt,
      thresholdHours: thresholdMinutes / 60,
    });
    console.log(
      `[scan-unreported-failures --dormant] ${wf.name}: ferma da ${Math.round(idleMinutes / 60)} h `
        + `(soglia ${Math.round(thresholdMinutes / 60)} h).`,
    );
    if (DRY_RUN) {
      console.log(`[scan-unreported-failures --dormant] (dry-run) aprirebbe "${title}"`);
      opened += 1;
      continue;
    }
    const issue = await createGithubIssue({
      title,
      description,
      priority: 2,
      labels: ['automation', 'ci-failure'],
      workflow: wf.name,
    });
    if (!issue?.number || issue.persisted !== true) {
      console.error(`::error::[scan-unreported-failures --dormant] apertura NON confermata per ${wf.name}.`);
      return 1;
    }
    console.log(`[scan-unreported-failures --dormant] ${wf.name} → #${issue.number}`);
    opened += 1;
  }

  console.log(`[scan-unreported-failures --dormant] fatto — ${checked} verificati, ${opened} dormienti segnalati (dry-run=${DRY_RUN}).`);
  return 0;
}

async function main() {
  if (process.env.ENABLE_FAILURE_REPORT === 'false') {
    console.log('[scan-unreported-failures] ENABLE_FAILURE_REPORT=false — niente da fare.');
    return 0;
  }
  return DORMANT_MODE ? scanDormant() : scanFailures();
}

if (process.argv[1]?.endsWith('scan-unreported-failures.mjs')) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`::error::[scan-unreported-failures] ${e?.stack || e?.message || e}`);
      process.exit(1);
    });
}
