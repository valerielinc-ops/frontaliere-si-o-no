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
 *   - modalità failure (oraria): ~3 chiamate per l'elenco workflow + ~5 per le
 *     run rosse della finestra di 24 h (~465 `failure`, 100 per pagina) +
 *     1 `gh issue list` + per ogni workflow candidato 1 lettura dell'ultima run
 *     (il guard sul rientro) e 1 lettura dei job, entrambe ≤ MAX_ISSUES.
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
import { createGithubIssue, commentOnGithubIssue } from '../lib/github-issue-creator.mjs';
import { TITLE_RE } from './close-recovered-failure-issues.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const DRY_RUN = process.argv.includes('--dry-run');
const DORMANT_MODE = process.argv.includes('--dormant');
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

/**
 * Finestra di scansione: 24 ORE, non «poco più del cron».
 *
 * ── Perché non 75 minuti su un cron orario ──────────────────────────────
 *
 * Perché il cron non è un orologio, e la finestra tarata sulla cadenza NOMINALE
 * è un buco cieco garantito. È il difetto misurato sul gemello del corpus
 * (issue #1569): lookback di 40 minuti contro un cron che GitHub strozza a
 * 3,4-5,2 ore, con due fallimenti mancati — uno per 79 secondi e uno per 70,6
 * minuti. Con 75 minuti questo scanner aveva esattamente la stessa forma di
 * difetto: se GitHub ritarda la MIA passata di tre ore, tutto ciò che è fallito
 * nel buco non viene visto da nessuno, per sempre.
 *
 * Allargare non costa duplicati, e questo è il punto che rende la scelta
 * gratuita: la de-duplicazione di questo scanner è di STATO, non di tempo —
 * «esiste una issue aperta per questo workflow?» — quindi ripassare sulle stesse
 * run rosse è idempotente. Una finestra larga non genera rumore, genera solo
 * qualche pagina di API in più (misurato: ~465 run `failure` in 24 h, 5 pagine).
 *
 * È anche ciò che rende il cap di MAX_ISSUES un rinvio invece di una perdita:
 * l'eccedenza di una passata rientra nella finestra della successiva.
 *
 * ── Nessun gate «N fallimenti in M ore»: è la trappola, non la prudenza ──
 *
 * Questo scanner allarma al PRIMO fallimento. Una soglia del tipo «3 fallimenti
 * in 48 h» sembra prudente e invece rende inallarmabile per costruzione la
 * classe di guasto più comune della flotta: il workflow a cron GIORNALIERO che
 * fallisce ogni volta, che non raggiungerà mai 3 fallimenti in 48 ore. È il
 * secondo difetto di #1569, e il caso reale è `bing-seo-loop`, rosso 54 ore su
 * DUE repo senza che nessuno dei due meccanismi allarmasse. Il rumore si governa
 * con la dedup (una issue per workflow, ricorrenze in commento) e col cap
 * anti-valanga, non alzando la soglia di ingresso.
 */
