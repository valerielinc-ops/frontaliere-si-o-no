/**
 * Ciclo di vita delle issue dei loop L0-L10.
 *
 * Perché esiste. Ogni `scripts/ci/loop-l<N>-*.mjs` chiamava `createGithubIssue`
 * a ogni verdetto non ok. Sul thread già aperto il creator commenta SEMPRE,
 * anche a motivo identico: misurato il 2026-10-03, 560 ricorrenze sulla issue
 * 8407 (106 in 48 ore), 132 sulla 8400, 104 sulla 8386. Nessun loop chiudeva
 * la propria issue su verde, e titolo e corpo descrivevano il motivo del giorno
 * di apertura, non quello corrente.
 *
 * Contratto:
 * - lo STATO vive nel corpo, in un blocco riscritto in place a ogni run
 *   (`LOOP_STATE:start` … `LOOP_STATE:end`): motivo corrente, firma, run, data,
 *   `okStreak`;
 * - un commento (marker di ricorrenza) solo quando la FIRMA del motivo cambia;
 *   vale per ogni evento, `push` compreso: una regressione introdotta da un
 *   merge si vede subito, lo stesso motivo ripetuto no;
 * - la chiusura arriva dopo `LOOP_OK_STREAK` verdetti ok CONSECUTIVI di run
 *   `schedule`. Tre push in dieci minuti non sono tre misure indipendenti e un
 *   `workflow_dispatch` non è una misura di cadenza: lì lo streak non avanza.
 *   Un verdetto non ok, di qualunque evento, lo azzera;
 * - una sola issue aperta per loop: se la classe (titolo) cambia, quella del
 *   titolo precedente viene chiusa `not planned` con rimando. Niente retitle.
 *
 * - «campione insufficiente» è uno STATO, non un guasto: lo decide lo script
 *   del loop (sorgente fresca, join valido, UNICO controllo fallito il
 *   campione minimo) e lo passa come `state: 'awaiting-sample'` con
 *   `sample: { current, minimum, windowDays }`. La issue resta aperta come
 *   tracker, porta l'ETA nel blocco, non riceve commenti e viene pinnata fuori
 *   dal fixer con `keep-open` (le label di instradamento si tolgono). Chi la
 *   pinna lo scrive nel blocco (`pinnedByLoopLib`): all'uscita dallo stato la
 *   libreria toglie solo il `keep-open` che ha messo lei. Misurato il
 *   2026-10-03 sulla issue 9865 (L2): 42 sessioni su 1000 a ~5 al giorno,
 *   ~190 giorni; il fixer aveva già concluso `no-root-cause` e lo sweep la
 *   rimetteva in ciclo perché portava `automation-deferred`. Un'ETA oltre
 *   `SAMPLE_HORIZON_DAYS` (o non calcolabile) diventa una riga nel digest
 *   delle decisioni del proprietario, una sola per loop e per minimo; le
 *   soglie minime NON si abbassano.
 *
 * `reportLoopIssue` ha la stessa forma di parametri e di ritorno di
 * `createGithubIssue`: gli script la ricevono come default di
 * `createIssueImpl`, e i test che iniettano quel parametro non cambiano.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGithubIssue,
  resolveGithubIssue,
  searchSafePrefix,
} from './github-issue-creator.mjs';

export const LOOP_OK_STREAK = 3;
export const LOOP_STATE_START = '<!-- LOOP_STATE:start -->';
export const LOOP_STATE_END = '<!-- LOOP_STATE:end -->';
/** Label advisory del fixer: un verdetto non ok la smentisce. */
export const MAYBE_RESOLVED_LABEL = 'maybe-resolved';
/** Stesso marker contato dal creator per le ricorrenze. */
export const LOOP_STATE_CHANGE_MARKER = '🔁';
/** Stati scritti nel blocco: `failing` è un guasto lavorabile, gli altri no. */
export const LOOP_STATE_FAILING = 'failing';
export const LOOP_STATE_AWAITING_SAMPLE = 'awaiting-sample';
export const LOOP_STATE_OK = 'ok';
/** Oltre questo numero di giorni (o con ETA non calcolabile) decide il proprietario. */
export const SAMPLE_HORIZON_DAYS = 90;
/**
 * Pin fuori dal fixer. Deve restare in `FIXER_EXEMPT_LABELS` di
 * `classify-issue.mjs` (un test lo verifica): non lo si importa perché i
 * workflow dei loop fanno sparse checkout di un elenco di file.
 */
