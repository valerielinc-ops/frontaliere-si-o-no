#!/usr/bin/env node
/**
 * Contratto provider-neutral per il fallback Claude → Codex.
 *
 * Questo modulo decide SOLTANTO quando il fallback e' autorizzato e come
 * descrivere la sua evidenza. L'autenticazione e l'invocazione del provider
 * restano a carico del workflow/action ufficiale: non leggere token qui e non
 * chiamare direttamente una CLI.
 *
 * Le due condizioni ammesse sono intenzionalmente strette:
 *   - beacon di quota attivo osservato dal preflight;
 *   - usage-limit/HTTP 429 esplicito nell'execution file Claude.
 *
 * 529, error_max_turns e failure generici non sono quota e non autorizzano il
 * fallback. `alreadyAttempted` rende la decisione one-shot per run.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { detectClaudeRateLimit } from './claude-rate-limit.mjs';

/** Modello e reasoning effort vincolanti per l'esecuzione di fallback. */
export const CODEX_FALLBACK_MODEL = 'gpt-5.6-luna';
export const CODEX_FALLBACK_EFFORT = 'max';
// Passato a `codex exec` come argomento esplicito: impedisce al modello di
// inoltrare le variabili di ambiente escluse per default (in particolare
// *TOKEN/*SECRET) ai comandi shell generati.
export const CODEX_FALLBACK_ARGS = '--ephemeral -c shell_environment_policy.ignore_default_excludes=false';

export const FALLBACK_TRIGGER = Object.freeze({
  PREFLIGHT_QUOTA: 'preflight-quota',
  RUNTIME_429: 'runtime-429',
});

export const FALLBACK_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
});

const EVIDENCE_PREFIX = '<!-- CODEX_FALLBACK_EVIDENCE: ';
const EVIDENCE_SUFFIX = ' -->';

/**
 * Decide se una singola run puo' invocare il fallback.
 *
 * @param {{preflightBlocked?: boolean|string, executionRaw?: string, alreadyAttempted?: boolean}} input
 * @returns {{shouldFallback: boolean, trigger: string|null, resetsAt: number|null, rateLimitType: string|null, reason: string}}
 */
export function decideClaudeCodexFallback({
  preflightBlocked = false,
  executionRaw = '',
  alreadyAttempted = false,
} = {}) {
  if (alreadyAttempted) {
    return {
      shouldFallback: false,
      trigger: null,
      resetsAt: null,
      rateLimitType: null,
      reason: 'one-shot-consumed',
    };
  }

  if (preflightBlocked === true || preflightBlocked === 'true') {
    return {
      shouldFallback: true,
      trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
      resetsAt: null,
      rateLimitType: null,
      reason: 'preflight-quota',
    };
  }

  const runtime = detectClaudeRateLimit(executionRaw);
  if (runtime.rateLimited) {
    return {
      shouldFallback: true,
      trigger: FALLBACK_TRIGGER.RUNTIME_429,
      resetsAt: runtime.resetsAt,
      rateLimitType: runtime.rateLimitType,
      reason: 'runtime-429',
    };
  }

  return {
    shouldFallback: false,
    trigger: null,
    resetsAt: null,
    rateLimitType: null,
    reason: 'claude-terminal-without-usage-limit',
  };
}

/**
 * Evidenza machine-readable da allegare al marker/summary del workflow.
 * Il gate deve validare questo oggetto, non cercare parole nel testo libero.
 *
 * @param {{trigger: string, status: string, detail?: string}} input
 * @returns {string}
 */
export function formatCodexFallbackEvidence({ trigger, status, detail = '' }) {
  if (!Object.values(FALLBACK_TRIGGER).includes(trigger)) {
    throw new Error(`trigger fallback non valido: ${String(trigger)}`);
  }
  if (!Object.values(FALLBACK_STATUS).includes(status)) {
    throw new Error(`status fallback non valido: ${String(status)}`);
  }

  const payload = {
    provider: 'codex',
    model: CODEX_FALLBACK_MODEL,
    effort: CODEX_FALLBACK_EFFORT,
    trigger,
    status,
  };
  if (detail) payload.detail = String(detail).slice(0, 500);
  return `${EVIDENCE_PREFIX}${JSON.stringify(payload)}${EVIDENCE_SUFFIX}`;
}

/**
 * Scrive l'evidenza su un file di run effimero. Il file contiene soltanto il
 * marker strutturato: non include prompt, output del modello o autenticazione.
 * @param {{trigger: string, status: string, detail?: string, file: string}} input
 * @returns {string}
 */
