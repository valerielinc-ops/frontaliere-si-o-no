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
    };
  } catch {
    return null;
  }
}

function oneLine(value, max = MAX_REASON_LEN) {
  const flat = String(value ?? '').replace(/\s+/gu, ' ').replace(/--+>/gu, '→').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Rende il blocco di stato. La riga `data` è la parte letta dalle macchine. */
export function renderLoopStateBlock(state) {
  const data = {
    v: 1,
    loopId: state.loopId ?? null,
    signature: state.signature ?? null,
    okStreak: state.okStreak ?? 0,
    updatedAt: state.updatedAt ?? null,
    event: state.event ?? null,
  };
  const lines = [
    LOOP_STATE_START,
    `**Stato corrente del loop${state.loopId ? ` ${state.loopId}` : ''}** (riscritto a ogni run; la cronologia sotto resta com'era all'apertura)`,
    '',
    `- Verdetto: ${state.ok ? 'ok' : 'non ok'}`,
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
 * Riporta un verdetto NON ok. Stessi parametri e stesso ritorno di
 * `createGithubIssue`, più `loopId`, `reason` e `loopTitles` (tutti i titoli
 * che quel loop può emettere). `persisted: true` solo se ogni scrittura è
 * riuscita; con una scrittura fallita la firma nel corpo non avanza, così la
 * run successiva ritenta invece di tacere.
 */
export async function reportLoopIssue(params = {}, deps = {}) {
  const {
    loopId = null,
    reason = '',
    loopTitles = [],
    runUrl: explicitRunUrl = null,
    eventName: explicitEvent = null,
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

  const signature = reasonSignature(reason);
  const state = {
    loopId,
    ok: false,
    reason,
    signature,
    okStreak: 0,
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
    let persisted = true;
    if (signatureChanged) {
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
        upsertLoopStateBlock(existing.body, state),
        labelNames(existing).includes(MAYBE_RESOLVED_LABEL)
          ? ['--remove-label', MAYBE_RESOLVED_LABEL]
          : [],
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
  } else {
    result = await ctx.createIssue({
      ...issueParams,
      description: [renderLoopStateBlock(state), description].filter(Boolean).join('\n\n'),
    });
    // Il creator può aver riaperto o commentato una issue che il lookup sopra
    // non vedeva (indice di ricerca in ritardo, gemella chiusa da poco): il suo
    // corpo porta ancora lo stato vecchio, `okStreak` compreso.
    if (result?.persisted === true && result.number && !result.ledger) {
      result = {
        ...result,
        persisted: reconcileCreatedIssue(ctx, result.number, state, { reopened: result.reopened === true }),
      };
    }
  }

  if (result?.persisted === true && result.number) {
    for (const other of uniqueTitles(title, loopTitles).filter((candidate) => candidate !== title)) {
      const stale = findOpenIssues(ctx, other);
      if (stale === null) {
        result = { ...result, persisted: false };
        continue;
      }
      for (const issue of stale) {
        const closed = write(ctx, [
          'issue', 'close', String(issue.number),
          '--reason', 'not planned',
          '--comment', `Il loop${loopId ? ` ${loopId}` : ''} ora riporta un'altra classe di problema: lo stato corrente è in #${result.number}. Chiusa per tenere una sola issue aperta per loop.`,
        ], `chiusura di #${issue.number} (titolo superato)`);
        if (!closed) result = { ...result, persisted: false };
      }
    }
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
  const stale = labelNames(issue).includes(MAYBE_RESOLVED_LABEL);
  if (current?.signature === state.signature && current.okStreak === 0 && !stale) return true;
  return editBody(
    ctx,
    number,
    upsertLoopStateBlock(issue?.body, state),
    stale ? ['--remove-label', MAYBE_RESOLVED_LABEL] : [],
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
    if (okStreak >= LOOP_OK_STREAK) {
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
      runUrl,
      event,
      updatedAt: ctx.now().toISOString(),
    }));
    if (written) outcome.advanced.push({ number: issue.number, okStreak });
    else outcome.persisted = false;
  }
  return outcome;
}
