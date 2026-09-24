#!/usr/bin/env node
/**
 * codex-auth-rotate.mjs — tiene sempre fresco il login ChatGPT in `CODEX_AUTH_JSON`.
 *
 * Il problema (incidente del 2026-09-21, run 35577718786). `CODEX_AUTH_JSON` è lo snapshot di
 * un login ChatGPT della Codex CLI: `tokens.{id_token,access_token,refresh_token,
 * account_id}` + `last_refresh`. Il refresh token è monouso e ruota a ogni
 * refresh. Ogni consumer (claude-codex-fallback, broker di
 * setup-claude-haiku-fallback, repo frontaliere-articles) scrive lo snapshot in
 * un CODEX_HOME effimero: il primo job che deve rinfrescare consuma il refresh
 * token e butta i token nuovi col runner; tutti i job successivi falliscono con
 * `refresh_token_reused` finché qualcuno non rifà il login.
 *
 * La regola della CLI (codex-rs @ rust-v0.153.4, commit 3d2ee51c, la versione
 * installata dalle action):
 *   - login/src/auth/manager.rs:2924 `should_refresh_proactively`, chiamata da
 *     `AuthManager::auth()` (:2345) a ogni accesso all'auth: se `access_token`
 *     è un JWT con `exp` → refresh quando `exp <= now + 5 min`
 *     (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`, :189); solo se `exp` non
 *     è leggibile → refresh quando `last_refresh < now - 8 giorni`
 *     (`TOKEN_REFRESH_INTERVAL`, :188); senza nessuno dei due, mai in anticipo.
 *   - In più il percorso reattivo `UnauthorizedRecovery` (:2003): un 401 dal
 *     backend → reload → refresh.
 *   - Il refresh (`request_chatgpt_token_refresh`, :1583) è una POST JSON
 *     `{client_id, grant_type: "refresh_token", refresh_token}` a
 *     `https://auth.openai.com/oauth/token` (:197, override
 *     `CODEX_REFRESH_TOKEN_URL_OVERRIDE` :199) con `client_id`
 *     `app_EMoamEEZ73f0CkXaXp7hrann` (:1708); `persist_tokens` (:1556) salva i
 *     token nuovi e `last_refresh = now` nell'auth.json del CODEX_HOME.
 *     401 / `refresh_token_reused|expired|invalidated` / `invalid_grant` sono
 *     errori permanenti.
 *
 * Quindi: se lo snapshot salvato ha sempre `exp` lontano, nessun consumer
 * rinfresca mai. Questo script (workflow `codex-auth-rotate.yml`) decide quando
 * rinfrescare con margine (`refreshDecision`), fa il refresh con la CLI pinnata
 * stessa e riscrive il segreto in tutti i repo target.
 *
 * Il meccanismo di refresh è la CLI, non una POST scritta a mano:
 * `codex app-server` + richiesta JSON-RPC `account/read {refreshToken: true}`
 * (app-server-protocol/src/protocol/v2/account.rs:531) →
 * `refresh_token_if_requested` (app-server/src/request_processors/
 * account_processor.rs:1019) → `AuthManager::refresh_token()` (manager.rs:2768):
 * reload protetto e poi il refresh dall'authority, senza condizioni di età. È
 * lo stesso codice, lo stesso client HTTP e la stessa persistenza che usano i
 * consumer. Il processo gira ermetico: CODEX_HOME temporaneo, env minimo (mai i
 * token di scrittura), `chatgpt_base_url` e ogni proxy puntati a un sink locale,
 * quindi l'unico host raggiungibile è l'authority dei token.
 *
 * Copia per le Cloud Functions (`write-remote-config`). Il rung Codex di
 * functions/src/codexFallback.js si autentica con lo stesso login, letto dal
 * parametro Remote Config `CODEX_AUTH_JSON`, e non rinfresca mai. Dopo il
 * refresh validato (o in `sync`) questo script scrive lì il login SENZA
 * `refresh_token` (`remoteConfigLogin`): alla function servono solo access
 * token e account, e senza refresh token nessun lettore del template può
 * consumare quello della CI. Scrittura con ETag (`setRcParamWithEtag`, mai
 * `If-Match: *`), dopo i secret GitHub. Il parametro resta fuori da
 * `RC_TO_ENV` (scripts/load-rc-env.mjs): la CI legge solo il secret GitHub.
 *
 * Sicurezza: nessun token viene mai stampato. Ogni valore di token riceve un
 * `::add-mask::` prima di qualsiasi altro output; stdout/stderr della CLI non
 * vengono mai inoltrati al log (se ne estrae solo il codice d'errore).
 *
 *   node scripts/ci/codex-auth-rotate.mjs <plan|rehearse|preflight|refresh|write|write-remote-config|summarize|report>
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';
import { intFromEnv } from '../lib/int-from-env.mjs';
import { setRcParamWithEtag } from '../lib/remote-config-admin.mjs';

const HOUR_MS = 3_600_000;

/** Deve restare uguale al pin di claude-codex-fallback e setup-claude-haiku-fallback (test di parità). */
export const CODEX_CLI_VERSION = '0.153.4';
/** manager.rs:1708 — usato solo per verificare il contratto nella prova generale. */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** manager.rs:197 — l'unico host che il refresh reale può raggiungere. */
export const CODEX_TOKEN_AUTHORITY_HOST = 'auth.openai.com';
/** manager.rs:189 — la CLI rinfresca quando `exp <= now + 5 min`. */
export const CLI_REFRESH_WINDOW_MS = 5 * 60_000;
/** manager.rs:188 — fallback quando `access_token.exp` non è leggibile. */
export const CLI_FALLBACK_INTERVAL_MS = 8 * 24 * HOUR_MS;
/** Cron del workflow: ogni 6 ore. */
export const SCHEDULE_INTERVAL_HOURS = 6;
/** Il job consumer più lungo (issue-fix, step cap 120 min) più margine. */
export const MIN_ALLOWED_VALID_HOURS = 3;

/**
 * - marginHours: ruota quando la CLI rinfrescherebbe entro questo margine.
 * - maxAgeHours: ruota comunque quando `last_refresh` è più vecchio (metà
 *   dell'intervallo di fallback della CLI): il refresh token resta esercitato.
 * - minValidHours: garanzia minima per ogni consumer. Dopo il refresh il login
 *   nuovo deve restare valido almeno così a lungo, altrimenti la durata del
 *   token è troppo corta per questo schema (errore, dopo la scrittura).
 */
export const DEFAULT_POLICY = Object.freeze({ marginHours: 48, maxAgeHours: 96, minValidHours: 12 });

export const SECRET_NAME = 'CODEX_AUTH_JSON';
/** Parametro Remote Config letto da functions/src/codexFallback.js. */
export const REMOTE_CONFIG_PARAM = 'CODEX_AUTH_JSON';
export const DEFAULT_TARGETS = Object.freeze([
  'valerielinc-ops/frontaliere-si-o-no',
  'nanakokyobashi-rgb/frontaliere-articles',
]);
export const DEFAULT_WRITER_TOKEN_ENV = 'CODEX_SECRET_WRITER_TOKEN';
/** Esattamente CODEX_AUTH_ALERT_TITLE di codex-auth-recovery.yml: stesso alert deduplicato. */
export const ALERT_TITLE = 'Codex auth down: CODEX_AUTH_JSON refresh token rejected';
export const ROTATION_MARKER_PREFIX = '<!-- CODEX_AUTH_ROTATION:';
/** Scritto da claude-codex-fallback quando un job senza PR vede il login rifiutato. */
export const BLOCKED_RUN_MARKER_PREFIX = '<!-- CODEX_AUTH_BLOCKED_RUN:';
export const BOT_LOGIN_RE = /^(?:github-actions|frontaliere-automation)\[bot\]$/iu;
export const PERMANENT_REFRESH_FAILURES = new Set([
  'refresh_token_reused',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'invalid_grant',
]);

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const STAGE_RE = /^[a-z][a-z-]{0,39}$/u;
const CLOCK_SKEW_MS = 5 * 60_000;

// ─── JWT e auth.json (puri) ─────────────────────────────────────────────────

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Payload di un JWT, senza verificarne la firma: la CLI fa lo stesso (token_data.rs `decode_jwt_payload`). */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isPlainObject(claims) ? claims : null;
  } catch {
    return null;
  }
}