export const KEEP_OPEN_LABEL = 'keep-open';
/** Label che rimettono una issue nel ciclo del fixer o dello sweep. */
export const FIXER_ROUTING_LABELS = Object.freeze([
  'agent:fix',
  'agent:fix-queued',
  'automation-deferred',
  'fu-parked',
]);
/** Titolo ESATTO del digest che `needs-human-sweep.yml` tiene aperto. */
export const OWNER_DIGEST_TITLE = '🧭 Decisioni del proprietario — digest';
export const COHORT_UNREACHABLE_MARKER = 'LOOP_COHORT_UNREACHABLE';

const DATA_PREFIX = '<!-- LOOP_STATE:data ';
const DATA_SUFFIX = ' -->';
const BLOCK_RE = /<!-- LOOP_STATE:start -->[\s\S]*?<!-- LOOP_STATE:end -->/u;
// GitHub rifiuta un corpo oltre 65.536 caratteri; stesso margine del creator.
const MAX_BODY_LEN = 60000;
const MAX_REASON_LEN = 500;
const SCHEDULE_EVENT = 'schedule';

/**
 * Classe normalizzata di un motivo: ciò che resta togliendo quello che cambia
 * da una run all'altra (URL, date, path, nomi di file, hash, numeri). Pura.
 * «eligibleLandingSessions 42 < 1000» e «… 54 < 1000» hanno la stessa firma;
 * «ledger is missing» e «ledger is stale» no.
 */