const LOOKBACK_MINUTES = intFromEnv('UNREPORTED_SCAN_LOOKBACK_MINUTES', 24 * 60);

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
 * Dopo quante ore di SILENZIO su una issue già aperta il guasto che continua a
 * ricorrere viene ri-registrato con un commento.
 *
 * Perché non basta «esiste una issue aperta → è già segnalato». Caso misurato
 * sul campo: `rerender-article-hubs` aveva 9 run rosse che deduplicavano tutte
 * su #6650, aperta il 2026-08-27 e parcheggiata `needs-human` — l'allarme
 * esisteva e non allarmava più. Trattare «aperta» come «coperta» senza guardare
 * se qualcuno la stia ancora toccando riproduce esattamente il silenzio che
 * questo meccanismo esiste per rompere, solo un livello più in là.
 *
 * Non si apre un secondo thread (sarebbe la valanga) e non si tenta di
 * spacchettare il parcheggio: `needs-human` ha la sua porta di rientro nello
 * sweep settimanale, e forzarla da qui vorrebbe dire litigare con quel ciclo.
 * Si aggiunge UN commento con la run nuova, che è il minimo che rimette il
 * guasto in circolo: aggiorna `updatedAt`, riporta la issue in cima alle liste
 * ordinate per attività e dà allo sweep una prova fresca invece di una pagina
 * ferma da tre settimane.
 *
 * 24 ore, non ogni passata: a cadenza oraria un workflow rosso da 438 h — il
 * caso `audit-parser-quality` — avrebbe prodotto 438 commenti, cioè rumore che
 * si legge come guasto del monitor. La soglia si misura su `updatedAt` della
 * issue, che arriva GIÀ nel listing: qualunque attività (un commento, una
 * label, una modifica) rimanda avanti il conto, quindi una issue su cui si sta
 * lavorando non viene mai disturbata e costa zero chiamate in più.
 *
 * ── Il limite di questo segnale, misurato e non dedotto ──────────────────
 *
 * `updatedAt` è mosso ANCHE dall'etichettatura del ciclo, non solo dal lavoro
 * umano. Verificato il 2026-09-18 sulla issue del caso citato sopra: #6650 è
 * parcheggiata `needs-human` dal 2026-08-27, eppure porta
 * `updatedAt: 2026-09-18T16:46:55Z` perché il drainer le ha aggiornato le label
 * (`fu-attempt`, `fu-parked`). Per questa classe il commento NON scatta, e va
 * detto invece di far credere il contrario: la soglia coglie l'abbandono vero
 * (nessuno tocca più niente, come #8611 fermo da tre giorni), non il parcheggio
 * curato.
 *
 * Il parcheggio, deliberatamente, non lo si forza da qui. `needs-human` ha una
 * sola porta di rientro documentata — lo sweep settimanale, con una capacità
 * misurata — e aprire una seconda via di escalation da uno scanner di
 * fallimenti significherebbe due meccanismi che decidono la stessa cosa senza
 * parlarsi, che in questo repo è già stato un difetto a sé. Qui il contratto si
 * ferma dove deve: garantire che un allarme ESISTA per ogni workflow rosso, e
 * lasciarlo fresco quando nessun altro lo tiene in vita.
 */
const COVERED_ISSUE_SILENCE_HOURS = intFromEnv('COVERED_ISSUE_SILENCE_HOURS', 24);

/**
 * Una issue aperta è ancora un allarme VIVO, o è ferma da tanto da essere
 * diventata silenzio?
 *
 * @param {string|null|undefined} updatedAt
 * @param {number} [nowMs]
 */
export function isCoveredIssueStale(updatedAt, nowMs = Date.now(), hours = COVERED_ISSUE_SILENCE_HOURS) {
  const t = Date.parse(String(updatedAt ?? ''));
  // Una data illeggibile NON è «fresca»: meglio un commento in più che il
  // silenzio che questa funzione esiste per rilevare.
  if (!Number.isFinite(t)) return true;
  return nowMs - t > hours * 3600_000;
}

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

/**
 * Pavimento assoluto: sotto questo ritardo non si parla di dormienza, qualunque
 * sia la cadenza.
 *
 * Il moltiplicatore da solo non basta, e il dry-run del 2026-09-18 sul repo vero
 * lo ha dimostrato: su 178 workflow schedulati ne segnalava 8 fermi da 1-3 ore —
 * `sync-pharmacy-duties` (cadenza 20 min), `Close Recovered Failure Issues`,
 * `Follow-up drainer`, `Runtime reliability watchdog`… — tutti workflow VIVI.
 * Per una cadenza corta «tre cadenze mancate» è un'ora, e un'ora di ritardo su
 * questo repo è normale: il cron di Actions non è un orologio, salta le
 * esecuzioni sotto carico, e la coda di concorrenza qui arriva a ~1 h di attesa
 * misurata. Segnalarli avrebbe aperto 8 issue false alla prima passata, cioè la
 * valanga che questo meccanismo esiste per evitare, sull'altro lato.
 *
 * La condizione da rilevare è «ha SMESSO di girare», che richiede persistenza: i
 * casi reali portati dal proprietario sono dormienti da 13 a 114 giorni. A 24 h
 * un orario deve aver mancato 24 esecuzioni, un giornaliero 3, un settimanale 21
 * giorni. È la manopola da girare se un giorno servisse più reattività su una
 * cadenza corta specifica.
 */
const DORMANT_MIN_IDLE_MINUTES = intFromEnv('DORMANT_MIN_IDLE_HOURS', 24) * 60;

/**
 * Minuti di inattività oltre i quali un workflow schedulato è dormiente.
 *
 * @param {number} gapMinutes intervallo massimo fra due esecuzioni del suo cron
 * @param {{grace?: number, floorMinutes?: number}} [opts]
 */
export function dormancyThresholdMinutes(gapMinutes, opts = {}) {
  const grace = opts.grace ?? DORMANT_GRACE_MULTIPLIER;
  const floor = opts.floorMinutes ?? DORMANT_MIN_IDLE_MINUTES;
  return Math.max(gapMinutes * grace, floor);
}

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
 * Righe di `gh api --paginate`, una per record, lette come TSV.
 *
 * `@tsv` e non un filtro che rende oggetti: `gh api --jq` STAMPA IN FORMA
 * INDENTATA, quindi un `| {id, name}` esce su piu' righe e un parse riga-per-riga
 * fallisce su ognuna. Non e' teoria — la prima versione di questo file lo faceva,
 * e il dry-run del 2026-09-18 sul repo vero e' uscito con
 * «0 workflow schedulati e attivi da verificare» ed exit code 0: la scansione dei
 * dormienti non controllava NIENTE e lo dichiarava come lavoro fatto. E'
 * esattamente la classe di guasto silenzioso che questo meccanismo esiste per
 * impedire, quindi qui si usa la forma tabellare, che e' una riga per record per
 * costruzione.
 *
 * Rende `null` quando la CHIAMATA è fallita e `[]` quando la risposta è
 * legittimamente vuota. La distinzione è il punto: con `[]` per entrambi, un
 * 403 sul bucket Actions o un 422 su un filtro si leggeva come «nessuna run
 * rossa» e la passata finiva con exit 0 e un `Verdict` verde senza aver
 * guardato niente — lo stesso falso verde che la forma `@tsv` ha già chiuso una
 * volta qui. Ogni chiamante deve decidere che fare di `null`, e per una lettura
 * obbligatoria l'unica risposta giusta è fermarsi.
 *
 * @param {string[]} fields i nomi da associare, in ordine, alle colonne
 * @returns {Array<Record<string,string|null>>|null}
 */
function ghApiRows(apiPath, jqExpr, fields, { paginate = true } = {}) {
  const args = paginate
    ? ['api', apiPath, '--paginate', '--jq', jqExpr]
    : ['api', apiPath, '--jq', jqExpr];
  const out = gh(args, { allowFailure: true });
  if (out === null) return null;
  if (out === '') return [];
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const row = {};
    fields.forEach((f, i) => {
      const v = cols[i];
      row[f] = v === undefined || v === '' ? null : v;
    });
    rows.push(row);
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
  if (!isReportableScope(run, { ignore })) return false;
  const stamp = run.updated_at || run.created_at;
  if (since && !(stamp && Date.parse(stamp) >= Date.parse(since))) return false;
  return true;
}

/**
 * La run appartiene al perimetro che questo scanner giudica? (a prescindere
 * dall'esito)
 *
 * Estratta da `isReportableRun` perché serve DUE volte con lo stesso
 * significato: per decidere se un rosso va segnalato, e per decidere se un verde
 * conta come RIENTRO. Tenerla in un posto solo non è estetica — il guard sul
 * rientro nasceva confrontando il rosso di `main` con «l'ultima run completata»
 * qualunque essa fosse, e una run verde su un branch di feature o su una PR
 * veniva letta come guarigione: il rosso di `main` restava soppresso e
 * invisibile. Due predicati di perimetro che non si parlano sono già stati un
 * difetto in questo repo; qui il perimetro è uno.
 */
export function isReportableScope(run, { ignore = IGNORE } = {}) {
  if (!run) return false;
  if (String(run.event || '').startsWith('pull_request')) return false;
  if (run.head_branch !== 'main' && run.event !== 'schedule') return false;
  if (ignore.has(run.workflow_name)) return false;
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
 * ponytail: forza bruta invece di un motore cron (nessuna dipendenza cron
 * installata, e aggiungerne una per questo sarebbe sproporzionato). L'ora viene
 * saltata in blocco quando non è ammessa, quindi per una cadenza rara il costo
 * reale è di poche decine di migliaia di iterazioni.
 *
 * La finestra CRESCE solo se serve. Una finestra fissa di 70 giorni era il
 * difetto trovato in review: un cron mensile sul giorno 29, 30 o 31 ha una sola
 * occorrenza fra il 1° gennaio e la metà di marzo — febbraio quei giorni non li
 * ha — quindi cadeva nel ramo `fires.length < 2` e quel workflow restava fuori
 * dal controllo di dormienza. Si prova 70 giorni (che copre tutto il parco
 * attuale al costo minimo), poi 400 e infine 1.500 solo per chi non ha ancora
 * due occorrenze: così un orario non paga mai la finestra lunga e un mensile
 * raro viene comunque misurato. Oltre 1.500 giorni resta `null` — il caso è un
 * `29 febbraio`, che ricorre ogni 4 anni — e chi chiama lo DICE invece di
 * inventare una cadenza.
 */
export function maxCronGapMinutes(crons, { windowDays = null } = {}) {
  if (windowDays !== null) return cronGapInWindow(crons, windowDays);
  for (const days of [70, 400, 1500]) {
    const gap = cronGapInWindow(crons, days);
    if (gap !== null) return gap;
  }
  return null;
}

function cronGapInWindow(crons, windowDays) {
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

/**
 * I `cron:` e il `name:` dichiarati da un file di workflow, letti testualmente.
 *
 * NON si tronca più al primo `jobs:`. La versione precedente lo faceva per
 * restare dentro il blocco `on:`, ma l'ordine delle chiavi in YAML è libero: un
 * workflow che dichiara `jobs:` PRIMA di `on:` rendeva zero cron e usciva in
 * silenzio dal controllo di dormienza — un workflow non sorvegliato che si
 * presenta come «senza cadenza», che è il modo peggiore di sbagliare qui.
 *
 * Si cercano quindi le voci `- cron:` in tutto il file, saltando le righe
 * commentate. Il compromesso è dichiarato: un `- cron:` scritto altrove (per
 * esempio dentro l'env di un job) verrebbe contato come cadenza. È un errore che
 * porta a sorvegliare un workflow in più con una soglia forse sbagliata, mentre
 * la troncatura portava a non sorvegliarlo per niente: il primo si vede in un
 * log, il secondo no.
 *
 * ponytail: resta un parse testuale invece di `yaml` perché il workflow che
 * esegue questo scanner non fa `npm ci` — le dipendenze non ci sono, e
 * aggiungere l'installazione per leggere cinque campi costerebbe più di quanto
 * valga. Se un giorno servisse la struttura vera, va aggiunto `npm ci` insieme
 * al parser, non uno dei due.
 */
export function workflowScheduleFromSource(source) {
  const text = String(source);
  const nameMatch = text.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].replace(/\s+#.*$/, '').trim() : null;
  const crons = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.match(/^\s*-\s*cron:\s*['"]?([^'"#\n]+)['"]?/))
    .filter(Boolean)
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
      // `updatedAt` arriva qui e non costa una chiamata in più: è il dato con cui
      // si distingue un allarme vivo da uno parcheggiato (vedi
      // COVERED_ISSUE_SILENCE_HOURS).
      // `body` contiene anche il campo strutturato `**Workflow:**` delle issue
      // aperte dai monitor di dominio, che possono usare un titolo diverso.
      '--json', 'number,title,updatedAt,body', ...repoFlag()],
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
  // FAIL CLOSED al cap, non un warning. Con l'elenco troncato la canonica di un
  // workflow può restare fuori pagina, e una canonica «assente» significa aprire
  // un DUPLICATO — cioè il contrario dello scopo di questa funzione. Meglio una
  // passata che non apre niente e lo dice: il rosso vero rientra alla prossima,
  // un duplicato no.
  if (issues.length >= OPEN_ISSUE_LISTING_CAP) {
    console.error(
      `::error::[scan-unreported-failures] cap di ${OPEN_ISSUE_LISTING_CAP} raggiunto sul listing `
        + 'delle issue aperte: la mappa delle canoniche è incompleta e aprire ora significherebbe '
        + 'duplicare. Nessuna issue aperta in questa passata.',
    );
    return null;
  }
  const byWorkflow = new Map();
  for (const issue of issues) {
    const workflowName = workflowNameFromIssue(issue);
    if (workflowName) byWorkflow.set(workflowName, { number: issue.number, updatedAt: issue.updatedAt ?? null });
  }
  return byWorkflow;
}

/**
 * Risolve il workflow associato a una issue già aperta.
 *
 * I fallimenti generici usano un titolo nella famiglia di `TITLE_RE`, mentre i
 * monitor di dominio possono usare un titolo proprio. Questi ultimi hanno però
 * già il campo strutturato `**Workflow:** <nome>` nel corpo: usarlo qui permette
 * alla rete globale di riconoscere la copertura senza indovinare dal testo
 * libero o dal nome del crawler.
 */
export function workflowNameFromIssue(issue) {
  const titleMatch = TITLE_RE.exec(String(issue?.title || ''));
  if (titleMatch) return titleMatch[1].trim();

  const bodyMatch = String(issue?.body || '').match(/^\*\*Workflow:\*\*\s*(.+?)\s*$/m);
  return bodyMatch?.[1]?.trim() || null;
}

/* ── modalità failure ───────────────────────────────────────────────── */

/**
 * `workflow_id` → `{ name, path, state }`, il solo nome che il chiuditore sa
 * risolvere con `gh run list -w`.
 *
 * Un registro VUOTO non è «nessun workflow»: è una lettura fallita. Rende `null`
 * e chi chiama si ferma, perché proseguire significherebbe concludere «niente da
 * segnalare» — un verde su una misura che non è stata fatta.
 */
function registeredWorkflows() {
  const rows = ghApiRows(
    `repos/${REPO || '{owner}/{repo}'}/actions/workflows?per_page=100`,
    '.workflows[] | [.id, .name, .path, .state, .created_at] | @tsv',
    ['id', 'name', 'path', 'state', 'created_at'],
  );
  if (rows === null || !rows.length) return null;
  const byId = new Map();
  for (const w of rows) if (w?.id) byId.set(String(w.id), w);
  return byId.size ? byId : null;
}

export function runBody({ run, workflowName, jobs, jobsReadable = true }) {
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
  } else if (!jobsReadable) {
    // Distinto dal caso sopra di proposito: «non ho potuto leggere i job» e
    // «i job non riportano fallimenti» portano a diagnosi diverse, e spacciare
    // il primo per il secondo manda chi legge a cercare la causa nel posto
    // sbagliato.
    lines.push('_(lettura dei job NON riuscita per questa run: la diagnosi qui sotto è incompleta,');
    lines.push('apri la run per vedere quale job è caduto.)_');
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
  if (!workflows) {
    console.error('::error::[scan-unreported-failures] registro dei workflow illeggibile — impossibile risolvere i nomi, nessuna issue aperta in questa passata.');
    return 1;
  }
  const runs = ghApiRows(
    `repos/${REPO || '{owner}/{repo}'}/actions/runs`
      + `?created=%3E%3D${encodeURIComponent(horizon)}&status=failure&per_page=100`,
    '.workflow_runs[] | [.id, .workflow_id, .event, .head_branch, .conclusion,'
      + ' .created_at, .updated_at, .html_url, .path] | @tsv',
    ['id', 'workflow_id', 'event', 'head_branch', 'conclusion', 'created_at', 'updated_at', 'html_url', 'path'],
  );
  // Lettura obbligatoria: senza l'elenco delle run non c'è niente da decidere, e
  // dichiarare «nessuna run rossa» sarebbe un verde su una misura non fatta.
  if (runs === null) {
    console.error('::error::[scan-unreported-failures] elenco delle run rosse illeggibile (API Actions non disponibile?) — nessuna conclusione possibile in questa passata.');
    return 1;
  }

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

  // ── Un solo accumulatore, una sola uscita ─────────────────────────────
  // Il confine non avanza senza una consegna PROVATA: `delivered` cresce solo
  // dopo che GitHub ha confermato la scrittura. `createGithubIssue` rende `null`
  // se la creazione non e' andata e `persisted: false` se la scrittura non e'
  // confermata, e `commentOnGithubIssue` rende `false`: un `if (res) delivered++`
  // conterebbe come consegnato anche cio' che non e' mai atterrato. Ogni esito
  // confluisce qui e la funzione esce in UN punto, cosi' il verdetto non puo'
  // divergere dai conteggi che stampa.
  const tally = { delivered: 0, active: 0, recovered: 0, deferred: [], undelivered: [] };
  const pending = [...byWorkflow.entries()];

  for (let i = 0; i < pending.length; i += 1) {
    const [workflowName, run] = pending[i];
    const already = openIssues.get(workflowName);

    if (already) {
      // Un secondo thread non si apre mai. Ma se la issue e' ferma da oltre la
      // soglia, il guasto che continua a ricorrere va ri-registrato: «aperta» non
      // significa «viva» (caso `rerender-article-hubs`/#6650, parcheggiata dal
      // 2026-08-27 mentre 9 run rosse le deduplicavano sopra).
      if (!isCoveredIssueStale(already.updatedAt)) {
        tally.active += 1;
        console.log(`[scan-unreported-failures] ${workflowName}: issue #${already.number} aperta e attiva → nessun commento.`);
        continue;
      }
      const silentHours = Math.round((Date.now() - Date.parse(String(already.updatedAt ?? ''))) / 3600_000);
      if (DRY_RUN) {
        tally.delivered += 1;
        console.log(`[scan-unreported-failures] (dry-run) commenterebbe la ricorrenza su #${already.number} (${workflowName}, ferma da ~${silentHours} h)`);
        continue;
      }
      const commented = commentOnGithubIssue(
        already.number,
        `🔁 Il guasto ricorre e questa issue è ferma da ~${silentHours} h.\n\n`
          + `- run: ${run.html_url}\n- event: \`${run.event}\` · branch: \`${run.head_branch}\`\n`
          + `- aggiornata: ${run.updated_at}\n\n`
          + 'Registrato da `scripts/ci/scan-unreported-failures.mjs`: nessun secondo thread, '
          + 'solo la prova che la condizione non è rientrata.',
      );
      if (commented !== true) {
        tally.undelivered.push(`${workflowName} (commento su #${already.number})`);
        continue;
      }
      tally.delivered += 1;
      console.log(`[scan-unreported-failures] ${workflowName}: ricorrenza registrata su #${already.number} (ferma da ~${silentHours} h).`);
      continue;
    }

    // Cap anti-valanga. Con la finestra di lookback larga l'eccedenza NON si
    // perde: rientra nella finestra della passata successiva, che e' proprio
    // cio' che una finestra tarata sulla cadenza del cron non garantiva.
    if (tally.delivered >= MAX_ISSUES) {
      tally.deferred = pending.slice(i).map(([n]) => n);
      console.warn(
        `::warning::[scan-unreported-failures] cap di ${MAX_ISSUES} issue raggiunto — `
          + `${tally.deferred.length} workflow rossi rinviati alla prossima passata `
          + `(la finestra di ${LOOKBACK_MINUTES} min li ricomprende): ${tally.deferred.join(', ')}.`,
      );
      break;
    }

    // La finestra e' larga 24 h, quindi una run rossa di stanotte puo' essere
    // gia' stata seguita da una verde: aprire ora segnalerebbe un guasto
    // rientrato. Una lettura illeggibile non fa saltare la segnalazione: in
    // dubbio si segnala, perche' il costo di una issue in piu' e' un commento,
    // quello di un rosso perso e' giorni.
    //
    // Il verde deve stare nello STESSO perimetro del rosso, non essere solo
    // «l'ultima run completata». Senza questo filtro una run verde su un branch
    // di feature o su una PR — che su questo repo sono la maggioranza, 610 su
    // 930 in 48 h — veniva letta come guarigione e sopprimeva il rosso di
    // `main`: un rosso reale reso invisibile dal guard che doveva solo evitare
    // rumore. Si chiede quindi una pagina di run completate e si guarda la piu'
    // recente CHE RICADE NEL PERIMETRO, con lo stesso `isReportableScope` che
    // ha selezionato il rosso.
    const recent = ghApiRows(
      `repos/${REPO || '{owner}/{repo}'}/actions/workflows/${run.workflow_id}/runs`
        + '?per_page=20&status=completed',
      '.workflow_runs[] | [.conclusion, .created_at, .event, .head_branch] | @tsv',
      ['conclusion', 'created_at', 'event', 'head_branch'],
      { paginate: false },
    );
    const inScope = (recent || [])
      .filter((r) => isReportableScope({ ...r, workflow_name: workflowName }))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const newest = inScope[0];
    if (newest && newest.conclusion === 'success'
      && Date.parse(newest.created_at) > Date.parse(run.created_at)) {
      tally.recovered += 1;
      console.log(
        `[scan-unreported-failures] ${workflowName}: rientrato (run verde ${newest.created_at} `
          + `su \`${newest.head_branch}\`/\`${newest.event}\` dopo il rosso ${run.created_at}) → nessuna issue.`,
      );
      continue;
    }

    const title = `CI Failure: ${workflowName}`;
    if (DRY_RUN) {
      tally.delivered += 1;
      console.log(`[scan-unreported-failures] (dry-run) aprirebbe "${title}" per ${run.html_url}`);
      continue;
    }

    const jobsRaw = gh(
      ['api', `repos/${REPO || '{owner}/{repo}'}/actions/runs/${run.id}/jobs?per_page=100`],
      { allowFailure: true },
    );
    let jobs = null;
    if (jobsRaw !== null) {
      try {
        jobs = JSON.parse(jobsRaw);
      } catch {
        jobs = null;
      }
    }
    const issue = await createGithubIssue({
      title,
      description: runBody({ run, workflowName, jobs, jobsReadable: jobsRaw !== null }),
      priority: 2,
      labels: ['automation', 'ci-failure'],
      workflow: workflowName,
    });
    if (!issue?.number || issue.persisted !== true) {
      tally.undelivered.push(workflowName);
      continue;
    }
    tally.delivered += 1;
    console.log(`[scan-unreported-failures] ${workflowName} → #${issue.number}`);
  }

  console.log(
    `[scan-unreported-failures] fatto — ${tally.delivered} consegnate, ${tally.active} già coperte da `
      + `una issue viva, ${tally.recovered} rientrate, ${tally.deferred.length} rinviate, `
      + `${tally.undelivered.length} NON consegnate (dry-run=${DRY_RUN}).`,
  );
  if (tally.undelivered.length) {
    console.error(
      `::error::[scan-unreported-failures] ${tally.undelivered.length} segnalazioni NON sono atterrate `
        + `su GitHub: ${tally.undelivered.join(', ')}. Quei workflow restano rossi e invisibili.`,
    );
  }
  return tally.undelivered.length ? 1 : 0;
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
  const registry = registeredWorkflows();
  if (!registry) {
    console.error('::error::[scan-unreported-failures --dormant] registro dei workflow illeggibile — la dormienza NON e\' stata verificata.');
    return 1;
  }
  const byPath = new Map();
  for (const wf of registry.values()) byPath.set(wf.path, wf);

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
    const thresholdMinutes = dormancyThresholdMinutes(gapMinutes);
    // `paginate: false` e' obbligatorio: con `--paginate` un `per_page=1`
    // camminerebbe TUTTE le run del workflow una per chiamata, cioe' migliaia di
    // richieste sul bucket Actions per un dato che sta nella prima riga.
    const rows = ghApiRows(
      `repos/${REPO || '{owner}/{repo}'}/actions/workflows/${wf.id}/runs?per_page=1`,
      '.workflow_runs[] | [.created_at] | @tsv',
      ['created_at'],
      { paginate: false },
    );
    // Una lettura FALLITA non è «non ha mai girato»: senza questo guard il
    // fallback sulla data di registrazione del workflow avrebbe aperto una issue
    // di dormienza su un workflow sano ogni volta che l'API Actions restituisce
    // 403 — un allarme falso costruito su un dato mancante.
    if (rows === null) {
      console.warn(`::warning::[scan-unreported-failures --dormant] ultima run di ${wf.name} illeggibile — dormienza NON verificata per questo workflow.`);
      continue;
    }
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
      // Qui non si commenta la ricorrenza come nel ramo dei rossi: una issue
      // aperta su questo workflow dice già che qualcuno lo sta guardando, e la
      // dormienza non "ricorre" — è uno stato continuo, quindi un commento al
      // giorno sarebbe puro rumore.
      console.log(`[scan-unreported-failures --dormant] ${wf.name}: issue #${already.number} già aperta → skip.`);
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