function jwtSecondsClaimMs(token, claim) {
  const value = decodeJwtPayload(token)?.[claim];
  return Number.isSafeInteger(value) ? value * 1000 : null;
}

export const jwtExpiryMs = (token) => jwtSecondsClaimMs(token, 'exp');

function chatgptAccountIdClaim(idToken) {
  const auth = decodeJwtPayload(idToken)?.['https://api.openai.com/auth'];
  return isPlainObject(auth) && typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null;
}

export function parseTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Un token deve stare su una sola riga ASCII stampabile: è la condizione per
 * poterlo mascherare con `::add-mask::` (un a-capo spezzerebbe il comando).
 */
export function isMaskableToken(value) {
  return typeof value === 'string' && value.length >= 8 && /^[\x21-\x7E]+$/u.test(value);
}

/**
 * Valida la forma di un auth.json di login ChatGPT gestito dalla CLI. I
 * messaggi non contengono mai valori, solo nomi di campo.
 */
export function parseAuthJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return { auth: null, errors: ['empty'] };
  let auth;
  try {
    auth = JSON.parse(text);
  } catch {
    return { auth: null, errors: ['not valid JSON'] };
  }
  if (!isPlainObject(auth)) return { auth: null, errors: ['not a JSON object'] };
  const errors = [];
  if (auth.auth_mode != null && auth.auth_mode !== 'chatgpt') {
    errors.push('auth_mode is not a Codex-managed ChatGPT login');
  }
  if (auth.OPENAI_API_KEY != null) errors.push('OPENAI_API_KEY is set (API-key login, nothing to refresh)');
  const tokens = auth.tokens;
  if (!isPlainObject(tokens)) {
    errors.push('tokens missing');
  } else {
    for (const key of ['id_token', 'access_token', 'refresh_token']) {
      if (!isMaskableToken(tokens[key])) errors.push(`tokens.${key} missing or not a single-line token`);
    }
    // La CLI rifiuta l'intero file se id_token non è un JWT (token_data.rs `deserialize_id_token`).
    if (isMaskableToken(tokens.id_token) && !decodeJwtPayload(tokens.id_token)) {
      errors.push('tokens.id_token is not a decodable JWT');
    }
    if (typeof tokens.account_id !== 'string' || !tokens.account_id.trim()) errors.push('tokens.account_id missing');
  }
  if (auth.last_refresh != null && parseTimestamp(auth.last_refresh) === null) {
    errors.push('last_refresh is not a timestamp');
  }
  return { auth: errors.length === 0 ? auth : null, errors };
}

export function secretDigest(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Stato del login secondo la regola della CLI (vedi header). */
export function describeLogin(auth, now) {
  const accessToken = auth?.tokens?.access_token;
  const expiresAt = jwtExpiryMs(accessToken);
  const issuedAt = jwtSecondsClaimMs(accessToken, 'iat');
  const lastRefreshAt = parseTimestamp(auth?.last_refresh);
  let cliRule = 'none';
  let cliDueAt = null;
  if (expiresAt !== null) {
    cliRule = 'access_token.exp';
    cliDueAt = expiresAt - CLI_REFRESH_WINDOW_MS;
  } else if (lastRefreshAt !== null) {
    cliRule = 'last_refresh+8d';
    cliDueAt = lastRefreshAt + CLI_FALLBACK_INTERVAL_MS;
  }
  return {
    expiresAt,
    issuedAt,
    lastRefreshAt,
    cliRule,
    cliDueAt,
    hoursUntilCliRefresh: cliDueAt === null ? null : (cliDueAt - now) / HOUR_MS,
    ageHours: lastRefreshAt === null ? null : (now - lastRefreshAt) / HOUR_MS,
    lifetimeHours: expiresAt !== null && issuedAt !== null ? (expiresAt - issuedAt) / HOUR_MS : null,
  };
}

/** Politica da env, con i vincoli che rendono la garanzia raggiungibile. */
export function parsePolicy(env = {}) {
  const read = (name, fallback) => {
    const raw = String(env[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : NaN;
  };
  const policy = {
    marginHours: read('CODEX_AUTH_REFRESH_MARGIN_HOURS', DEFAULT_POLICY.marginHours),
    maxAgeHours: read('CODEX_AUTH_MAX_AGE_HOURS', DEFAULT_POLICY.maxAgeHours),
    minValidHours: read('CODEX_AUTH_MIN_VALID_HOURS', DEFAULT_POLICY.minValidHours),
  };
  const errors = [];
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value <= 0) errors.push(`${key} must be a positive number`);
  }
  if (errors.length === 0) {
    if (policy.minValidHours < MIN_ALLOWED_VALID_HOURS) {
      errors.push(`minValidHours must be >= ${MIN_ALLOWED_VALID_HOURS} (longest Codex consumer job)`);
    }
    // Fra due run il login invecchia di un intervallo di cron: il margine deve
    // coprirlo, altrimenti il login salvato scende sotto la garanzia prima
    // della rotazione successiva.
    if (policy.marginHours < policy.minValidHours + SCHEDULE_INTERVAL_HOURS) {
      errors.push(`marginHours must be >= minValidHours + ${SCHEDULE_INTERVAL_HOURS} (schedule interval)`);
    }
    if (policy.maxAgeHours * HOUR_MS >= CLI_FALLBACK_INTERVAL_MS) {
      errors.push('maxAgeHours must stay below the CLI 8-day fallback interval');
    }
  }
  return { policy: errors.length === 0 ? policy : null, errors };
}

/** Il login salvato va ruotato adesso? */
export function refreshDecision(auth, { now, force = false, policy = DEFAULT_POLICY }) {
  const login = describeLogin(auth, now);
  const reasons = [];
  if (force) reasons.push('forced');
  if (login.cliDueAt !== null) {
    if (login.cliDueAt <= now) reasons.push('cli-refresh-overdue');
    else if (login.cliDueAt - now < policy.marginHours * HOUR_MS) reasons.push('cli-refresh-within-margin');
  }
  if (login.lastRefreshAt === null) reasons.push('last-refresh-missing');
  else if (now - login.lastRefreshAt >= policy.maxAgeHours * HOUR_MS) reasons.push('last-refresh-older-than-max-age');
  return { due: reasons.length > 0, reasons, login };
}

/**
 * Valida l'auth.json scritto dalla CLI prima di pubblicarlo. Blocca la
 * scrittura solo ciò che rende il file inutilizzabile o estraneo: forma,
 * account diverso, nessun refresh avvenuto in questa run.
 */
export function validateRotation(before, afterText, { startedAt, now, minValidHours = DEFAULT_POLICY.minValidHours }) {
  const { auth: after, errors: shapeErrors } = parseAuthJson(afterText);
  if (!after) return { ok: false, errors: shapeErrors.map((error) => `new auth.json: ${error}`), after: null };
  const errors = [];
  if (after.tokens.account_id !== before.tokens.account_id) errors.push('tokens.account_id changed');
  const beforeClaim = chatgptAccountIdClaim(before.tokens.id_token);
  if (beforeClaim !== null && chatgptAccountIdClaim(after.tokens.id_token) !== beforeClaim) {
    errors.push('id_token chatgpt_account_id changed');
  }
  const beforeRefresh = parseTimestamp(before.last_refresh);
  const afterRefresh = parseTimestamp(after.last_refresh);
  if (afterRefresh === null) {
    errors.push('last_refresh missing');
  } else {
    if (beforeRefresh !== null && afterRefresh <= beforeRefresh) errors.push('last_refresh did not advance');
    if (afterRefresh < startedAt - CLOCK_SKEW_MS) errors.push('last_refresh predates this refresh');
    if (afterRefresh > now + CLOCK_SKEW_MS) errors.push('last_refresh is in the future');
  }
  const afterLogin = describeLogin(after, now);
  if (afterLogin.expiresAt !== null && afterLogin.expiresAt <= now) errors.push('new access_token already expired');
  return {
    ok: errors.length === 0,
    errors,
    after,
    afterLogin,
    accessTokenRotated: after.tokens.access_token !== before.tokens.access_token,
    refreshTokenRotated: after.tokens.refresh_token !== before.tokens.refresh_token,
    lifetimeShort: afterLogin.hoursUntilCliRefresh !== null && afterLogin.hoursUntilCliRefresh < minValidHours,
  };
}

/** Il valore di un comando di workflow va escapato (%, CR, LF). */
export function escapeCommandValue(value) {
  return String(value).replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A');
}

/** Un `::add-mask::` per ogni valore di token (e l'account id) dell'auth.json. */
export function maskCommands(auth) {
  const tokens = isPlainObject(auth?.tokens) ? auth.tokens : {};
  const values = [tokens.id_token, tokens.access_token, tokens.refresh_token, tokens.account_id]
    .filter((value) => typeof value === 'string' && value.length > 0);
  return [...new Set(values)].map((value) => `::add-mask::${escapeCommandValue(value)}`);
}

/**
 * La copia del login per Remote Config: stesso formato auth.json, senza
 * `refresh_token` (e senza OPENAI_API_KEY). functions/src/codexFallback.js usa
 * solo access_token, account_id e il claim FedRAMP dell'id_token; il refresh
 * token servirebbe solo a rinfrescare, cosa che lì non deve accadere mai.
 */
export function remoteConfigLogin(auth) {
  const { id_token: idToken, access_token: accessToken, account_id: accountId } = auth.tokens;
  return JSON.stringify({
    ...(auth.auth_mode != null ? { auth_mode: auth.auth_mode } : {}),
    tokens: { id_token: idToken, access_token: accessToken, account_id: accountId },
    ...(auth.last_refresh != null ? { last_refresh: auth.last_refresh } : {}),
  });
}

// ─── Target e token di scrittura (puri) ─────────────────────────────────────

/**
 * Lista target da env/input: separatori spazio, virgola o a-capo; vuota →
 * DEFAULT_TARGETS. Il repo sorgente (quello che legge il segreto per ruotarlo)
 * è obbligatorio e va per primo: se la rotazione non riscrivesse la sorgente,
 * la run successiva ripartirebbe dal refresh token già consumato.
 */
export function parseTargets(raw, { sourceRepo }) {
  const items = String(raw ?? '').split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean);
  const list = items.length > 0 ? items : [...DEFAULT_TARGETS];
  const errors = [];
  const seen = new Map();
  for (const item of list) {
    if (!REPO_RE.test(item) || /\/\.{1,2}$/u.test(item)) {
      errors.push(`invalid target ${JSON.stringify(item.slice(0, 120))} (expected owner/repo)`);
      continue;
    }
    if (!seen.has(item.toLowerCase())) seen.set(item.toLowerCase(), item);
  }
  const source = String(sourceRepo ?? '');
  if (!REPO_RE.test(source)) errors.push('source repository is unknown');
  else if (!seen.has(source.toLowerCase())) {
    errors.push(`the target list must include the source repository ${source}`);
  }
  if (errors.length > 0) return { targets: [], errors };
  const primary = seen.get(source.toLowerCase());
  return { targets: [primary, ...[...seen.values()].filter((target) => target !== primary)], errors };
}