export function reasonSignature(reason) {
  const signature = String(reason ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:t[\d:.]+(?:z|[+-]\d{2}:?\d{2})?)?/gu, ' ')
    .replace(/(?:[\w.@~-]*\/)+[\w.@~-]*/gu, ' ')
    .replace(/\b[\w-]+\.(?:jsonl?|mjs|cjs|js|tsx?|ya?ml|csv|md|txt|html?)\b/gu, ' ')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gu, ' ')
    .replace(/\d+(?:[.,]\d+)*/gu, '#')
    .replace(/[^\p{L}#]+/gu, ' ')
    .replace(/(?:# )+#/gu, '#')
    .trim();
  return signature || 'unknown';
}

/** Legge lo stato dal blocco `LOOP_STATE` di un corpo; `null` se assente o illeggibile. */
export function parseLoopState(body) {
  const block = String(body ?? '').match(BLOCK_RE)?.[0];
  if (!block) return null;
  const start = block.indexOf(DATA_PREFIX);
  if (start === -1) return null;
  const end = block.indexOf(DATA_SUFFIX, start + DATA_PREFIX.length);
  if (end === -1) return null;
  try {
    const data = JSON.parse(block.slice(start + DATA_PREFIX.length, end));
    if (!data || typeof data !== 'object') return null;
    const okStreak = Number(data.okStreak);
    return {
      ...data,
      signature: typeof data.signature === 'string' ? data.signature : null,
      okStreak: Number.isInteger(okStreak) && okStreak >= 0 ? okStreak : 0,
      pinnedByLoopLib: data.pinnedByLoopLib === true,
    };
  } catch {
    return null;
  }
}

/**
 * ETA del campione minimo, pura. Il ritmo è `current / windowDays`; un
 * campione a zero ha ritmo zero qualunque sia la finestra. `etaDays: null`
 * vuol dire «non raggiungibile» (ritmo zero) o «non calcolabile» (ritmo non
 * derivabile dal campione, per esempio uno stock senza finestra di misura):
 * in entrambi i casi conta come oltre l'orizzonte.
 */
export function sampleEta({ current, minimum, windowDays } = {}) {
  const cur = Number.isInteger(current) && current >= 0 ? current : null;
  const min = Number.isInteger(minimum) && minimum > 0 ? minimum : null;
  const win = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : null;
  let ratePerDay = null;
  if (cur === 0) ratePerDay = 0;
  else if (cur !== null && win !== null) ratePerDay = cur / win;
  let etaDays = null;
  if (cur !== null && min !== null) {
    if (cur >= min) etaDays = 0;
    else if (ratePerDay > 0) etaDays = Math.ceil((min - cur) / ratePerDay);
  }
  return {
    current: cur,
    minimum: min,
    windowDays: win,
    ratePerDay: ratePerDay === null ? null : Number(ratePerDay.toFixed(3)),
    etaDays,
  };
}

/** `true` quando a decidere è il proprietario: ETA oltre l'orizzonte o assente. */
export function isBeyondSampleHorizon(eta) {
  return !Number.isFinite(eta?.etaDays) || eta.etaDays > SAMPLE_HORIZON_DAYS;
}

function etaText(eta) {
  if (Number.isFinite(eta?.etaDays)) return `${eta.etaDays} giorni`;
  if (eta?.ratePerDay === 0) return 'non raggiungibile (ritmo zero)';
  return 'non calcolabile (ritmo non derivabile dal campione)';
}

function sampleLine(eta) {
  const window = eta.windowDays === null ? 'senza finestra di misura' : `finestra di ${eta.windowDays} giorni`;
  const rate = eta.ratePerDay === null ? 'ritmo non misurato' : `ritmo ${eta.ratePerDay} al giorno`;
  return `${eta.current ?? '?'} su ${eta.minimum ?? '?'} (${window}); ${rate}; ETA ${etaText(eta)} (orizzonte ${SAMPLE_HORIZON_DAYS} giorni)`;
}

function oneLine(value, max = MAX_REASON_LEN) {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').replace(/--+>/gu, '→').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Rende il blocco di stato. La riga `data` è la parte letta dalle macchine. */
export function renderLoopStateBlock(state) {
  const loopState = state.loopState ?? (state.ok ? LOOP_STATE_OK : LOOP_STATE_FAILING);
  const awaiting = loopState === LOOP_STATE_AWAITING_SAMPLE && state.sample;
  const data = {
    v: 1,
    loopId: state.loopId ?? null,
    state: loopState,
    signature: state.signature ?? null,
    okStreak: state.okStreak ?? 0,
    updatedAt: state.updatedAt ?? null,
    event: state.event ?? null,
    pinnedByLoopLib: state.pinnedByLoopLib === true,
    ...(awaiting ? { sample: state.sample, etaDays: state.sample.etaDays ?? null } : {}),
  };
  const lines = [
    LOOP_STATE_START,
    `**Stato corrente del loop${state.loopId ? ` ${state.loopId}` : ''}** (riscritto a ogni run; la cronologia sotto resta com'era all'apertura)`,
    '',
    `- Verdetto: ${state.ok ? 'ok' : 'non ok'}`,
    `- state: ${loopState}`,
    ...(awaiting ? [
      `- Campione: ${sampleLine(state.sample)}`,
      `- Instradamento: pinnata fuori dal fixer con \`${KEEP_OPEN_LABEL}\`; non c'è codice da correggere, questa issue è il tracker del progetto «portare campione a questo loop». La soglia minima non si abbassa.`,
    ] : []),
    `- Motivo corrente: ${oneLine(state.reason) || '_non dichiarato_'}`,
    `- Firma del motivo: \`${data.signature ?? 'unknown'}\``,
    `- Ultima run: ${state.runUrl || '_non disponibile_'}${data.event ? ` (evento \`${data.event}\`)` : ''}`,
    `- Aggiornato: ${data.updatedAt ?? '_non disponibile_'}`,
    `- okStreak: ${data.okStreak} di ${LOOP_OK_STREAK} verdetti ok consecutivi di run \`${SCHEDULE_EVENT}\` necessari alla chiusura`,
    // La firma contiene solo lettere, `#` e spazi: dentro non può comparire `--`.
    `${DATA_PREFIX}${JSON.stringify(data).replace(/--/gu, '\\u002d\\u002d')}${DATA_SUFFIX}`,
    LOOP_STATE_END,
  ];
  return lines.join('\n');
}

/** Sostituisce in place il blocco di stato, o lo mette in testa se manca. */
export function upsertLoopStateBlock(body, state) {
  const block = renderLoopStateBlock(state);
  const current = String(body ?? '');
  const next = BLOCK_RE.test(current)
    ? current.replace(BLOCK_RE, () => block)
    : [block, current].filter(Boolean).join('\n\n');
  if (next.length <= MAX_BODY_LEN) return next;
  // Il blocco non si tronca mai: si accorcia il resto.
  const rest = next.replace(BLOCK_RE, '').trim();
  const room = Math.max(0, MAX_BODY_LEN - block.length - 40);
  return [block, `${rest.slice(0, room)}\n\n...(truncated)`].join('\n\n');
}

function ghBin(env) {
  const configured = String(env.TRUSTED_GH_BIN || '').trim();
  if (!configured) return 'gh';
  if (!configured.startsWith('/') || configured.includes('\0')) {
    throw new Error('TRUSTED_GH_BIN mancante o non assoluto');
  }
  return configured;
}

function defaultGh(env) {
  return (args) => {
    // Un test che dimentica di iniettare `gh` non deve mai scrivere su una
    // issue vera: sotto Vitest il binario reale non parte.
    if (env.VITEST) throw new Error('[loop-fleet-issue] gh non iniettato sotto Vitest');
    return execFileSync(ghBin(env), args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  };
}

function context(deps = {}) {
  const env = deps.env ?? process.env;
  return {
    env,
    gh: deps.gh ?? defaultGh(env),
    createIssue: deps.createIssue ?? createGithubIssue,
    resolveIssue: deps.resolveIssue ?? resolveGithubIssue,
    now: deps.now ?? (() => new Date()),
    logger: deps.logger ?? console,
    repoFlag: env.GH_REPO ? ['--repo', env.GH_REPO] : [],
  };
}

function runUrlFromEnv(env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = env;
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null;
}

function labelNames(issue) {
  return (Array.isArray(issue?.labels) ? issue.labels : [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);
}

/**
 * Issue APERTE il cui titolo è esattamente `title`, la più recente per prima.
 * `null` = lookup non affidabile: il chiamante non deve leggerlo come «nessuna».
 */
function findOpenIssues(ctx, title) {
  const exact = String(title).slice(0, 200);
  try {
    const out = ctx.gh([
      'issue', 'list',
      '--state', 'open',
      '--search', `in:title "${searchSafePrefix(exact).replace(/"/gu, '\\"')}"`,
      '--limit', '20',
      '--json', 'number,title,url,body,labels',
      ...ctx.repoFlag,
    ]);
    const parsed = out ? JSON.parse(out) : [];
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((issue) => issue?.title === exact)
      .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
  } catch (error) {
    ctx.logger.error(`[loop-fleet-issue] lookup non affidabile per "${exact}": ${error.message}`);
    return null;
  }
}

/** Una scrittura `gh`: `true` se riuscita, `false` (con log) se rifiutata. */
function write(ctx, args, what) {
  try {
    ctx.gh([...args, ...ctx.repoFlag]);
    return true;
  } catch (error) {
    ctx.logger.error(`[loop-fleet-issue] ${what} non riuscito: ${error.message}`);
    return false;
  }
}

function editBody(ctx, number, body, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fleet-issue-'));
  const file = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(file, body);
    return write(
      ctx,
      ['issue', 'edit', String(number), '--body-file', file, ...extraArgs],
      `aggiornamento del corpo di #${number}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function uniqueTitles(title, loopTitles) {
  return Array.from(new Set([title, ...(Array.isArray(loopTitles) ? loopTitles : [])].filter(Boolean)));
}

/**
 * Label da cambiare e nuovo valore di `pinnedByLoopLib`, puro. In
 * `awaiting-sample` la issue esce dal ciclo del fixer: `keep-open` messo qui
 * (o già messo qui in una run precedente) e routing tolto. Fuori da quello
 * stato si toglie solo il `keep-open` che la libreria ha messo: un pin
 * deciso da altri non si tocca. `maybe-resolved` cade su ogni verdetto non ok.
 */
export function pinPlan({ labels = [], previous = null, loopState = LOOP_STATE_FAILING } = {}) {
  const present = new Set(labels);
  const add = [];
  const remove = [];
  let pinnedByLoopLib = previous?.pinnedByLoopLib === true;
  if (loopState === LOOP_STATE_AWAITING_SAMPLE) {
    if (!present.has(KEEP_OPEN_LABEL)) {
      add.push(KEEP_OPEN_LABEL);
      pinnedByLoopLib = true;
    }
    remove.push(...FIXER_ROUTING_LABELS.filter((label) => present.has(label)));
  } else if (pinnedByLoopLib) {
    if (present.has(KEEP_OPEN_LABEL)) remove.push(KEEP_OPEN_LABEL);
    pinnedByLoopLib = false;
  }
  if (loopState !== LOOP_STATE_OK && present.has(MAYBE_RESOLVED_LABEL)) remove.push(MAYBE_RESOLVED_LABEL);
  return { add, remove, pinnedByLoopLib };
}

function labelArgs(plan) {
  return [
    ...(plan.add.length ? ['--add-label', plan.add.join(',')] : []),
    ...(plan.remove.length ? ['--remove-label', plan.remove.join(',')] : []),
  ];
}

export function cohortUnreachableMarker(loopId, minimum) {
  return `<!-- ${COHORT_UNREACHABLE_MARKER}: loop=${loopId ?? 'unknown'} minimum=${minimum ?? 'unknown'} -->`;
}

/**
 * Una riga nel digest delle decisioni del proprietario per una coorte che non
 * arriva al minimo entro l'orizzonte. Una sola volta per loop e per minimo
 * (dedup sul marker nei commenti). Digest assente → log, nessuna creazione:
 * lo crea e lo tiene `needs-human-sweep.yml`. `false` solo se una lettura o
 * una scrittura non è riuscita, così la run successiva ritenta.
 */
function postCohortUnreachable(ctx, { loopId, eta, issueNumber, title }) {
  const digests = findOpenIssues(ctx, OWNER_DIGEST_TITLE);
  if (digests === null) return false;
  const digest = digests[0];
  if (!digest) {
    ctx.logger.log(`[loop-fleet-issue] digest «${OWNER_DIGEST_TITLE}» assente: coorte irraggiungibile di ${loopId ?? 'loop'} (${sampleLine(eta)}) non riportata`);
    return true;
  }
  const marker = cohortUnreachableMarker(loopId, eta.minimum);
  let comments;
  try {
    const view = JSON.parse(ctx.gh(['issue', 'view', String(digest.number), '--json', 'comments', ...ctx.repoFlag]));
    comments = Array.isArray(view?.comments) ? view.comments : null;
  } catch (error) {
    ctx.logger.error(`[loop-fleet-issue] commenti del digest #${digest.number} non leggibili: ${error.message}`);
    return false;
  }
  if (comments === null) return false;
  if (comments.some((comment) => String(comment?.body ?? '').includes(marker))) return true;
  return write(ctx, [
    'issue', 'comment', String(digest.number),
    '--body', [
      marker,
      `🧭 **Loop ${loopId ?? '?'}: coorte che non raggiunge il campione minimo entro ${SAMPLE_HORIZON_DAYS} giorni** — decisione del proprietario`,
      '',
      `- Campione: ${eta.current ?? '?'} su ${eta.minimum ?? '?'}${eta.windowDays === null ? '' : ` in ${eta.windowDays} giorni`}`,
      `- Ritmo: ${eta.ratePerDay === null ? 'non misurato' : `${eta.ratePerDay} al giorno`}`,
      `- ETA: ${etaText(eta)}`,
      issueNumber
        ? `- Tracker: #${issueNumber} (pinnata con \`${KEEP_OPEN_LABEL}\`, fuori dal fixer)`
        : `- Tracker: nessuna issue aperta (classe «${title}»); nessuna issue nuova per il fixer`,
      '',
      'Non è un difetto di codice e la soglia minima non si abbassa. Opzioni: allargare la coorte o la finestra di misura, accettare l\'attesa, ritirare o riprogettare il loop.',
    ].join('\n'),
  ], `riga nel digest #${digest.number}`);
}

/**
 * Riporta un verdetto NON ok. Stessi parametri e stesso ritorno di
 * `createGithubIssue`, più `loopId`, `reason` e `loopTitles` (tutti i titoli
 * che quel loop può emettere). `persisted: true` solo se ogni scrittura è
 * riuscita; con una scrittura fallita la firma nel corpo non avanza, così la
 * run successiva ritenta invece di tacere.
 *
 * `state: 'awaiting-sample'` + `sample: { current, minimum, windowDays }`
 * (deciso dallo script del loop): nessun commento, ETA nel blocco, issue
 * pinnata fuori dal fixer; ETA oltre `SAMPLE_HORIZON_DAYS` → una riga nel
 * digest del proprietario e nessuna issue NUOVA.
 */
export async function reportLoopIssue(params = {}, deps = {}) {
  const {
    loopId = null,
    reason = '',
    loopTitles = [],
    runUrl: explicitRunUrl = null,
    eventName: explicitEvent = null,
    state: requestedState = null,
    sample = null,
    ...issueParams
  } = params;
  const ctx = context(deps);
  if (ctx.env.ENABLE_FAILURE_REPORT === 'false') {
    ctx.logger.log('[loop-fleet-issue] ENABLE_FAILURE_REPORT=false, skipping');
    return null;
  }
  const { title, description = '' } = issueParams;
  if (!title) {
    ctx.logger.error('[loop-fleet-issue] title is required');
    return null;
  }

  const awaiting = requestedState === LOOP_STATE_AWAITING_SAMPLE;
  const eta = awaiting ? sampleEta(sample ?? {}) : null;
  const beyondHorizon = awaiting && isBeyondSampleHorizon(eta);
  const signature = reasonSignature(reason);
  const state = {
    loopId,
    ok: false,
    loopState: awaiting ? LOOP_STATE_AWAITING_SAMPLE : LOOP_STATE_FAILING,
    sample: eta,
    reason,
    signature,
    okStreak: 0,
    pinnedByLoopLib: false,
    runUrl: explicitRunUrl ?? runUrlFromEnv(ctx.env),
    event: explicitEvent ?? ctx.env.GITHUB_EVENT_NAME ?? null,
    updatedAt: ctx.now().toISOString(),
  };

  const open = findOpenIssues(ctx, title);
  if (open === null) {
    return { number: null, title, url: null, lookupFailed: true, persisted: false };
  }

  let result;
  const existing = open[0] || null;
  if (existing) {
    const previous = parseLoopState(existing.body);
    const signatureChanged = previous?.signature !== signature;
    const plan = pinPlan({ labels: labelNames(existing), previous, loopState: state.loopState });
    let persisted = true;
    // Un campione che cresce non è un cambio di stato: niente commento finché
    // si resta in `awaiting-sample`, e niente commento nemmeno per entrarci
    // (il pin e il blocco bastano; un commento rimetterebbe in moto i
    // workflow delle issue). L'uscita verso un guasto commenta come sempre.
    if (signatureChanged && !awaiting) {
      // Il commento PRIMA del corpo: se il corpo non si scrive la firma non
      // avanza e la run successiva ricommenta, invece di perdere il cambio.
      persisted = write(ctx, [
        'issue', 'comment', String(existing.number),
        '--body', [
          `${LOOP_STATE_CHANGE_MARKER} Stato cambiato${loopId ? ` (${loopId})` : ''}: ${oneLine(reason) || 'motivo non dichiarato'}`,
          previous?.signature ? `Firma precedente: \`${previous.signature}\`` : '',
          `Firma corrente: \`${signature}\``,
          state.runUrl ? `Run: ${state.runUrl}` : '',
          description,
        ].filter(Boolean).join('\n\n').slice(0, MAX_BODY_LEN),
      ], `commento di cambio stato su #${existing.number}`);
    }
    if (persisted) {
      persisted = editBody(
        ctx,
        existing.number,
        upsertLoopStateBlock(existing.body, { ...state, pinnedByLoopLib: plan.pinnedByLoopLib }),
        labelArgs(plan),
      );
    }
    result = {
      number: existing.number,
      title: existing.title,
      url: existing.url ?? null,
      state: 'OPEN',
      signatureChanged,
      persisted,
    };
  } else if (beyondHorizon) {
    // Una coorte che non arriva al minimo entro l'orizzonte non è lavoro per
    // il fixer: nessuna issue nuova, decide il proprietario dal digest.
    result = { number: null, title, url: null, persisted: true, skipped: 'sample-beyond-horizon' };
  } else {
    const labels = awaiting
      ? Array.from(new Set([...(issueParams.labels ?? []), KEEP_OPEN_LABEL]))
      : issueParams.labels;
    result = await ctx.createIssue({
      ...issueParams,
      ...(labels ? { labels } : {}),
      description: [
        renderLoopStateBlock({ ...state, pinnedByLoopLib: awaiting }),
        description,
      ].filter(Boolean).join('\n\n'),
    });
    // Il creator può aver riaperto o commentato una issue che il lookup sopra
    // non vedeva (indice di ricerca in ritardo, gemella chiusa da poco): il suo
    // corpo porta ancora lo stato vecchio, `okStreak` e label comprese.
    if (result?.persisted === true && result.number && !result.ledger) {
      result = {
        ...result,
        persisted: reconcileCreatedIssue(ctx, result.number, state, { reopened: result.reopened === true }),
      };
    }
  }

  if (result?.persisted === true && (result.number || result.skipped === 'sample-beyond-horizon')) {
    for (const other of uniqueTitles(title, loopTitles).filter((candidate) => candidate !== title)) {
      const stale = findOpenIssues(ctx, other);
      if (stale === null) {
        result = { ...result, persisted: false };
        continue;
      }
      const pointer = result.number
        ? `lo stato corrente è in #${result.number}`
        : `lo stato corrente è \`${LOOP_STATE_AWAITING_SAMPLE}\` con ETA oltre ${SAMPLE_HORIZON_DAYS} giorni, riportato nel digest delle decisioni del proprietario`;
      for (const issue of stale) {
        const closed = write(ctx, [
          'issue', 'close', String(issue.number),
          '--reason', 'not planned',
          '--comment', `Il loop${loopId ? ` ${loopId}` : ''} ora riporta un'altra classe di problema: ${pointer}. Chiusa per tenere una sola issue aperta per loop.`,
        ], `chiusura di #${issue.number} (titolo superato)`);
        if (!closed) result = { ...result, persisted: false };
      }
    }
  }

  if (beyondHorizon && result?.persisted === true) {
    const posted = postCohortUnreachable(ctx, { loopId, eta, issueNumber: result.number, title });
    result = { ...result, persisted: posted };
  }
  return result;
}

function reconcileCreatedIssue(ctx, number, state, { reopened = false } = {}) {
  let issue;
  try {
    issue = JSON.parse(ctx.gh(['issue', 'view', String(number), '--json', 'body,labels', ...ctx.repoFlag]));
  } catch (error) {
    // Lettura, non scrittura. Su una issue appena creata il blocco è quello
    // scritto dal creator: nulla da riallineare. Su una issue RIAPERTA il corpo
    // può portare ancora un `okStreak` vecchio, e un solo ok schedulato la
    // richiuderebbe: lo stato non è verificato, quindi non è persistito. La run
    // non ok successiva trova la issue aperta e riscrive il blocco.
    ctx.logger.error(`[loop-fleet-issue] stato di #${number} non verificabile: ${error.message}`);
    return !reopened;
  }
  const current = parseLoopState(issue?.body);
  const plan = pinPlan({ labels: labelNames(issue), previous: current, loopState: state.loopState });
  const labelsAligned = plan.add.length === 0 && plan.remove.length === 0;
  if (current?.signature === state.signature
      && current.okStreak === 0
      && current.state === state.loopState
      && current.pinnedByLoopLib === plan.pinnedByLoopLib
      && labelsAligned) return true;
  return editBody(
    ctx,
    number,
    upsertLoopStateBlock(issue?.body, { ...state, pinnedByLoopLib: plan.pinnedByLoopLib }),
    labelArgs(plan),
  );
}

/**
 * Riporta un verdetto ok. Avanza `okStreak` solo per run `schedule` e chiude
 * la issue quando arriva a `LOOP_OK_STREAK`; sotto soglia aggiorna il
 * contatore nel corpo senza commentare. Non lancia mai: un verdetto ok non
 * diventa rosso per una scrittura di contabilità, e lo streak non avanzato
 * fa ritentare la run successiva.
 */
export async function resolveLoopIssue(params = {}, deps = {}) {
  const {
    loopId = null,
    loopTitles = [],
    workflow,
    runUrl: explicitRunUrl = null,
    eventName: explicitEvent = null,
  } = params;
  const ctx = context(deps);
  if (ctx.env.ENABLE_FAILURE_REPORT === 'false') return null;
  const event = explicitEvent ?? ctx.env.GITHUB_EVENT_NAME ?? null;
  const outcome = { advanced: [], closed: [], persisted: true, event };
  if (event !== SCHEDULE_EVENT) return { ...outcome, skipped: 'event-is-not-schedule' };

  const runUrl = explicitRunUrl ?? runUrlFromEnv(ctx.env);
  for (const title of uniqueTitles(null, loopTitles)) {
    const open = findOpenIssues(ctx, title);
    if (open === null) {
      outcome.persisted = false;
      continue;
    }
    const issue = open[0];
    if (!issue) continue;
    const previous = parseLoopState(issue.body);
    const okStreak = (previous?.okStreak ?? 0) + 1;
    // Uscita da `awaiting-sample` verso ok: il `keep-open` messo dalla
    // libreria cade, così la issue torna instradabile se il loop si rompe.
    const plan = pinPlan({ labels: labelNames(issue), previous, loopState: LOOP_STATE_OK });
    if (okStreak >= LOOP_OK_STREAK) {
      if (plan.remove.length && !write(ctx, ['issue', 'edit', String(issue.number), ...labelArgs(plan)], `rimozione del pin da #${issue.number}`)) {
        outcome.persisted = false;
        continue;
      }
      try {
        const closed = await ctx.resolveIssue(title, { workflow, runUrl, exactTitle: true });
        if (closed?.persisted === true) outcome.closed.push(closed.number ?? issue.number);
        else outcome.persisted = false;
      } catch (error) {
        ctx.logger.error(`[loop-fleet-issue] chiusura di #${issue.number} non riuscita: ${error.message}`);
        outcome.persisted = false;
      }
      continue;
    }
    const written = editBody(ctx, issue.number, upsertLoopStateBlock(issue.body, {
      loopId: loopId ?? previous?.loopId ?? null,
      ok: true,
      reason: `verdetto ok (${okStreak} di ${LOOP_OK_STREAK}); la issue resta aperta fino al terzo consecutivo`,
      signature: previous?.signature ?? null,
      okStreak,
      pinnedByLoopLib: plan.pinnedByLoopLib,
      runUrl,
      event,
      updatedAt: ctx.now().toISOString(),
    }), labelArgs(plan));
    if (written) outcome.advanced.push({ number: issue.number, okStreak });
    else outcome.persisted = false;
  }
  return outcome;
}