export function writeCodexFallbackEvidence({ trigger, status, detail = '', file }) {
  if (!file || typeof file !== 'string') throw new Error('file evidenza mancante');
  const marker = formatCodexFallbackEvidence({ trigger, status, detail });
  fs.writeFileSync(file, `${marker}\n`, { encoding: 'utf8', mode: 0o600 });
  return marker;
}

/**
 * Parsa e valida una sola evidenza Codex. Input non attendibile => null.
 * @param {string} body
 * @returns {{provider: 'codex', model: string, effort: string, trigger: string, status: string, detail?: string}|null}
 */
export function parseCodexFallbackEvidence(body) {
  const text = String(body || '');
  const start = text.indexOf(EVIDENCE_PREFIX);
  if (start < 0) return null;
  const end = text.indexOf(EVIDENCE_SUFFIX, start + EVIDENCE_PREFIX.length);
  if (end < 0) return null;

  let payload;
  try {
    payload = JSON.parse(text.slice(start + EVIDENCE_PREFIX.length, end));
  } catch {
    return null;
  }
  return isValidCodexFallbackEvidence(payload) ? payload : null;
}

/**
 * Valida anche un oggetto già deserializzato, come quello passato dal runner
 * al review gate. Non basta controllare `status=success`: modello, effort,
 * provider e trigger fanno parte del contratto e restano vincolati ai valori
 * emessi da questo modulo.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCodexFallbackEvidence(value) {
  if (!value || typeof value !== 'object') return false;
  const payload = /** @type {Record<string, unknown>} */ (value);
  if (payload.provider !== 'codex') return false;
  if (payload.model !== CODEX_FALLBACK_MODEL || payload.effort !== CODEX_FALLBACK_EFFORT) return false;
  if (!Object.values(FALLBACK_TRIGGER).includes(payload.trigger)) return false;
  if (!Object.values(FALLBACK_STATUS).includes(payload.status)) return false;
  if ('detail' in payload && typeof payload.detail !== 'string') return false;
  return true;
}

/**
 * Esito consumabile dal review gate: richiede un'esecuzione Codex riuscita e
 * il contratto esatto di modello/effort. Un successo non diventa mai
 * `rate-limited` o `refunded`.
 *
 * @param {string} body
 */
export function hasSuccessfulCodexFallbackEvidence(body) {
  return parseCodexFallbackEvidence(body)?.status === FALLBACK_STATUS.SUCCESS;
}

/**
 * Classificazione terminale per telemetria. Il rate-limit descrive solo il
 * provider Claude che ha innescato il fallback; non viene propagato a una
 * run Codex riuscita.
 *
 * @param {{status: string}} input
 */
export function classifyCodexFallbackOutcome({ status } = {}) {
  return status === FALLBACK_STATUS.SUCCESS ? 'codex-success' : 'codex-failure';
}

/**
 * CLI minima per gli step provider-neutral: legge EXEC_FILE e PREflight_BLOCKED
 * e pubblica decisione + costanti su GITHUB_OUTPUT. Non effettua side effect.
 */
function main() {
  const raw = process.env.EXEC_FILE && fs.existsSync(process.env.EXEC_FILE)
    ? fs.readFileSync(process.env.EXEC_FILE, 'utf8')
    : '';
  const decision = decideClaudeCodexFallback({
    preflightBlocked: process.env.PREFLIGHT_BLOCKED || false,
    executionRaw: raw,
    alreadyAttempted: process.env.FALLBACK_ATTEMPTED === 'true',
  });
  const output = [
    `fallback=${decision.shouldFallback}`,
    `trigger=${decision.trigger || ''}`,
    `reason=${decision.reason}`,
    `model=${CODEX_FALLBACK_MODEL}`,
    `effort=${CODEX_FALLBACK_EFFORT}`,
    `args=${CODEX_FALLBACK_ARGS}`,
    `rate_limited=${decision.trigger === FALLBACK_TRIGGER.RUNTIME_429}`,
    `resets_at=${decision.resetsAt || ''}`,
  ].join('\n') + '\n';
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);

  // Il composite action chiama lo stesso modulo nel passo di finalizzazione.
  // Tenere il writer qui evita che la shell ricostruisca JSON con quoting
  // fragile e rende il contratto verificabile anche senza una run Actions.
  if (process.env.EVIDENCE_FILE && decision.shouldFallback) {
    writeCodexFallbackEvidence({
      file: process.env.EVIDENCE_FILE,
      trigger: decision.trigger,
      status: process.env.FALLBACK_STATUS || FALLBACK_STATUS.FAILURE,
      detail: process.env.FALLBACK_DETAIL || decision.reason,
    });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