/**
 * I segreti Actions di un repo di account personale li gestisce solo il
 * proprietario, e un fine-grained PAT ha un solo resource owner: serve quindi
 * un token per owner. Owner del repo sorgente → CODEX_SECRET_WRITER_TOKEN;
 * altri owner → CODEX_SECRET_WRITER_TOKEN_<OWNER> (es. _NANAKOKYOBASHI_RGB).
 */
export function writerTokenEnvName(owner, sourceOwner) {
  if (String(owner).toLowerCase() === String(sourceOwner).toLowerCase()) return DEFAULT_WRITER_TOKEN_ENV;
  return `${DEFAULT_WRITER_TOKEN_ENV}_${String(owner).toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`;
}

export function resolveWriterToken(target, sourceRepo, env = {}) {
  const name = writerTokenEnvName(target.split('/')[0], String(sourceRepo).split('/')[0]);
  const own = String(env[name] ?? '').trim();
  if (own) return { name, usedName: name, token: own };
  // Un unico token che amministra più owner (es. repo spostati in una org) resta ammesso.
  const fallback = String(env[DEFAULT_WRITER_TOKEN_ENV] ?? '').trim();
  if (name !== DEFAULT_WRITER_TOKEN_ENV && fallback) return { name, usedName: DEFAULT_WRITER_TOKEN_ENV, token: fallback };
  return { name, usedName: null, token: '' };
}

// ─── Marker dell'alert (puri) ───────────────────────────────────────────────

export function validRotationMarker(marker) {
  return isPlainObject(marker)
    && marker.version === 1
    && (marker.status === 'failed' || marker.status === 'succeeded')
    && typeof marker.stage === 'string' && STAGE_RE.test(marker.stage)
    && Number.isSafeInteger(marker.runId) && marker.runId > 0
    && Number.isSafeInteger(marker.runAttempt) && marker.runAttempt > 0
    && (marker.authDigest === 'missing' || DIGEST_RE.test(String(marker.authDigest)))
    && (marker.consumed === undefined || typeof marker.consumed === 'boolean')
    && (marker.pendingTargets === undefined
      || (Array.isArray(marker.pendingTargets) && marker.pendingTargets.every((target) => REPO_RE.test(String(target)))));
}

export function formatRotationMarker(marker) {
  return `${ROTATION_MARKER_PREFIX} ${JSON.stringify(marker)} -->`;
}

export function extractRotationMarkers(body) {
  const text = String(body ?? '');
  const markers = [];
  let index = text.indexOf(ROTATION_MARKER_PREFIX);
  while (index >= 0) {
    const start = text.indexOf('{', index + ROTATION_MARKER_PREFIX.length);
    const end = text.indexOf('-->', start + 1);
    if (start < 0 || end < 0) break;
    try {
      const marker = JSON.parse(text.slice(start, end).trim());
      if (validRotationMarker(marker)) markers.push(marker);
    } catch {
      // marker illeggibile: ignorato, come in codex-auth-recovery
    }
    index = text.indexOf(ROTATION_MARKER_PREFIX, end);
  }
  return markers;
}

/** Digest dei login che un consumer ha visto rifiutare (marker CODEX_AUTH_BLOCKED_RUN). */
export function rejectedDigests(entries) {
  const digests = new Set();
  for (const entry of entries ?? []) {
    if (!BOT_LOGIN_RE.test(String(entry?.user?.login ?? ''))) continue;
    const text = String(entry?.body ?? '');
    let index = text.indexOf(BLOCKED_RUN_MARKER_PREFIX);
    while (index >= 0) {
      const start = text.indexOf('{', index + BLOCKED_RUN_MARKER_PREFIX.length);
      const end = text.indexOf('-->', start + 1);
      if (start < 0 || end < 0) break;
      try {
        const marker = JSON.parse(text.slice(start, end).trim());
        if (marker?.version === 1 && marker.status === 'blocked' && DIGEST_RE.test(String(marker.authDigest))) {
          digests.add(marker.authDigest);
        }
      } catch {
        // ignorato
      }
      index = text.indexOf(BLOCKED_RUN_MARKER_PREFIX, end);
    }
  }
  return digests;
}

/** Ultimo marker valido, solo da identità di automazione, in ordine cronologico. */
export function latestRotationMarker(entries) {
  let latest = null;
  for (const entry of entries ?? []) {
    if (!BOT_LOGIN_RE.test(String(entry?.user?.login ?? ''))) continue;
    const markers = extractRotationMarkers(entry?.body);
    if (markers.length > 0) latest = markers.at(-1);
  }
  return latest;
}

/**
 * Azione della run. `blocked`: il login salvato ha già consumato il suo
 * refresh token in una run precedente (rifiutato, o rinfrescato ma non
 * riscritto nel repo sorgente) oppure un consumer lo ha visto rifiutare:
 * ripresentarlo è inutile e, con la reuse detection OAuth, rischia di revocare
 * l'intera famiglia di token. Serve un nuovo login. `sync`: login non in
 * scadenza ma una rotazione precedente ha lasciato target indietro → si
 * ripropaga il segreto corrente.
 */
export function planAction({ decision, latestMarker, currentDigest, rejected = new Set() }) {
  if (latestMarker?.status === 'failed' && latestMarker.consumed === true && latestMarker.authDigest === currentDigest) {
    return { action: 'blocked' };
  }
  if (rejected.has(currentDigest)) return { action: 'blocked' };
  if (decision.due) return { action: 'refresh' };
  if (latestMarker?.status === 'failed') return { action: 'sync' };
  return { action: 'none' };
}

// ─── Log della CLI (puro) ───────────────────────────────────────────────────

const REFRESH_MESSAGE_CODES = [
  [/already used/iu, 'refresh_token_reused'],
  [/has expired/iu, 'refresh_token_expired'],
  [/was revoked/iu, 'refresh_token_invalidated'],
];

/**
 * Dallo stderr della CLI (RUST_LOG `codex_login=info`) estrae solo quanti
 * refresh sono partiti e il codice d'errore: lo stderr non va mai nel log.
 */
export function classifyRefreshLog(stderr) {
  // eslint-disable-next-line no-control-regex
  const clean = String(stderr ?? '').replace(/\u001b\[[0-9;]*m/gu, '');
  const attempts = (clean.match(/codex_login::auth::manager: Refreshing token/gu) ?? []).length;
  const failure = /codex_login::auth::manager: Failed to refresh token: ([^\n]*)/u.exec(clean);
  if (!failure) return { attempts, failed: false, failureCode: null };
  const coded = /"code"\s*:\s*"([A-Za-z_]{1,64})"/u.exec(failure[1]) ?? /"error"\s*:\s*"([A-Za-z_]{1,64})"/u.exec(failure[1]);
  let failureCode = coded ? coded[1].toLowerCase() : null;
  if (!failureCode) failureCode = REFRESH_MESSAGE_CODES.find(([re]) => re.test(failure[1]))?.[1] ?? 'unknown';
  return { attempts, failed: true, failureCode };
}

// ─── Driver della CLI (I/O) ─────────────────────────────────────────────────

/**
 * Server locale che fa da sink per tutto il traffico non voluto: 404 su ogni
 * richiesta HTTP, 403 su ogni CONNECT (proxy). Con `onToken` risponde anche
 * all'endpoint dei token (solo prova generale). Registra metodo e path, mai i body.
 */
async function startSink({ onToken = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { if (body.length < 65_536) body += chunk; });
    req.on('end', () => {
      const pathname = String(req.url ?? '').split('?')[0];
      requests.push(`${req.method} ${pathname}`);
      if (onToken && req.method === 'POST' && pathname === '/oauth/token') {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        const { status, json } = onToken(parsed);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  server.on('connect', (req, socket) => {
    requests.push(`CONNECT ${String(req.url ?? '').split(':')[0]}`);
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* già uscito */ }
  }
}

/**
 * Fa rinfrescare il login alla CLI pinnata in un CODEX_HOME temporaneo e
 * restituisce l'auth.json risultante. Il criterio di successo NON è la
 * risposta JSON-RPC (account/read risponde anche quando il refresh fallisce):
 * è l'auth.json persistito dalla CLI, riletto SEMPRE, anche dopo un timeout,
 * perché un refresh avvenuto va pubblicato comunque.
 */
export async function runCliRefresh({ codexBin, authText, workDir, onToken = null, timeoutMs = 90_000 }) {
  const home = fs.mkdtempSync(path.join(workDir, 'codex-auth-rotate-home.'));
  fs.chmodSync(home, 0o700);
  const authPath = path.join(home, 'auth.json');
  fs.writeFileSync(authPath, authText, { mode: 0o600 });
  const sink = await startSink({ onToken });
  const noProxy = ['127.0.0.1', 'localhost', ...(onToken ? [] : [CODEX_TOKEN_AUTHORITY_HOST])].join(',');
  // Env costruito da zero: nessun token GitHub, nessun CODEX_AUTH_JSON, nessun
  // override ereditato. Tutto il traffico esce dal sink tranne l'authority.
  const env = {
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: home,
    CODEX_HOME: home,
    TMPDIR: home,
    RUST_LOG: 'warn,codex_login=info',
    NO_COLOR: '1',
    HTTPS_PROXY: sink.base,
    HTTP_PROXY: sink.base,
    ALL_PROXY: sink.base,
    https_proxy: sink.base,
    http_proxy: sink.base,
    all_proxy: sink.base,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...(onToken ? { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${sink.base}/oauth/token` } : {}),
  };
  const args = [
    'app-server',
    '-c', 'cli_auth_credentials_store="file"',
    '-c', `chatgpt_base_url="${sink.base}/backend-api/"`,
  ];
  const rpc = { initialized: false, accountRead: false, accountReadError: false };
  let stderr = '';
  let timedOut = false;
  let exit = { code: null, signal: null };
  try {
    const child = spawn(codexBin, args, { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const send = (message) => {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.stdin.on('error', () => {});
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id === 0) {
          rpc.initialized = Boolean(message.result);
          if (!rpc.initialized) { child.stdin.end(); continue; }
          send({ method: 'initialized' });
          send({ method: 'account/read', id: 1, params: { refreshToken: true } });
        } else if (message?.id === 1) {
          rpc.accountRead = Boolean(message.result);
          rpc.accountReadError = Boolean(message.error);
          child.stdin.end();
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 1_000_000) stderr += chunk; });
    const exited = new Promise((resolve) => {
      child.on('error', () => resolve({ code: null, signal: 'spawn-error' }));
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'codex-auth-rotate', title: null, version: '1' } } });
    let hardKill = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      hardKill = setTimeout(() => killGroup(child, 'SIGKILL'), 10_000);
    }, timeoutMs);
    exit = await exited;
    clearTimeout(timer);
    if (hardKill) clearTimeout(hardKill);
    // Nessun processo della CLI sopravvive allo step (il launcher npm avvia un figlio nativo).
    killGroup(child, 'SIGKILL');
  } finally {
    await sink.close();
  }
  let afterText = null;
  try {
    afterText = fs.readFileSync(authPath, 'utf8');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { afterText, rpc, exit, timedOut, log: classifyRefreshLog(stderr), requests: sink.requests };
}

const b64json = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = (claims) => `${b64json({ alg: 'none', typ: 'JWT' })}.${b64json(claims)}.rehearsal`;

/** Login finto per la prova generale: nessun valore reale, nessuna rete esterna. */
export function buildRehearsalLogin(now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const accountId = `rehearsal-${randomBytes(6).toString('hex')}`;
  const idClaims = (n) => ({ email: 'rehearsal@example.invalid', iat: nowSec, exp: nowSec + 3600, n,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' } });
  const login = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt(idClaims(0)),
      access_token: fakeJwt({ iat: nowSec - 5 * 86_400, exp: nowSec + 86_400, n: 0 }),
      refresh_token: `rt-rehearsal-old-${randomBytes(12).toString('hex')}`,
      account_id: accountId,
    },
    last_refresh: new Date(now - 5 * 86_400_000).toISOString(),
  };
  const refreshed = {
    id_token: fakeJwt(idClaims(1)),
    access_token: fakeJwt({ iat: nowSec, exp: nowSec + 10 * 86_400, n: 1 }),
    refresh_token: `rt-rehearsal-new-${randomBytes(12).toString('hex')}`,
  };
  return { login, refreshed };
}

/**
 * Prova generale senza effetti: stessa CLI, stesso driver, stessa validazione
 * del refresh reale, ma con un login finto e l'authority simulata dal sink.
 * Verifica anche il contratto della richiesta (client_id, grant_type, un solo
 * refresh). Gira prima di ogni refresh reale e in ogni dry run.
 */
export async function rehearseRefresh({ codexBin, workDir, now = Date.now() }) {
  const { login, refreshed } = buildRehearsalLogin(now);
  const calls = [];
  const onToken = (body) => {
    calls.push({
      clientId: body?.client_id === CODEX_OAUTH_CLIENT_ID,
      grant: body?.grant_type === 'refresh_token',
      token: body?.refresh_token === login.tokens.refresh_token,
    });
    const good = calls.at(-1).clientId && calls.at(-1).grant && calls.at(-1).token;
    return good
      ? { status: 200, json: refreshed }
      : { status: 401, json: { error: { code: 'refresh_token_reused' } } };
  };
  const startedAt = Date.now();
  const result = await runCliRefresh({ codexBin, authText: JSON.stringify(login), workDir, onToken });
  const errors = [];
  if (!result.rpc.initialized) errors.push('app-server did not answer initialize');
  if (!result.rpc.accountRead) errors.push('app-server did not answer account/read');
  if (calls.length !== 1) errors.push(`expected exactly one refresh request, saw ${calls.length}`);
  if (calls.some((call) => !call.clientId)) errors.push('refresh request client_id differs from the documented CLI contract');
  if (calls.some((call) => !call.grant || !call.token)) errors.push('refresh request body differs from the documented CLI contract');
  const verdict = validateRotation(login, result.afterText, { startedAt, now: Date.now(), minValidHours: 1 });
  if (!verdict.ok) errors.push(...verdict.errors);
  else if (verdict.after.tokens.refresh_token !== refreshed.refresh_token) errors.push('refreshed tokens were not persisted');
  return { ok: errors.length === 0, errors, requests: result.requests, timedOut: result.timedOut };
}

// ─── GitHub REST (I/O) ──────────────────────────────────────────────────────

const API = 'https://api.github.com';

async function ghApi(fetchImpl, token, urlPath, { method = 'GET', body } = {}) {
  const response = await fetchImpl(`${API}${urlPath}`, {
    method,
    headers: githubApiHeaders(token, { 'User-Agent': 'codex-auth-rotate', ...(body ? { 'Content-Type': 'application/json' } : {}) }),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

async function ghPaginate(fetchImpl, token, urlPath, maxPages = 10) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = urlPath.includes('?') ? '&' : '?';
    const { status, json } = await ghApi(fetchImpl, token, `${urlPath}${separator}per_page=100&page=${page}`);
    if (status !== 200 || !Array.isArray(json)) throw new Error(`GET ${urlPath.split('?')[0]} → ${status}`);
    items.push(...json);
    if (json.length < 100) break;
  }
  return items;
}

/** L'alert aperto (stesso titolo e label del monitor) e i suoi commenti, in ordine. */
export async function readAlertState({ repo, token, fetchImpl = fetch }) {
  const issues = await ghPaginate(fetchImpl, token, `/repos/${repo}/issues?state=open&labels=automation`);
  const alert = issues
    .filter((issue) => !issue.pull_request && issue.title === ALERT_TITLE)
    .sort((a, b) => b.number - a.number)[0] ?? null;
  if (!alert) return { alert: null, entries: [], latestMarker: null, rejected: new Set() };
  const comments = await ghPaginate(fetchImpl, token, `/repos/${repo}/issues/${alert.number}/comments`);
  const entries = [alert, ...comments.sort((a, b) => Number(a.id) - Number(b.id))];
  return { alert, entries, latestMarker: latestRotationMarker(entries), rejected: rejectedDigests(entries) };
}

/**
 * Pre-verifica senza effetti del token di scrittura: leggere la public key
 * dei secret richiede lo stesso permesso Secrets (read) che `gh secret set`
 * usa. Non prova la scrittura (un token solo-lettura passa): quello resta
 * un errore di `write`, con alert.
 */
export async function checkWriterAccess({ target, token, fetchImpl = fetch }) {
  if (!token) return { ok: false, status: null };
  try {
    const { status, json } = await ghApi(fetchImpl, token, `/repos/${target}/actions/secrets/public-key`);
    return { ok: status === 200 && typeof json?.key_id === 'string' && typeof json?.key === 'string', status };
  } catch {
    return { ok: false, status: null };
  }
}

function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('***');
  return out.replace(/\s+/gu, ' ').trim().slice(0, 300);
}

/** `gh secret set CODEX_AUTH_JSON --repo <target>`: valore da stdin, mai in argv. */
export async function writeSecret({ target, token, value, redactValues = [], attempts = 3, retryDelayMs = 5_000, sleep = defaultSleep, runGh = defaultRunGh }) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = runGh(['secret', 'set', SECRET_NAME, '--repo', target, '--app', 'actions'], { input: value, token });
    if (last.status === 0) return { ok: true, attempt };
    if (attempt < attempts) await sleep(attempt * retryDelayMs);
  }
  return { ok: false, attempt: attempts, detail: redact(`${last?.stderr ?? ''} ${last?.error ?? ''}`, [token, value, ...redactValues]) };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRunGh(args, { input, token }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-rotate-gh.'));
  try {
    const result = spawnSync('gh', args, {
      input,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        GH_TOKEN: token,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
      },
    });
    return { status: result.status, stderr: result.stderr, error: result.error ? String(result.error.message) : '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ─── Testi dell'alert (puri) ────────────────────────────────────────────────

const STAGE_ACTIONS = {
  plan: 'The stored `CODEX_AUTH_JSON` is missing or malformed. Log in again with the dedicated CI Codex login and replace the secret in the source repository.',
  blocked: 'The stored login already spent its refresh token in an earlier run. Log in again with the dedicated CI Codex login and replace `CODEX_AUTH_JSON` in the source repository; the next rotation propagates it to every target.',
  drift: '`CODEX_AUTH_JSON` differs between the plan job and the rotation job: it changed mid-run or an environment-level copy in `codex-auth-rotation` shadows the repository secret. Keep a single repository-level copy.',
  preflight: 'A writer token cannot manage Actions secrets on the source repository, so nothing was refreshed. Create or renew the token named in the run log (environment `codex-auth-rotation`).',
  rehearsal: 'The pinned Codex CLI no longer refreshes as documented (offline rehearsal failed). Nothing was consumed; check `CODEX_CLI_VERSION` against the CLI source before the stored login comes due.',
  refresh: 'The token authority rejected the refresh. If the failure code is permanent the stored login is dead: log in again and replace `CODEX_AUTH_JSON` in the source repository.',
  validate: 'The CLI produced an auth.json that failed validation, so nothing was written. The stored refresh token may have been consumed: log in again if the next run is blocked.',
  'write-primary': 'The refreshed login could not be written back to the source repository. The stored login has spent its refresh token and works only until its access token expires: log in again before then.',
  'write-secondary': 'The source repository holds the fresh login but some targets still hold the previous one. The next scheduled run retries them; create or renew the writer token for those owners if the log says it is missing.',
  lifetime: 'The refreshed access token lives shorter than the guaranteed validity window: consumers may still refresh on their own. Lower `CODEX_AUTH_MIN_VALID_HOURS` only with evidence, or shorten the schedule.',
  'write-remote-config': 'Every GitHub target holds the fresh login, but its Remote Config copy `CODEX_AUTH_JSON` (read by the Cloud Functions Codex rung, functions/src/codexFallback.js) was not updated. The functions keep the previous access token, never refresh it, and skip the rung once it expires; the next scheduled run retries. Check `FIREBASE_SERVICE_ACCOUNT_JSON` (Remote Config write access) and the run log.',
};

export function alertTexts({ marker, runUrl, workflow, sourceRepo, expiresAt = null }) {
  const action = STAGE_ACTIONS[marker.stage] ?? 'See the run log for the failing step.';
  const lines = [
    `Stage: \`${marker.stage}\`${marker.failureCode ? ` · failure code \`${marker.failureCode}\`` : ''}`,
    `Run: ${runUrl}`,
    ...(marker.pendingTargets?.length ? [`Targets not updated: ${marker.pendingTargets.map((target) => `\`${target}\``).join(', ')}`] : []),
    ...(expiresAt ? [`Stored access token expires: ${expiresAt}`] : []),
  ];
  const body = [
    '## Codex authentication rotation failed',
    '',
    `\`${workflow}\` keeps \`CODEX_AUTH_JSON\` fresh so that no Codex job ever has to spend the single-use refresh token itself. Source of truth: \`${sourceRepo}\`.`,
    '',
    ...lines,
    '',
    '### Action',
    action,
    '',
    'The issue contains no credential or token; only the stage, the targets and the SHA-256 digest of the stored auth.json are recorded. `codex-auth-recovery` closes it after a successful rotation.',
    '',
    formatRotationMarker(marker),
  ].join('\n');
  const comment = [`🔁 Codex auth rotation failed. ${action}`, '', ...lines, '', formatRotationMarker(marker)].join('\n');
  return { body, comment };
}

/**
 * Stesso esito già registrato: niente commento duplicato a ogni run. Il
 * digest conta solo per i fallimenti che hanno consumato il login (identifica
 * QUALE login è morto); un refresh riuscito cambia digest a ogni run.
 */
export function sameFailure(a, b) {
  return Boolean(a && b)
    && a.status === 'failed' && b.status === 'failed'
    && a.stage === b.stage
    && (!(a.consumed || b.consumed) || a.authDigest === b.authDigest)
    && (a.failureCode ?? null) === (b.failureCode ?? null)
    && Boolean(a.consumed) === Boolean(b.consumed)
    && JSON.stringify(a.pendingTargets ?? []) === JSON.stringify(b.pendingTargets ?? []);
}

/**
 * Esito del report job: marker da registrare sull'alert, o niente. Un
 * successo si registra solo se l'ultimo marker era un fallimento (è ciò che
 * permette al monitor di chiudere l'alert).
 */
export function reportOutcome({ planResult, rotateResult, planOutputs = {}, rotateOutputs = {}, latestMarker, runId, runAttempt }) {
  const authDigest = DIGEST_RE.test(String(planOutputs.auth_digest ?? '')) ? planOutputs.auth_digest : 'missing';
  const base = { version: 1, runId: Number(runId), runAttempt: Number(runAttempt), authDigest };
  const pendingTargets = String(rotateOutputs.pending ?? '').split(/\s+/u).filter((target) => REPO_RE.test(target));
  if (planResult === 'failure') {
    const stage = planOutputs.action === 'blocked' ? 'blocked' : 'plan';
    return { kind: 'failed', marker: { ...base, status: 'failed', stage, consumed: stage === 'blocked' } };
  }
  if (planResult !== 'success') return { kind: 'none', marker: null };
  const action = planOutputs.action;
  if (action !== 'refresh' && action !== 'sync') return { kind: 'none', marker: null };
  if (rotateResult === 'success') {
    if (latestMarker?.status !== 'failed') return { kind: 'none', marker: null };
    return { kind: 'succeeded', marker: { ...base, authDigest: DIGEST_RE.test(String(rotateOutputs.new_digest ?? '')) ? rotateOutputs.new_digest : authDigest, status: 'succeeded', stage: 'done' } };
  }
  if (rotateResult === 'failure' || rotateResult === 'cancelled') {
    const stage = STAGE_RE.test(String(rotateOutputs.stage ?? '')) ? rotateOutputs.stage : 'unknown';
    const failureCode = /^[a-z_]{1,64}$/u.test(String(rotateOutputs.failure_code ?? '')) ? rotateOutputs.failure_code : undefined;
    return {
      kind: 'failed',
      marker: {
        ...base,
        status: 'failed',
        stage,
        consumed: rotateOutputs.consumed === 'true',
        ...(failureCode ? { failureCode } : {}),
        ...(pendingTargets.length ? { pendingTargets } : {}),
      },
    };
  }
  return { kind: 'none', marker: null };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function out(line) {
  process.stdout.write(`${line}\n`);
}

function emitMasks(auth) {
  for (const command of maskCommands(auth)) out(command);
}

function setOutput(name, value) {
  const text = String(value ?? '');
  if (/[\r\n]/u.test(text)) throw new Error(`output ${name} must be single-line`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${text}\n`);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

const runnerTemp = () => process.env.RUNNER_TEMP || os.tmpdir();
const statePath = () => process.env.CODEX_AUTH_ROTATE_STATE || path.join(runnerTemp(), 'codex-auth-rotate-state.json');
/** L'auth.json validato passa dallo step refresh allo step write solo qui (0600, rimosso da uno step always()). */
const outPath = () => process.env.CODEX_AUTH_ROTATE_OUT || path.join(runnerTemp(), 'codex-auth-rotate-new-auth.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}

function updateState(patch) {
  const next = { ...readState(), ...patch };
  fs.writeFileSync(statePath(), JSON.stringify(next), { mode: 0o600 });
  return next;
}

const iso = (ms) => (ms === null || ms === undefined ? '' : new Date(ms).toISOString());
const hours = (value) => (value === null || value === undefined ? 'n/a' : `${value.toFixed(1)} h`);

function fail(message) {
  out(`::error::${escapeCommandValue(message)}`);
  process.exitCode = 1;
}

function sourceRepo() {
  return String(process.env.CODEX_AUTH_ROTATE_SOURCE_REPO || process.env.GITHUB_REPOSITORY || '');
}

function requireTargets() {
  const { targets, errors } = parseTargets(process.env.CODEX_AUTH_ROTATE_TARGETS, { sourceRepo: sourceRepo() });
  if (errors.length > 0) {
    for (const error of errors) fail(`CODEX_AUTH_ROTATE_TARGETS: ${error}`);
    return null;
  }
  return targets;
}

function readStoredLogin() {
  const text = process.env.CODEX_AUTH_JSON ?? '';
  const { auth, errors } = parseAuthJson(text);
  return { text, auth, errors };
}

async function commandPlan() {
  const targets = requireTargets();
  const { policy, errors: policyErrors } = parsePolicy(process.env);
  for (const error of policyErrors) fail(`Rotation policy: ${error}`);
  const stored = readStoredLogin();
  const digest = stored.text ? secretDigest(stored.text) : 'missing';
  setOutput('auth_digest', digest);
  if (stored.auth) emitMasks(stored.auth);
  if (!stored.auth) {
    setOutput('action', 'invalid');
    fail(`CODEX_AUTH_JSON is not a usable Codex ChatGPT login: ${stored.errors.join('; ')}.`);
    return;
  }
  if (!targets || !policy) return;
  const now = Date.now();
  const force = process.env.CODEX_AUTH_ROTATE_FORCE === 'true';
  const decision = refreshDecision(stored.auth, { now, force, policy });
  let alertState;
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN missing');
    alertState = await readAlertState({ repo: sourceRepo(), token });
  } catch (error) {
    // Senza lo stato dell'alert non si sa se il refresh token è già stato
    // consumato: meglio una run rossa che ripresentarlo.
    setOutput('action', 'unknown');
    fail(`Cannot read the Codex auth alert state (${String(error?.message ?? error).slice(0, 120)}); rotation skipped.`);
    return;
  }
  const { action } = planAction({
    decision,
    latestMarker: alertState.latestMarker,
    currentDigest: digest,
    rejected: alertState.rejected,
  });
  const { login } = decision;
  setOutput('action', action);
  setOutput('reasons', decision.reasons.join(',') || 'none');
  setOutput('targets', targets.join(' '));
  setOutput('expires_at', iso(login.expiresAt));
  const writers = targets.map((target) => `\`${target}\` ← \`${writerTokenEnvName(target.split('/')[0], sourceRepo().split('/')[0])}\``);
  summary([
    '### Codex auth rotation plan',
    '',
    '| | |',
    '|---|---|',
    `| action | \`${action}\` |`,
    `| reasons | ${decision.reasons.join(', ') || 'none'} |`,
    `| CLI refresh rule | \`${login.cliRule}\` |`,
    `| CLI would refresh at | ${iso(login.cliDueAt) || 'never (no exp, no last_refresh)'} (${hours(login.hoursUntilCliRefresh)}) |`,
    `| access token expires | ${iso(login.expiresAt) || 'n/a'} (lifetime ${hours(login.lifetimeHours)}) |`,
    `| last_refresh age | ${hours(login.ageHours)} |`,
    `| policy | margin ${policy.marginHours} h · max age ${policy.maxAgeHours} h · min valid ${policy.minValidHours} h |`,
    `| targets ← writer secret | ${writers.join('<br>')} |`,
    `| open alert | ${alertState.alert ? `#${alertState.alert.number} (last rotation marker: ${alertState.latestMarker ? `${alertState.latestMarker.status}/${alertState.latestMarker.stage}` : 'none'})` : 'none'} |`,
  ].join('\n'));
  out(`Codex auth rotation plan: action=${action} reasons=${decision.reasons.join(',') || 'none'} cli_rule=${login.cliRule} hours_until_cli_refresh=${hours(login.hoursUntilCliRefresh)}.`);
  if (login.lifetimeHours !== null && login.lifetimeHours < policy.marginHours) {
    out(`::warning::The stored access token lifetime (${hours(login.lifetimeHours)}) is shorter than the refresh margin: every run will rotate.`);
  }
  if (action === 'blocked') {
    fail('The stored CODEX_AUTH_JSON already spent its refresh token in an earlier rotation (see the open "Codex auth down" alert). Log in again and replace the secret; no refresh is attempted with a consumed token.');
  }
}

async function commandRehearse() {
  const codexBin = process.env.CODEX_BIN;
  if (!codexBin) { fail('CODEX_BIN is not set.'); return; }
  updateState({ stage: 'rehearsal' });
  const workDir = runnerTemp();
  const result = await rehearseRefresh({ codexBin, workDir });
  const outbound = result.requests.filter((request) => request.startsWith('CONNECT')).length;
  if (!result.ok) {
    fail(`Offline rehearsal of the Codex CLI refresh failed: ${result.errors.join('; ')}.`);
    return;
  }
  out(`Offline rehearsal passed: codex-cli ${CODEX_CLI_VERSION} app-server account/read{refreshToken} performed exactly one documented refresh and persisted a valid auth.json (${outbound} outbound connection attempt(s) refused by the sink).`);
}

async function commandPreflight() {
  const targets = requireTargets();
  if (!targets) { updateState({ stage: 'preflight' }); return; }
  const action = process.env.CODEX_AUTH_ROTATE_ACTION;
  const toWrite = action === 'sync' ? targets.slice(1) : targets;
  const problems = [];
  for (const target of toWrite) {
    const writer = resolveWriterToken(target, sourceRepo(), process.env);
    const access = await checkWriterAccess({ target, token: writer.token });
    if (access.ok) {
      out(`Writer token for ${target}: ${writer.usedName} can manage Actions secrets.`);
      continue;
    }
    problems.push(target);
    const why = writer.token ? `${writer.usedName} cannot read the Actions secrets public key (HTTP ${access.status ?? 'error'})` : `${writer.name} is not configured`;
    out(`::error::${escapeCommandValue(`${why} for ${target}. Create a fine-grained PAT owned by ${target.split('/')[0]} with repository access to ${target} and permission "Secrets: Read and write", and store it as ${writer.name} in the environment codex-auth-rotation.`)}`);
  }
  // Il sorgente è indispensabile: senza, un refresh butterebbe via il login.
  // Un target secondario non scrivibile non ferma la rotazione del sorgente:
  // resta pendente e la run finisce rossa con alert.
  const primaryBlocked = action !== 'sync' && problems.includes(targets[0]);
  updateState({ stage: 'preflight', preflightProblems: problems });
  if (primaryBlocked || (action === 'sync' && problems.length === toWrite.length && toWrite.length > 0)) {
    updateState({ pending: toWrite });
    process.exitCode = 1;
  }
}

async function commandRefresh() {
  const mode = process.env.CODEX_AUTH_ROTATE_ACTION;
  const outFile = outPath();
  const stored = readStoredLogin();
  if (stored.auth) emitMasks(stored.auth);
  if (!stored.auth) {
    updateState({ stage: 'plan' });
    fail(`CODEX_AUTH_JSON is not a usable Codex ChatGPT login: ${stored.errors.join('; ')}.`);
    return;
  }
  const digest = secretDigest(stored.text);
  if (digest !== process.env.CODEX_AUTH_EXPECTED_DIGEST) {
    updateState({ stage: 'drift' });
    fail('CODEX_AUTH_JSON seen by this job differs from the one the plan job evaluated (changed mid-run, or shadowed by an environment secret). Nothing was refreshed.');
    return;
  }
  if (mode === 'sync') {
    fs.writeFileSync(outFile, JSON.stringify(stored.auth), { mode: 0o600 });
    updateState({ stage: 'sync', consumed: false, newDigest: digest });
    out('Sync mode: the stored login is propagated unchanged to the targets left behind.');
    return;
  }
  const { policy } = parsePolicy(process.env);
  const codexBin = process.env.CODEX_BIN;
  if (!codexBin || !policy) { updateState({ stage: 'refresh' }); fail('CODEX_BIN or the rotation policy is missing.'); return; }
  updateState({ stage: 'refresh', consumed: false });
  const startedAt = Date.now();
  const result = await runCliRefresh({ codexBin, authText: stored.text, workDir: runnerTemp() });
  const parsedAfter = parseAuthJson(result.afterText ?? '');
  // Maschera i token nuovi prima di qualunque altro output.
  if (parsedAfter.auth) emitMasks(parsedAfter.auth);
  const verdict = validateRotation(stored.auth, result.afterText ?? '', { startedAt, now: Date.now(), minValidHours: policy.minValidHours });
  const permanent = result.log.failureCode !== null && PERMANENT_REFRESH_FAILURES.has(result.log.failureCode);
  if (!verdict.ok) {
    // Consumato: l'authority ha rifiutato il token in modo permanente, oppure
    // la CLI ha salvato token nuovi (refresh avvenuto) che non pubblichiamo.
    const rotatedButInvalid = parsedAfter.auth !== null
      && parsedAfter.auth.tokens.refresh_token !== stored.auth.tokens.refresh_token;
    updateState({
      stage: result.log.failed ? 'refresh' : 'validate',
      consumed: permanent || rotatedButInvalid,
      failureCode: result.log.failureCode ?? undefined,
    });
    fail(`Codex CLI refresh did not produce a publishable login (${result.log.failed ? `authority error ${result.log.failureCode}` : verdict.errors.join('; ')}; refresh attempts=${result.log.attempts}, timed out=${result.timedOut}). Nothing was written.`);
    return;
  }
  fs.writeFileSync(outFile, JSON.stringify(verdict.after), { mode: 0o600 });
  const newDigest = secretDigest(JSON.stringify(verdict.after));
  updateState({ stage: 'refreshed', consumed: true, newDigest, lifetimeShort: verdict.lifetimeShort });
  out(`Codex login refreshed by codex-cli ${CODEX_CLI_VERSION}: account unchanged, last_refresh advanced, access token rotated=${verdict.accessTokenRotated}, refresh token rotated=${verdict.refreshTokenRotated}, CLI would next refresh at ${iso(verdict.afterLogin.cliDueAt) || 'n/a'} (${hours(verdict.afterLogin.hoursUntilCliRefresh)}).`);
  if (!verdict.refreshTokenRotated) out('::notice::The authority returned no new refresh token; the stored one stays valid.');
}

async function commandWrite() {
  const targets = requireTargets();
  const outFile = outPath();
  const state = readState();
  if (!targets || !fs.existsSync(outFile)) {
    updateState({ stage: state.stage === 'refreshed' ? 'write-primary' : state.stage ?? 'write-primary', pending: targets ?? [] });
    fail('No validated auth.json to write.');
    return;
  }
  const value = fs.readFileSync(outFile, 'utf8');
  const { auth, errors } = parseAuthJson(value);
  if (!auth) { updateState({ stage: 'validate', pending: targets }); fail(`Validated auth.json became unreadable: ${errors.join('; ')}.`); return; }
  emitMasks(auth);
  const mode = process.env.CODEX_AUTH_ROTATE_ACTION;
  const toWrite = mode === 'sync' ? targets.slice(1) : targets;
  const written = [];
  const pending = [];
  const tokenValues = [auth.tokens.id_token, auth.tokens.access_token, auth.tokens.refresh_token];
  // Il sorgente per primo; i secondari si scrivono anche se il sorgente
  // fallisce: il login nuovo sopravvive almeno lì.
  for (const target of toWrite) {
    const writer = resolveWriterToken(target, sourceRepo(), process.env);
    if (!writer.token) {
      pending.push(target);
      out(`::error::${escapeCommandValue(`${writer.name} is not configured: ${SECRET_NAME} was not written to ${target}.`)}`);
      continue;
    }
    const retryDelayMs = intFromEnv('CODEX_AUTH_ROTATE_RETRY_DELAY_MS', 5_000);
    const result = await writeSecret({ target, token: writer.token, value, redactValues: tokenValues, retryDelayMs });
    if (result.ok) {
      written.push(target);
      out(`Wrote ${SECRET_NAME} to ${target} (attempt ${result.attempt}).`);
    } else {
      pending.push(target);
      out(`::error::${escapeCommandValue(`gh secret set ${SECRET_NAME} --repo ${target} failed after ${result.attempt} attempts: ${result.detail || 'no detail'}`)}`);
    }
  }
  const primaryWritten = mode === 'sync' || written.includes(targets[0]);
  let stage = 'done';
  if (!primaryWritten) stage = 'write-primary';
  else if (pending.length > 0) stage = 'write-secondary';
  else if (state.lifetimeShort) stage = 'lifetime';
  updateState({
    stage,
    written,
    pending,
    // Il login salvato nel sorgente è "consumato" solo se il sorgente non ha ricevuto quello nuovo.
    consumed: mode !== 'sync' && !primaryWritten,
  });
  if (stage === 'write-primary') {
    fail(`The refreshed login was NOT written to the source repository ${targets[0]}: its stored ${SECRET_NAME} has spent its refresh token. Log in again before the stored access token expires.`);
  } else if (stage === 'write-secondary') {
    fail(`${SECRET_NAME} is fresh in ${written.join(', ') || 'no target'} but NOT in ${pending.join(', ')}; the next scheduled run retries.`);
  } else if (stage === 'lifetime') {
    fail(`The refreshed access token is valid for less than CODEX_AUTH_MIN_VALID_HOURS: consumers may still have to refresh on their own.`);
  }
}

/**
 * Copia del login validato nel parametro Remote Config delle Cloud Functions.
 * Gira dopo `write`, anche se `write` è fallito: la copia non contiene il
 * refresh token, quindi non può influire sulla CI, e un access token fresco
 * serve comunque alle functions. Un suo fallimento diventa lo stage
 * `write-remote-config` solo se il resto è riuscito (non copre mai uno stage
 * più grave); il marker di fallimento porta la run successiva in `sync`, che
 * riscrive anche questa copia. CODEX_AUTH_ROTATE_DRY_RUN=true: legge e
 * confronta, nessuna scrittura.
 */
async function commandWriteRemoteConfig() {
  const state = readState();
  const failRemoteConfig = (message) => {
    updateState({ stage: state.stage === 'done' ? 'write-remote-config' : state.stage ?? 'write-remote-config', remoteConfig: 'failed' });
    fail(message);
  };
  const outFile = outPath();
  if (!fs.existsSync(outFile)) { failRemoteConfig('No validated auth.json to copy to Remote Config.'); return; }
  const { auth, errors } = parseAuthJson(fs.readFileSync(outFile, 'utf8'));
  if (!auth) { failRemoteConfig(`Validated auth.json became unreadable: ${errors.join('; ')}.`); return; }
  emitMasks(auth);
  let credentials = null;
  try { credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? ''); } catch { credentials = null; }
  if (!isPlainObject(credentials) || !credentials.client_email || !credentials.private_key || !credentials.project_id) {
    failRemoteConfig(`FIREBASE_SERVICE_ACCOUNT_JSON is missing or is not a service account JSON: ${REMOTE_CONFIG_PARAM} was not copied to Remote Config.`);
    return;
  }
  const value = remoteConfigLogin(auth);
  const dryRun = process.env.CODEX_AUTH_ROTATE_DRY_RUN === 'true';
  const redactValues = [auth.tokens.id_token, auth.tokens.access_token, auth.tokens.refresh_token, value, credentials.private_key];
  let result;
  try {
    result = await setRcParamWithEtag({
      credentials,
      name: REMOTE_CONFIG_PARAM,
      value,
      description: 'Codex ChatGPT login (no refresh_token) for functions/src/codexFallback.js. Written by codex-auth-rotate.yml; never refreshed by the functions.',
      versionDescription: `codex-auth-rotate: ${REMOTE_CONFIG_PARAM}`,
      dryRun,
      retryDelayMs: intFromEnv('CODEX_AUTH_ROTATE_RETRY_DELAY_MS', 2_000),
      onAccessToken: (token) => { if (token) { redactValues.push(token); out(`::add-mask::${escapeCommandValue(token)}`); } },
    });
  } catch (error) {
    result = { ok: false, attempt: 0, detail: `service account token exchange failed: ${String(error?.message ?? error)}` };
  }
  if (!result.ok) {
    failRemoteConfig(`Could not copy ${REMOTE_CONFIG_PARAM} to Remote Config (attempt ${result.attempt}): ${redact(result.detail, redactValues) || 'no detail'}.`);
    return;
  }
  const outcome = result.dryRun ? 'dry-run' : (result.changed ? 'written' : 'unchanged');
  updateState({ remoteConfig: outcome });
  out(result.dryRun
    ? `Dry run: Remote Config ${REMOTE_CONFIG_PARAM} differs from the validated login; nothing was written.`
    : `Remote Config ${REMOTE_CONFIG_PARAM} ${result.changed ? 'updated' : 'already up to date'} (attempt ${result.attempt}, refresh_token omitted).`);
}

function commandSummarize() {
  const state = readState();
  const stage = STAGE_RE.test(String(state.stage ?? '')) ? state.stage : 'unknown';
  setOutput('stage', stage);
  setOutput('consumed', state.consumed === true ? 'true' : 'false');
  setOutput('failure_code', /^[a-z_]{1,64}$/u.test(String(state.failureCode ?? '')) ? state.failureCode : '');
  const valid = (list) => (Array.isArray(list) ? list.filter((target) => REPO_RE.test(String(target))) : []);
  setOutput('written', valid(state.written).join(' '));
  setOutput('pending', valid(state.pending).join(' '));
  setOutput('new_digest', DIGEST_RE.test(String(state.newDigest ?? '')) ? state.newDigest : '');
  summary([
    '### Codex auth rotation',
    '',
    `- stage: \`${stage}\``,
    `- written: ${valid(state.written).map((target) => `\`${target}\``).join(', ') || 'none'}`,
    `- pending: ${valid(state.pending).map((target) => `\`${target}\``).join(', ') || 'none'}`,
    `- Remote Config copy (Cloud Functions): ${/^[a-z-]{1,20}$/u.test(String(state.remoteConfig ?? '')) ? state.remoteConfig : 'not written'}`,
  ].join('\n'));
}

async function commandReport() {
  const repo = sourceRepo();
  const token = process.env.GITHUB_TOKEN;
  if (!token) { fail('GITHUB_TOKEN missing.'); return; }
  const planOutputs = {
    action: process.env.PLAN_ACTION,
    auth_digest: process.env.PLAN_AUTH_DIGEST,
    expires_at: process.env.PLAN_EXPIRES_AT,
  };
  const rotateOutputs = {
    stage: process.env.ROTATE_STAGE,
    consumed: process.env.ROTATE_CONSUMED,
    failure_code: process.env.ROTATE_FAILURE_CODE,
    pending: process.env.ROTATE_PENDING,
    new_digest: process.env.ROTATE_NEW_DIGEST,
  };
  const state = await readAlertState({ repo, token });
  const outcome = reportOutcome({
    planResult: process.env.PLAN_RESULT,
    rotateResult: process.env.ROTATE_RESULT,
    planOutputs,
    rotateOutputs,
    latestMarker: state.latestMarker,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  if (outcome.kind === 'none') { out('Nothing to record on the Codex auth alert.'); return; }
  const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  if (outcome.kind === 'succeeded') {
    const body = `✅ Codex auth rotation succeeded (${runUrl}): every target and the Remote Config copy hold the fresh login. \`codex-auth-recovery\` closes this alert once nothing else is blocked.\n\n${formatRotationMarker(outcome.marker)}`;
    const { status } = await ghApi(fetch, token, `/repos/${repo}/issues/${state.alert.number}/comments`, { method: 'POST', body: { body } });
    if (status !== 201) fail(`Could not record the successful rotation on alert #${state.alert.number} (HTTP ${status}).`);
    else out(`Recorded the successful rotation on alert #${state.alert.number}.`);
    return;
  }
  if (sameFailure(state.latestMarker, outcome.marker)) {
    out(`Alert #${state.alert.number} already records this rotation failure.`);
    return;
  }
  const texts = alertTexts({
    marker: outcome.marker,
    runUrl,
    workflow: process.env.GITHUB_WORKFLOW || 'Codex auth rotate',
    sourceRepo: repo,
    expiresAt: planOutputs.expires_at || null,
  });
  const request = state.alert
    ? { path: `/repos/${repo}/issues/${state.alert.number}/comments`, body: { body: texts.comment } }
    : { path: `/repos/${repo}/issues`, body: { title: ALERT_TITLE, labels: ['automation'], body: texts.body } };
  const { status } = await ghApi(fetch, token, request.path, { method: 'POST', body: request.body });
  if (status !== 201) fail(`Could not record the rotation failure on the Codex auth alert (HTTP ${status}).`);
  else out(state.alert ? `Recorded the rotation failure on alert #${state.alert.number}.` : 'Opened the Codex auth alert for the rotation failure.');
}

const COMMANDS = {
  plan: commandPlan,
  rehearse: commandRehearse,
  preflight: commandPreflight,
  refresh: commandRefresh,
  write: commandWrite,
  'write-remote-config': commandWriteRemoteConfig,
  summarize: commandSummarize,
  report: commandReport,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = COMMANDS[process.argv[2]];
  if (!command) {
    out(`::error::usage: codex-auth-rotate.mjs <${Object.keys(COMMANDS).join('|')}>`);
    process.exit(2);
  }
  Promise.resolve()
    .then(command)
    .catch((error) => {
      // Mai lo stack completo: potrebbe citare valori letti dall'env.
      out(`::error::${escapeCommandValue(`codex-auth-rotate ${process.argv[2]} failed: ${String(error?.message ?? error).slice(0, 200)}`)}`);
      process.exitCode = 1;
    });
}
