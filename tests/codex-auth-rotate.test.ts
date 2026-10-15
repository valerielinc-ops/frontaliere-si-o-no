/**
 * Rotazione di CODEX_AUTH_JSON (scripts/ci/codex-auth-rotate.mjs +
 * .github/workflows/codex-auth-rotate.yml).
 *
 * Il refresh token del login ChatGPT è monouso: se la decisione, la
 * validazione o la scrittura sbagliano, il login si perde (incidente del 2026-09-21, run 35577718786).
 * Qui si provano la regola di refresh (specchio di codex-rs
 * login/src/auth/manager.rs @ rust-v0.153.4), la validazione del login nuovo,
 * il masking, la lista target, il driver della CLI con un binario finto (env
 * ermetico, stderr mai inoltrato) e il wiring del workflow. Nessun test tocca
 * la rete o un file tracciato: tutto in os.tmpdir().
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  ALERT_TITLE,
  CLI_FALLBACK_INTERVAL_MS,
  CLI_REFRESH_WINDOW_MS,
  CODEX_CLI_VERSION,
  CODEX_OAUTH_CLIENT_ID,
  DEFAULT_POLICY,
  DEFAULT_TARGETS,
  SCHEDULE_INTERVAL_HOURS,
  alertTexts,
  classifyRefreshLog,
  describeLogin,
  escapeCommandValue,
  extractRotationMarkers,
  formatRotationMarker,
  latestRotationMarker,
  maskCommands,
  parseAuthJson,
  parsePolicy,
  parseTargets,
  planAction,
  refreshDecision,
  rehearseRefresh,
  REMOTE_CONFIG_PARAM,
  remoteConfigLogin,
  rejectedDigests,
  reportOutcome,
  resolveWriterToken,
  runCliRefresh,
  sameFailure,
  secretDigest,
  validateRotation,
  writeSecret,
  writerTokenEnvName,
} from '../scripts/ci/codex-auth-rotate.mjs';
import { RC_SCOPE, setRcParamWithEtag, stageRcParamValue } from '../scripts/lib/remote-config-admin.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';

const HOUR = 3_600_000;
const NOW = Date.now();
const SCRIPT = path.resolve('scripts/ci/codex-auth-rotate.mjs');
const SOURCE = 'valerielinc-ops/frontaliere-si-o-no';
const ARTICLES = 'nanakokyobashi-rgb/frontaliere-articles';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
const sec = (ms: number) => Math.floor(ms / 1000);

function login({
  expInHours = 240 as number | null,
  lastRefreshHoursAgo = 24 as number | null,
  account = 'acct-11111111',
  tag = 'old',
} = {}) {
  const accessClaims: Record<string, unknown> = { iat: sec(NOW - 24 * HOUR), tag };
  if (expInHours !== null) accessClaims.exp = sec(NOW + expInHours * HOUR);
  const auth: Record<string, any> = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: 'ci@example.invalid', tag, 'https://api.openai.com/auth': { chatgpt_account_id: account } }),
      access_token: jwt(accessClaims),
      refresh_token: `rt_${tag}_0123456789abcdef`,
      account_id: account,
    },
  };
  if (lastRefreshHoursAgo !== null) auth.last_refresh = new Date(NOW - lastRefreshHoursAgo * HOUR).toISOString();
  return auth;
}

const tmpDirs: string[] = [];
function tmp(prefix = 'codex-auth-rotate-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('refreshDecision — specchio della regola della CLI', () => {
  const policy = DEFAULT_POLICY;

  it('usa access_token.exp meno la finestra di 5 minuti della CLI', () => {
    const auth = login({ expInHours: 100 });
    const { login: info } = refreshDecision(auth, { now: NOW, policy });
    expect(info.cliRule).toBe('access_token.exp');
    expect(info.cliDueAt).toBe(sec(NOW + 100 * HOUR) * 1000 - CLI_REFRESH_WINDOW_MS);
    expect(CLI_REFRESH_WINDOW_MS).toBe(5 * 60_000);
  });

  it('non ruota un login lontano dalla soglia e rinfrescato di recente', () => {
    expect(refreshDecision(login({ expInHours: 200, lastRefreshHoursAgo: 12 }), { now: NOW, policy })).toMatchObject({ due: false, reasons: [] });
  });

  it('ruota quando la CLI rinfrescherebbe entro il margine', () => {
    const decision = refreshDecision(login({ expInHours: policy.marginHours - 1 }), { now: NOW, policy });
    expect(decision.due).toBe(true);
    expect(decision.reasons).toContain('cli-refresh-within-margin');
  });

  it('il confine del margine è esclusivo', () => {
    const auth = login({ expInHours: 1000 });
    const dueAt = NOW + policy.marginHours * HOUR;
    auth.tokens.access_token = jwt({ exp: sec(dueAt + CLI_REFRESH_WINDOW_MS) + 1 });
    expect(refreshDecision(auth, { now: NOW, policy }).reasons).not.toContain('cli-refresh-within-margin');
  });

  it('ruota subito un login già oltre la soglia della CLI', () => {
    expect(refreshDecision(login({ expInHours: 0.01 }), { now: NOW, policy }).reasons).toContain('cli-refresh-overdue');
    expect(refreshDecision(login({ expInHours: -3 }), { now: NOW, policy }).reasons).toContain('cli-refresh-overdue');
  });

  it('senza exp leggibile ricade su last_refresh + 8 giorni, come la CLI', () => {
    const auth = login({ expInHours: null, lastRefreshHoursAgo: 24 });
    auth.tokens.access_token = 'opaque-access-token-value';
    const { login: info, due } = refreshDecision(auth, { now: NOW, policy });
    expect(info.cliRule).toBe('last_refresh+8d');
    expect(info.cliDueAt).toBe(Date.parse(auth.last_refresh) + CLI_FALLBACK_INTERVAL_MS);
    expect(due).toBe(false);
    const stale = login({ expInHours: null, lastRefreshHoursAgo: 7 * 24 });
    expect(refreshDecision(stale, { now: NOW, policy }).reasons).toEqual(
      expect.arrayContaining(['cli-refresh-within-margin', 'last-refresh-older-than-max-age']),
    );
  });

  it('ruota per età anche con exp lontano, e quando last_refresh manca', () => {
    expect(refreshDecision(login({ expInHours: 400, lastRefreshHoursAgo: policy.maxAgeHours }), { now: NOW, policy }).reasons)
      .toEqual(['last-refresh-older-than-max-age']);
    expect(refreshDecision(login({ lastRefreshHoursAgo: null }), { now: NOW, policy }).reasons).toEqual(['last-refresh-missing']);
  });

  it('force ruota sempre', () => {
    expect(refreshDecision(login(), { now: NOW, force: true, policy })).toMatchObject({ due: true, reasons: ['forced'] });
  });
});

describe('parsePolicy', () => {
  it('i default sono coerenti con cron e job più lungo', () => {
    expect(parsePolicy({})).toEqual({ policy: { ...DEFAULT_POLICY }, errors: [] });
    expect(DEFAULT_POLICY.marginHours).toBeGreaterThanOrEqual(DEFAULT_POLICY.minValidHours + SCHEDULE_INTERVAL_HOURS);
  });

  it('rifiuta politiche che non possono mantenere la garanzia', () => {
    expect(parsePolicy({ CODEX_AUTH_REFRESH_MARGIN_HOURS: '10' }).errors.join()).toMatch(/marginHours/u);
    expect(parsePolicy({ CODEX_AUTH_MIN_VALID_HOURS: '1', CODEX_AUTH_REFRESH_MARGIN_HOURS: '48' }).errors.join()).toMatch(/minValidHours/u);
    expect(parsePolicy({ CODEX_AUTH_MAX_AGE_HOURS: '192' }).errors.join()).toMatch(/8-day/u);
    expect(parsePolicy({ CODEX_AUTH_MAX_AGE_HOURS: 'soon' }).policy).toBeNull();
  });
});

describe('parseAuthJson', () => {
  it('accetta uno snapshot di login ChatGPT', () => {
    const auth = login();
    expect(parseAuthJson(JSON.stringify(auth))).toEqual({ auth, errors: [] });
    expect(parseAuthJson(JSON.stringify({ ...auth, auth_mode: 'chatgpt' })).errors).toEqual([]);
  });

  it('rifiuta forme che la CLI non potrebbe rinfrescare, senza citare i valori', () => {
    const auth = login();
    const cases: Array<[unknown, RegExp]> = [
      [{ ...auth, tokens: { ...auth.tokens, refresh_token: '' } }, /refresh_token/u],
      [{ ...auth, tokens: { ...auth.tokens, access_token: 'two\nlines-token' } }, /access_token/u],
      [{ ...auth, tokens: { ...auth.tokens, id_token: 'not-a-jwt-token' } }, /id_token is not a decodable JWT/u],
      [{ ...auth, tokens: { ...auth.tokens, account_id: '' } }, /account_id/u],
      [{ ...auth, OPENAI_API_KEY: 'sk-live-secret-value' }, /OPENAI_API_KEY/u],
      [{ ...auth, auth_mode: 'chatgptAuthTokens' }, /auth_mode/u],
      [{ ...auth, last_refresh: 'yesterday' }, /last_refresh/u],
    ];
    for (const [value, pattern] of cases) {
      const { auth: parsed, errors } = parseAuthJson(JSON.stringify(value));
      expect(parsed).toBeNull();
      expect(errors.join('; ')).toMatch(pattern);
      expect(errors.join('; ')).not.toContain('sk-live-secret-value');
      expect(errors.join('; ')).not.toContain(auth.tokens.refresh_token);
    }
    expect(parseAuthJson('').errors).toEqual(['empty']);
    expect(parseAuthJson('{oops').errors).toEqual(['not valid JSON']);
    expect(parseAuthJson('[]').errors).toEqual(['not a JSON object']);
  });
});

describe('validateRotation — prima di scrivere qualunque cosa', () => {
  const startedAt = NOW - 60_000;
  const refreshed = (patch: (auth: Record<string, any>) => void = () => {}) => {
    const after = login({ tag: 'new', lastRefreshHoursAgo: 0 });
    after.last_refresh = new Date(NOW - 1_000).toISOString();
    patch(after);
    return JSON.stringify(after);
  };

  it('accetta un refresh valido e ne riporta la rotazione', () => {
    const verdict = validateRotation(login(), refreshed(), { startedAt, now: NOW });
    expect(verdict).toMatchObject({ ok: true, errors: [], accessTokenRotated: true, refreshTokenRotated: true, lifetimeShort: false });
  });

  it('blocca account diverso, last_refresh non avanzato o implausibile, token già scaduto', () => {
    const check = (patch: (auth: Record<string, any>) => void) => validateRotation(login(), refreshed(patch), { startedAt, now: NOW });
    expect(check((a) => { a.tokens.account_id = 'acct-22222222'; }).errors).toContain('tokens.account_id changed');
    expect(check((a) => {
      a.tokens.id_token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-other' } });
    }).errors).toContain('id_token chatgpt_account_id changed');
    expect(check((a) => { a.last_refresh = new Date(NOW - 24 * HOUR).toISOString(); }).errors).toEqual(
      expect.arrayContaining(['last_refresh did not advance', 'last_refresh predates this refresh']),
    );
    expect(check((a) => { a.last_refresh = new Date(NOW + 2 * HOUR).toISOString(); }).errors).toContain('last_refresh is in the future');
    expect(check((a) => { delete a.last_refresh; }).errors).toContain('last_refresh missing');
    expect(check((a) => { a.tokens.access_token = jwt({ exp: sec(NOW - HOUR) }); }).errors).toContain('new access_token already expired');
    expect(validateRotation(login(), '{"tokens":{}}', { startedAt, now: NOW }).errors.join()).toMatch(/^new auth.json/u);
  });

  it('segnala una durata più corta della garanzia minima senza bloccare la scrittura', () => {
    const verdict = validateRotation(login(), refreshed((a) => { a.tokens.access_token = jwt({ exp: sec(NOW + 2 * HOUR) }); }), { startedAt, now: NOW });
    expect(verdict.ok).toBe(true);
    expect(verdict.lifetimeShort).toBe(true);
  });
});

describe('masking', () => {
  it('maschera ogni token e l\'account id, una volta sola', () => {
    const auth = login();
    const commands = maskCommands(auth);
    for (const value of [auth.tokens.id_token, auth.tokens.access_token, auth.tokens.refresh_token, auth.tokens.account_id]) {
      expect(commands).toContain(`::add-mask::${value}`);
    }
    expect(maskCommands({ tokens: { id_token: 'x'.repeat(10), access_token: 'x'.repeat(10) } })).toHaveLength(1);
  });

  it('escapa i caratteri che romperebbero il comando di workflow', () => {
    expect(escapeCommandValue('a%b\r\nc')).toBe('a%25b%0D%0Ac');
    expect(maskCommands({ tokens: { refresh_token: 'rt%value%' } })).toEqual(['::add-mask::rt%25value%25']);
  });
});

describe('lista target e token di scrittura', () => {
  it('default: entrambi i repo, sorgente per primo', () => {
    expect(parseTargets('', { sourceRepo: SOURCE })).toEqual({ targets: [SOURCE, ARTICLES], errors: [] });
    expect([...DEFAULT_TARGETS]).toEqual([SOURCE, ARTICLES]);
  });

  it('accetta spazi, virgole e a-capo, deduplica e rimette il sorgente in testa', () => {
    expect(parseTargets(`${ARTICLES},\n  ${SOURCE.toUpperCase()} ${ARTICLES}`, { sourceRepo: SOURCE }).targets)
      .toEqual([SOURCE.toUpperCase(), ARTICLES]);
  });

  it('esige il repo sorgente e rifiuta voci non owner/repo', () => {
    expect(parseTargets(ARTICLES, { sourceRepo: SOURCE }).errors.join()).toMatch(/must include the source repository/u);
    for (const bad of ['owner', 'owner/..', '../x', 'o/r/extra', 'own er/repo', '-bad/repo']) {
      const { targets, errors } = parseTargets(`${SOURCE} ${bad}`, { sourceRepo: SOURCE });
      expect(targets, bad).toEqual([]);
      expect(errors.join(), bad).toMatch(/invalid target/u);
    }
  });

  it('un token per owner: il sorgente usa il nome base, gli altri il suffisso owner', () => {
    expect(writerTokenEnvName('valerielinc-ops', 'valerielinc-ops')).toBe('CODEX_SECRET_WRITER_TOKEN');
    expect(writerTokenEnvName('nanakokyobashi-rgb', 'valerielinc-ops')).toBe('CODEX_SECRET_WRITER_TOKEN_NANAKOKYOBASHI_RGB');
    const env = { CODEX_SECRET_WRITER_TOKEN: 'tok-main', CODEX_SECRET_WRITER_TOKEN_NANAKOKYOBASHI_RGB: 'tok-nanako' };
    expect(resolveWriterToken(ARTICLES, SOURCE, env)).toMatchObject({ usedName: 'CODEX_SECRET_WRITER_TOKEN_NANAKOKYOBASHI_RGB', token: 'tok-nanako' });
    expect(resolveWriterToken(SOURCE, SOURCE, env)).toMatchObject({ usedName: 'CODEX_SECRET_WRITER_TOKEN', token: 'tok-main' });
    expect(resolveWriterToken(ARTICLES, SOURCE, { CODEX_SECRET_WRITER_TOKEN: 'tok-main' })).toMatchObject({ usedName: 'CODEX_SECRET_WRITER_TOKEN', token: 'tok-main' });
    expect(resolveWriterToken(ARTICLES, SOURCE, {})).toMatchObject({ name: 'CODEX_SECRET_WRITER_TOKEN_NANAKOKYOBASHI_RGB', usedName: null, token: '' });
  });
});

describe('marker dell\'alert e azione del piano', () => {
  const failed = (extra: Record<string, unknown> = {}) => ({ version: 1, status: 'failed', stage: 'refresh', runId: 7, runAttempt: 1, authDigest: DIGEST_A, consumed: true, ...extra });
  const bot = (body: string, id = 1) => ({ id, body, user: { login: 'github-actions[bot]' } });

  it('round-trip del marker e solo identità di automazione', () => {
    const marker = failed({ pendingTargets: [ARTICLES], failureCode: 'refresh_token_reused' });
    expect(extractRotationMarkers(`testo\n\n${formatRotationMarker(marker)}`)).toEqual([marker]);
    expect(latestRotationMarker([bot(formatRotationMarker(marker)), { body: formatRotationMarker({ ...marker, status: 'succeeded' }), user: { login: 'someone' } }]))
      .toEqual(marker);
    expect(extractRotationMarkers('<!-- CODEX_AUTH_ROTATION: {not json} -->')).toEqual([]);
    expect(extractRotationMarkers(formatRotationMarker({ ...marker, stage: 'Bad Stage' }))).toEqual([]);
  });

  it('blocca il refresh di un login già speso, solo per lo stesso digest', () => {
    const due = { due: true };
    expect(planAction({ decision: due, latestMarker: failed(), currentDigest: DIGEST_A }).action).toBe('blocked');
    expect(planAction({ decision: due, latestMarker: failed(), currentDigest: DIGEST_B }).action).toBe('refresh');
    expect(planAction({ decision: due, latestMarker: null, currentDigest: DIGEST_A, rejected: new Set([DIGEST_A]) }).action).toBe('blocked');
  });

  it('ripropaga (sync) dopo un fallimento non consumante e non fa nulla altrimenti', () => {
    const notDue = { due: false };
    expect(planAction({ decision: notDue, latestMarker: failed({ consumed: false, stage: 'write-secondary' }), currentDigest: DIGEST_B }).action).toBe('sync');
    expect(planAction({ decision: notDue, latestMarker: failed({ status: 'succeeded' }), currentDigest: DIGEST_A }).action).toBe('none');
    expect(planAction({ decision: notDue, latestMarker: null, currentDigest: DIGEST_A }).action).toBe('none');
  });

  it('legge i digest rifiutati dai marker CODEX_AUTH_BLOCKED_RUN dei consumer', () => {
    const blockedRun = `<!-- CODEX_AUTH_BLOCKED_RUN: ${JSON.stringify({ version: 1, status: 'blocked', workflow: 'x', runId: 1, runAttempt: 1, authDigest: DIGEST_A })} -->`;
    expect([...rejectedDigests([bot(blockedRun), { body: blockedRun.replace(DIGEST_A, DIGEST_B), user: { login: 'human' } }])]).toEqual([DIGEST_A]);
  });

  it('reportOutcome registra fallimenti e il successo solo dopo un fallimento', () => {
    const base = { runId: 99, runAttempt: 2 };
    expect(reportOutcome({ ...base, planResult: 'failure', rotateResult: 'skipped', planOutputs: { action: 'blocked', auth_digest: DIGEST_A }, latestMarker: null }))
      .toMatchObject({ kind: 'failed', marker: { stage: 'blocked', consumed: true, authDigest: DIGEST_A, runId: 99, runAttempt: 2 } });
    expect(reportOutcome({ ...base, planResult: 'cancelled', rotateResult: 'skipped', latestMarker: null }).kind).toBe('none');
    const failure = reportOutcome({
      ...base,
      planResult: 'success',
      rotateResult: 'failure',
      planOutputs: { action: 'refresh', auth_digest: DIGEST_A },
      rotateOutputs: { stage: 'write-secondary', consumed: 'false', pending: `${ARTICLES} not/a/repo`, failure_code: '' },
      latestMarker: null,
    });
    expect(failure).toMatchObject({ kind: 'failed', marker: { stage: 'write-secondary', consumed: false, pendingTargets: [ARTICLES] } });
    expect(reportOutcome({ ...base, planResult: 'success', rotateResult: 'success', planOutputs: { action: 'refresh', auth_digest: DIGEST_A }, latestMarker: null }).kind).toBe('none');
    expect(reportOutcome({
      ...base, planResult: 'success', rotateResult: 'success', planOutputs: { action: 'sync', auth_digest: DIGEST_A }, rotateOutputs: { new_digest: DIGEST_B }, latestMarker: failed(),
    })).toMatchObject({ kind: 'succeeded', marker: { status: 'succeeded', stage: 'done', authDigest: DIGEST_B } });
  });

  it('non ripete lo stesso fallimento; il digest conta solo se il login è stato speso', () => {
    expect(sameFailure(failed(), failed({ runId: 8 }))).toBe(true);
    expect(sameFailure(failed(), failed({ authDigest: DIGEST_B }))).toBe(false);
    expect(sameFailure(failed({ consumed: false, stage: 'write-secondary' }), failed({ consumed: false, stage: 'write-secondary', authDigest: DIGEST_B }))).toBe(true);
    expect(sameFailure(failed({ pendingTargets: [ARTICLES] }), failed())).toBe(false);
  });

  it('il testo dell\'alert porta il marker, lo stage e nessun token', () => {
    const marker = failed({ stage: 'write-secondary', consumed: false, pendingTargets: [ARTICLES] });
    const { body, comment } = alertTexts({ marker, runUrl: 'https://github.com/o/r/actions/runs/7', workflow: 'Codex auth rotate', sourceRepo: SOURCE });
    for (const text of [body, comment]) {
      expect(extractRotationMarkers(text)).toEqual([marker]);
      expect(text).toContain(ARTICLES);
    }
    expect(body).toContain('## Codex authentication rotation failed');
    expect(ALERT_TITLE).toBe('Codex auth down: CODEX_AUTH_JSON refresh token rejected');
  });

  it('la copia Remote Config fallita ha il suo stage, con l\'azione per le Cloud Functions', () => {
    const marker = failed({ stage: 'write-remote-config', consumed: false });
    const { body } = alertTexts({ marker, runUrl: 'https://github.com/o/r/actions/runs/8', workflow: 'Codex auth rotate', sourceRepo: SOURCE });
    expect(extractRotationMarkers(body)).toEqual([marker]);
    expect(body).toContain('Stage: `write-remote-config`');
    expect(body).toMatch(/Remote Config copy `CODEX_AUTH_JSON`[\s\S]*never refresh/u);
    expect(body).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
    // Un fallimento non consumante porta la run successiva in sync, che riscrive anche la copia.
    expect(planAction({ decision: { due: false }, latestMarker: marker, currentDigest: DIGEST_A })).toEqual({ action: 'sync' });
  });
});

describe('classifyRefreshLog', () => {
  it('estrae il codice d\'errore dal log di codex_login, anche con colori ANSI', () => {
    const line = '\u001b[2m2026\u001b[0m \u001b[31mERROR\u001b[0m codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_reused"}}';
    expect(classifyRefreshLog(`x INFO codex_login::auth::manager: Refreshing token\n${line}`)).toEqual({ attempts: 1, failed: true, failureCode: 'refresh_token_reused' });
    expect(classifyRefreshLog('codex_login::auth::manager: Failed to refresh token: 400 Bad Request: {"error":"invalid_grant"}').failureCode).toBe('invalid_grant');
    expect(classifyRefreshLog('codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used.').failureCode).toBe('refresh_token_reused');
    expect(classifyRefreshLog('INFO codex_login::auth::manager: Refreshing token')).toEqual({ attempts: 1, failed: false, failureCode: null });
  });
});

// ─── Driver della CLI con un binario finto ─────────────────────────────────

/**
 * Finto `codex app-server`: parla il JSON-RPC su stdio, registra argv/env e,
 * su `account/read {refreshToken:true}`, fa ciò che fa la CLI (rinfresca
 * l'auth.json del CODEX_HOME) secondo `mode`. Stampa di proposito i token su
 * stderr/stdout: il driver non deve inoltrarli.
 */
function fakeCodex(dir: string, mode: 'rotate' | 'http' | 'reject' | 'hang', extra: Record<string, unknown> = {}) {
  const record = path.join(dir, 'fake-codex-record.json');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cfg = ${JSON.stringify({ mode, record, ...extra })};
fs.writeFileSync(cfg.record, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
const authPath = path.join(process.env.CODEX_HOME, 'auth.json');
process.stderr.write('chatty: ' + fs.readFileSync(authPath, 'utf8') + '\\n');
const reply = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (c) => b64({ alg: 'none' }) + '.' + b64(c) + '.sig';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (cfg.mode === 'hang') continue;
    if (msg.method === 'initialize') reply({ id: 0, result: { userAgent: 'fake' } });
    if (msg.method === 'account/read') {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      process.stderr.write('INFO codex_login::auth::manager: Refreshing token\\n');
      if (cfg.mode === 'reject') {
        process.stderr.write('ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: {"error":{"code":"refresh_token_reused"}}\\n');
      } else if (cfg.mode === 'rotate') {
        const now = Math.floor(Date.now() / 1000);
        auth.tokens.access_token = jwt({ exp: now + (cfg.expHours || 240) * 3600, n: 'new' });
        auth.tokens.refresh_token = 'rt_new_fedcba9876543210';
        if (cfg.account) auth.tokens.account_id = cfg.account;
        auth.last_refresh = new Date().toISOString();
        fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
      } else if (cfg.mode === 'http') {
        const res = await fetch(process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: cfg.clientId, grant_type: 'refresh_token', refresh_token: auth.tokens.refresh_token }),
        });
        if (res.ok) {
          const body = await res.json();
          Object.assign(auth.tokens, body);
          auth.last_refresh = new Date().toISOString();
          fs.writeFileSync(authPath, JSON.stringify(auth));
        }
      }
      process.stdout.write('leak ' + JSON.stringify(auth) + '\\n');
      reply({ id: 1, result: { account: null, requiresOpenaiAuth: true } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
  return { bin, readRecord: () => JSON.parse(fs.readFileSync(record, 'utf8')) as { argv: string[]; env: Record<string, string> } };
}

describe('runCliRefresh — la CLI gira ermetica', () => {
  it('fa rinfrescare la CLI, rilegge l\'auth.json e ripulisce il CODEX_HOME', async () => {
    const dir = tmp();
    const { bin, readRecord } = fakeCodex(dir, 'rotate');
    process.env.CODEX_AUTH_JSON_CANARY = 'must-not-leak';
    const before = login();
    const result = await runCliRefresh({ codexBin: bin, authText: JSON.stringify(before), workDir: dir });
    delete process.env.CODEX_AUTH_JSON_CANARY;
    expect(result.rpc).toMatchObject({ initialized: true, accountRead: true });
    expect(result.log).toEqual({ attempts: 1, failed: false, failureCode: null });
    expect(JSON.parse(result.afterText!).tokens.refresh_token).toBe('rt_new_fedcba9876543210');
    const { argv, env } = readRecord();
    expect(argv.slice(0, 5)).toEqual(['app-server', '-c', 'cli_auth_credentials_store="file"', '-c', expect.stringMatching(/^chatgpt_base_url="http:\/\/127\.0\.0\.1:\d+\/backend-api\/"$/u)]);
    // Env costruito da zero: niente token GitHub, segreti o override ereditati.
    for (const key of Object.keys(env)) expect(key, key).toMatch(/^(PATH|HOME|CODEX_HOME|TMPDIR|RUST_LOG|NO_COLOR|(HTTPS?|ALL)_PROXY|(https?|all)_proxy|NO_PROXY|no_proxy)$/u);
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(env.NO_PROXY.split(',')).toEqual(['127.0.0.1', 'localhost', 'auth.openai.com']);
    expect(env.CODEX_REFRESH_TOKEN_URL_OVERRIDE).toBeUndefined();
    expect(env.RUST_LOG).toContain('codex_login=info');
    expect(fs.existsSync(env.CODEX_HOME)).toBe(false);
  });

  it('riporta il rifiuto permanente dell\'authority', async () => {
    const dir = tmp();
    const { bin } = fakeCodex(dir, 'reject');
    const before = JSON.stringify(login());
    const result = await runCliRefresh({ codexBin: bin, authText: before, workDir: dir });
    expect(result.log).toMatchObject({ failed: true, failureCode: 'refresh_token_reused' });
    expect(result.afterText).toBe(before);
  });

  it('su timeout uccide la CLI e rilegge comunque l\'auth.json', async () => {
    const dir = tmp();
    const { bin } = fakeCodex(dir, 'hang');
    const before = JSON.stringify(login());
    const result = await runCliRefresh({ codexBin: bin, authText: before, workDir: dir, timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.afterText).toBe(before);
  });

  it('la prova generale verifica il contratto della richiesta di refresh', async () => {
    const good = tmp();
    const ok = await rehearseRefresh({ codexBin: fakeCodex(good, 'http', { clientId: CODEX_OAUTH_CLIENT_ID }).bin, workDir: good });
    expect(ok).toMatchObject({ ok: true, errors: [] });
    expect(ok.requests).toContain('POST /oauth/token');
    const bad = tmp();
    const ko = await rehearseRefresh({ codexBin: fakeCodex(bad, 'http', { clientId: 'app_other' }).bin, workDir: bad });
    expect(ko.ok).toBe(false);
    expect(ko.errors.join()).toMatch(/client_id differs/u);
  });
});

describe('writeSecret', () => {
  it('passa il valore via stdin, ritenta e oscura token e valore negli errori', async () => {
    const calls: Array<{ args: string[]; input: string; token: string }> = [];
    let failures = 1;
    const runGh = (args: string[], { input, token }: { input: string; token: string }) => {
      calls.push({ args, input, token });
      if (failures-- > 0) return { status: 1, stderr: `HTTP 502 for ${token} ${input}`, error: '' };
      return { status: 0, stderr: '', error: '' };
    };
    const ok = await writeSecret({ target: SOURCE, token: 'ghp_writer', value: '{"v":1}', runGh, sleep: async () => {} });
    expect(ok).toEqual({ ok: true, attempt: 2 });
    expect(calls[0].args).toEqual(['secret', 'set', 'CODEX_AUTH_JSON', '--repo', SOURCE, '--app', 'actions']);
    expect(calls[0].args.join(' ')).not.toContain('{"v":1}');
    expect(calls[0].input).toBe('{"v":1}');
    const ko = await writeSecret({
      target: SOURCE, token: 'ghp_writer', value: '{"v":1}', redactValues: ['rt_secret_value'], sleep: async () => {},
      runGh: () => ({ status: 1, stderr: 'denied ghp_writer {"v":1} rt_secret_value', error: '' }),
    });
    expect(ko).toMatchObject({ ok: false, attempt: 3 });
    expect(ko.detail).toBe('denied *** *** ***');
  });
});

// ─── Comandi end-to-end in un processo figlio ───────────────────────────────

function fakeGh(dir: string, failRepos: string[] = []) {
  const binDir = path.join(dir, 'gh-bin');
  fs.mkdirSync(binDir);
  const log = path.join(dir, 'gh-calls.jsonl');
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const repo = process.argv[process.argv.indexOf('--repo') + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input, token: process.env.GH_TOKEN }) + '\\n');
if (${JSON.stringify(failRepos)}.includes(repo)) { process.stderr.write('HTTP 403: Resource not accessible (' + process.env.GH_TOKEN + ')'); process.exit(1); }
process.stdout.write('✓ Set Actions secret CODEX_AUTH_JSON for ' + repo + ' ' + input + '\\n');
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { binDir, calls };
}

function runCommand(command: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, [SCRIPT, command], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Ogni valore di token compare solo dentro un `::add-mask::`, che il runner non stampa. */
function expectOnlyMasked(stdout: string, values: string[]) {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('::add-mask::')) continue;
    for (const value of values) expect(line, 'token in log').not.toContain(value);
  }
}

describe('comandi refresh + write', () => {
  it('rinfresca, valida, maschera e scrive il sorgente per primo con il token del suo owner', async () => {
    const dir = tmp();
    const { bin } = fakeCodex(dir, 'rotate');
    const gh = fakeGh(dir);
    const stored = JSON.stringify(login(), null, 2);
    const storedAuth = JSON.parse(stored);
    const base = {
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: path.join(dir, 'out.txt'),
      CODEX_AUTH_ROTATE_SOURCE_REPO: SOURCE,
      CODEX_AUTH_ROTATE_TARGETS: DEFAULT_TARGETS.join(' '),
      CODEX_AUTH_ROTATE_ACTION: 'refresh',
    };
    const refresh = runCommand('refresh', {
      ...base, CODEX_AUTH_JSON: stored, CODEX_AUTH_EXPECTED_DIGEST: secretDigest(stored), CODEX_BIN: bin,
    });
    expect(refresh.status, refresh.stdout).toBe(0);
    const outFile = path.join(dir, 'codex-auth-rotate-new-auth.json');
    const fresh = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(fs.statSync(outFile).mode & 0o777).toBe(0o600);
    expect(fresh.tokens.refresh_token).toBe('rt_new_fedcba9876543210');
    const secrets = [storedAuth.tokens.access_token, storedAuth.tokens.refresh_token, fresh.tokens.access_token, fresh.tokens.refresh_token, fresh.tokens.id_token];
    expectOnlyMasked(refresh.stdout + refresh.stderr, secrets);
    const firstMask = refresh.stdout.split('\n').findIndex((line) => line.includes(fresh.tokens.refresh_token));
    expect(firstMask).toBeGreaterThanOrEqual(0);
    expect(refresh.stdout.split('\n')[firstMask]).toMatch(/^::add-mask::/u);

    const write = runCommand('write', {
      ...base,
      PATH: `${gh.binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      CODEX_SECRET_WRITER_TOKEN: 'tok-valerie',
      CODEX_SECRET_WRITER_TOKEN_NANAKOKYOBASHI_RGB: 'tok-nanako',
    });
    expect(write.status, write.stdout).toBe(0);
    const calls = gh.calls();
    expect(calls.map((call) => [call.args[4], call.token])).toEqual([[SOURCE, 'tok-valerie'], [ARTICLES, 'tok-nanako']]);
    expect(calls.every((call) => call.input === fs.readFileSync(outFile, 'utf8'))).toBe(true);
    expectOnlyMasked(write.stdout + write.stderr, [...secrets, 'tok-valerie', 'tok-nanako']);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'codex-auth-rotate-state.json'), 'utf8'));
    expect(state).toMatchObject({ stage: 'done', written: [SOURCE, ARTICLES], pending: [], consumed: false });
  });

  it('un secondario non scrivibile lascia il sorgente fresco e fallisce rumorosamente', () => {
    const dir = tmp();
    const gh = fakeGh(dir, [ARTICLES]);
    fs.writeFileSync(path.join(dir, 'codex-auth-rotate-new-auth.json'), JSON.stringify(login({ tag: 'new' })), { mode: 0o600 });
    const write = runCommand('write', {
      RUNNER_TEMP: dir,
      PATH: `${gh.binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      CODEX_AUTH_ROTATE_SOURCE_REPO: SOURCE,
      CODEX_AUTH_ROTATE_TARGETS: '',
      CODEX_AUTH_ROTATE_ACTION: 'refresh',
      CODEX_AUTH_ROTATE_RETRY_DELAY_MS: '1',
      CODEX_SECRET_WRITER_TOKEN: 'tok-valerie',
      CODEX_SECRET_WRITER_TOKEN_NANAKOKYOBASHI_RGB: 'tok-nanako',
    });
    expect(write.status).toBe(1);
    expect(write.stdout).toMatch(/::error::.*NOT in nanakokyobashi-rgb\/frontaliere-articles/u);
    expect(write.stdout).not.toContain('tok-nanako');
    expect(gh.calls().filter((call) => call.args[4] === ARTICLES)).toHaveLength(3);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'codex-auth-rotate-state.json'), 'utf8'));
    expect(state).toMatchObject({ stage: 'write-secondary', written: [SOURCE], pending: [ARTICLES], consumed: false });
  });

  it('se il sorgente non riceve il login nuovo lo marca come speso', () => {
    const dir = tmp();
    const gh = fakeGh(dir, [SOURCE]);
    fs.writeFileSync(path.join(dir, 'codex-auth-rotate-new-auth.json'), JSON.stringify(login({ tag: 'new' })), { mode: 0o600 });
    const write = runCommand('write', {
      RUNNER_TEMP: dir,
      PATH: `${gh.binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      CODEX_AUTH_ROTATE_SOURCE_REPO: SOURCE,
      CODEX_AUTH_ROTATE_ACTION: 'refresh',
      CODEX_AUTH_ROTATE_RETRY_DELAY_MS: '1',
      CODEX_SECRET_WRITER_TOKEN: 'tok-valerie',
      CODEX_SECRET_WRITER_TOKEN_NANAKOKYOBASHI_RGB: 'tok-nanako',
    });
    expect(write.status).toBe(1);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'codex-auth-rotate-state.json'), 'utf8'));
    expect(state).toMatchObject({ stage: 'write-primary', written: [ARTICLES], pending: [SOURCE], consumed: true });
  });

  it('non rinfresca un secret diverso da quello valutato dal plan (ombra dell\'environment)', () => {
    const dir = tmp();
    const stored = JSON.stringify(login());
    const refresh = runCommand('refresh', {
      RUNNER_TEMP: dir, CODEX_AUTH_JSON: stored, CODEX_AUTH_EXPECTED_DIGEST: DIGEST_A, CODEX_AUTH_ROTATE_ACTION: 'refresh', CODEX_BIN: '/nonexistent',
    });
    expect(refresh.status).toBe(1);
    expect(refresh.stdout).toMatch(/differs from the one the plan job evaluated/u);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'codex-auth-rotate-state.json'), 'utf8')).stage).toBe('drift');
  });

  it('un rifiuto dell\'authority non scrive nulla e marca il login come speso', () => {
    const dir = tmp();
    const { bin } = fakeCodex(dir, 'reject');
    const stored = JSON.stringify(login());
    const refresh = runCommand('refresh', {
      RUNNER_TEMP: dir, CODEX_AUTH_JSON: stored, CODEX_AUTH_EXPECTED_DIGEST: secretDigest(stored), CODEX_AUTH_ROTATE_ACTION: 'refresh', CODEX_BIN: bin,
    });
    expect(refresh.status).toBe(1);
    expect(fs.existsSync(path.join(dir, 'codex-auth-rotate-new-auth.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'codex-auth-rotate-state.json'), 'utf8')))
      .toMatchObject({ stage: 'refresh', consumed: true, failureCode: 'refresh_token_reused' });
    expectOnlyMasked(refresh.stdout + refresh.stderr, [JSON.parse(stored).tokens.refresh_token]);
  });
});

// ─── Copia per le Cloud Functions in Remote Config ─────────────────────────

describe('remoteConfigLogin — la copia per functions/src/codexFallback.js', () => {
  it('stesso formato auth.json, senza refresh_token né OPENAI_API_KEY', () => {
    const auth: Record<string, any> = { auth_mode: 'chatgpt', ...login() };
    const copy = JSON.parse(remoteConfigLogin(auth));
    expect(copy).toEqual({
      auth_mode: 'chatgpt',
      tokens: { id_token: auth.tokens.id_token, access_token: auth.tokens.access_token, account_id: auth.tokens.account_id },
      last_refresh: auth.last_refresh,
    });
    expect(JSON.stringify(copy)).not.toContain(auth.tokens.refresh_token);
    expect(REMOTE_CONFIG_PARAM).toBe('CODEX_AUTH_JSON');
  });
});

type RcCall = { url: string; method: string; ifMatch: string | null; body: any };

/** Remote Config REST finto: GET → template + ETag, PUT con If-Match; `conflicts` PUT rifiutate con 409. */
function fakeRemoteConfig({ template = { parameters: {} } as any, conflicts = 0, putStatus = 200 } = {}) {
  let etag = 1;
  let current = structuredClone(template);
  let conflictsLeft = conflicts;
  const calls: RcCall[] = [];
  const fetchImpl = async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method, ifMatch: init.headers?.['If-Match'] ?? null, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'GET') return new Response(JSON.stringify({ ...current, version: { versionNumber: String(etag) } }), { status: 200, headers: { etag: `etag-${etag}` } });
    if (conflictsLeft > 0) {
      conflictsLeft -= 1;
      // Un altro writer ha pubblicato nel frattempo: il suo parametro deve sopravvivere.
      current = { ...current, parameters: { ...current.parameters, OTHER_WRITER: { defaultValue: { value: `v${etag}` } } } };
      etag += 1;
      return new Response(JSON.stringify({ error: { status: 'ABORTED', message: 'etag mismatch' } }), { status: 409 });
    }
    if (putStatus !== 200) return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'denied' } }), { status: putStatus });
    const body = JSON.parse(init.body);
    current = { conditions: body.conditions, parameters: body.parameters, parameterGroups: body.parameterGroups };
    etag += 1;
    return new Response('{}', { status: 200, headers: { etag: `etag-${etag}` } });
  };
  return { fetchImpl, calls, current: () => current };
}

const SA = { client_email: 'rc-writer@example.iam.gserviceaccount.com', private_key: 'unused', project_id: 'frontaliere-test' };
const RC_URL = 'https://firebaseremoteconfig.googleapis.com/v1/projects/frontaliere-test/remoteConfig';

describe('setRcParamWithEtag — concorrenza ottimistica sul template', () => {
  const base = { credentials: SA, name: 'CODEX_AUTH_JSON', value: '{"tokens":{}}', sleep: async () => {}, getAccessToken: async () => 'ya29.fake' };

  it('scrive con If-Match dell\'ETag letto e preserva il resto del template', async () => {
    const rc = fakeRemoteConfig({ template: { parameters: { KEEP: { defaultValue: { value: 'k' } } }, conditions: [{ name: 'c', expression: 'true' }] } });
    const scopes: string[] = [];
    const result = await setRcParamWithEtag({ ...base, fetchImpl: rc.fetchImpl, getAccessToken: async (_c: unknown, scope: string) => { scopes.push(scope); return 'ya29.fake'; } });
    expect(result).toEqual({ ok: true, changed: true, attempt: 1 });
    expect(scopes).toEqual([RC_SCOPE]);
    expect(rc.calls.map((call) => [call.method, call.url, call.ifMatch])).toEqual([['GET', RC_URL, null], ['PUT', RC_URL, 'etag-1']]);
    const put = rc.calls[1].body;
    expect(put.parameters.KEEP).toEqual({ defaultValue: { value: 'k' } });
    expect(put.parameters.CODEX_AUTH_JSON).toMatchObject({ defaultValue: { value: '{"tokens":{}}' }, valueType: 'STRING' });
    expect(put.conditions).toEqual([{ name: 'c', expression: 'true' }]);
    expect(put.version).toEqual({ description: 'set CODEX_AUTH_JSON' });
  });

  it('su conflitto di ETag rilegge e riapplica sopra la versione nuova, mai con If-Match: *', async () => {
    const rc = fakeRemoteConfig({ conflicts: 2 });
    const result = await setRcParamWithEtag({ ...base, fetchImpl: rc.fetchImpl });
    expect(result).toEqual({ ok: true, changed: true, attempt: 3 });
    expect(rc.calls.map((call) => `${call.method}:${call.ifMatch ?? ''}`)).toEqual(['GET:', 'PUT:etag-1', 'GET:', 'PUT:etag-2', 'GET:', 'PUT:etag-3']);
    expect(rc.calls.some((call) => call.ifMatch === '*')).toBe(false);
    expect(rc.current().parameters).toMatchObject({ OTHER_WRITER: { defaultValue: { value: 'v2' } }, CODEX_AUTH_JSON: { defaultValue: { value: '{"tokens":{}}' } } });
  });

  it('conflitti oltre i tentativi → fallimento con dettaglio, senza valori', async () => {
    const rc = fakeRemoteConfig({ conflicts: 10 });
    const result = await setRcParamWithEtag({ ...base, fetchImpl: rc.fetchImpl, attempts: 3 });
    expect(result).toEqual({ ok: false, attempt: 3, detail: 'PUT remoteConfig → HTTP 409 (ABORTED: etag mismatch)' });
    expect(rc.calls.filter((call) => call.method === 'PUT')).toHaveLength(3);
  });

  it('dry run: legge e confronta, nessuna PUT', async () => {
    const rc = fakeRemoteConfig();
    expect(await setRcParamWithEtag({ ...base, fetchImpl: rc.fetchImpl, dryRun: true })).toEqual({ ok: true, changed: true, dryRun: true, attempt: 1 });
    expect(rc.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('valore già uguale: nessuna PUT; permesso negato: nessun retry', async () => {
    const same = fakeRemoteConfig({ template: { parameters: { CODEX_AUTH_JSON: { defaultValue: { value: base.value } } } } });
    expect(await setRcParamWithEtag({ ...base, fetchImpl: same.fetchImpl })).toEqual({ ok: true, changed: false, attempt: 1 });
    expect(same.calls.map((call) => call.method)).toEqual(['GET']);
    const denied = fakeRemoteConfig({ putStatus: 403 });
    expect(await setRcParamWithEtag({ ...base, fetchImpl: denied.fetchImpl })).toEqual({ ok: false, attempt: 1, detail: 'PUT remoteConfig → HTTP 403 (PERMISSION_DENIED: denied)' });
  });

  it('un parametro dentro un gruppo non si duplica al top level (le functions leggono solo quello)', () => {
    const template = { parameters: {}, parameterGroups: { secrets: { parameters: { CODEX_AUTH_JSON: { defaultValue: { value: 'x' } } } } } };
    expect(stageRcParamValue(template, 'CODEX_AUTH_JSON', 'y', '')).toMatchObject({ changed: false, error: expect.stringMatching(/parameter group "secrets"/u) });
  });
});

/**
 * Preload per il processo figlio: sostituisce fetch con l'authority OAuth di
 * Google e Remote Config finti, e registra ogni chiamata (mai la rete).
 */
function fakeGoogle(dir: string, { conflicts = 0 } = {}) {
  const log = path.join(dir, 'google-calls.jsonl');
  const preload = path.join(dir, 'fake-google.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
let etag = 1;
let conflictsLeft = ${conflicts};
let template = { parameters: { KEEP: { defaultValue: { value: 'k' } } } };
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  const headers = init.headers ?? {};
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), method, ifMatch: headers['If-Match'] ?? null, auth: headers.Authorization ?? null, body: typeof init.body === 'string' ? init.body : null }) + '\\n');
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'ya29.google-access-token-value' }), { status: 200 });
  }
  if (method === 'GET') return new Response(JSON.stringify(template), { status: 200, headers: { etag: 'etag-' + etag } });
  if (conflictsLeft > 0) { conflictsLeft -= 1; etag += 1; return new Response(JSON.stringify({ error: { status: 'ABORTED', message: 'etag mismatch' } }), { status: 409 }); }
  template = JSON.parse(init.body);
  etag += 1;
  return new Response('{}', { status: 200, headers: { etag: 'etag-' + etag } });
};
`);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { preload, calls };
}

function runWithPreload(preload: string, command: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, SCRIPT, command], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('comando write-remote-config', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const serviceAccount = JSON.stringify({ type: 'service_account', project_id: 'frontaliere-test', client_email: 'rc-writer@example.iam.gserviceaccount.com', private_key: privateKey });

  function prepared(stage = 'done') {
    const dir = tmp();
    const fresh = login({ tag: 'new' });
    fs.writeFileSync(path.join(dir, 'codex-auth-rotate-new-auth.json'), JSON.stringify(fresh), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'codex-auth-rotate-state.json'), JSON.stringify({ stage, consumed: false }), { mode: 0o600 });
    const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'codex-auth-rotate-state.json'), 'utf8'));
    return { dir, fresh, state };
  }

  it('copia il login senza refresh_token con If-Match, ritenta il conflitto e non stampa alcun valore', () => {
    const { dir, fresh, state } = prepared();
    const google = fakeGoogle(dir, { conflicts: 1 });
    const run = runWithPreload(google.preload, 'write-remote-config', {
      RUNNER_TEMP: dir, FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount, CODEX_AUTH_ROTATE_RETRY_DELAY_MS: '1',
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const calls = google.calls();
    expect(calls.map((call) => `${call.method}:${call.ifMatch ?? ''}`)).toEqual(['POST:', 'GET:', 'PUT:etag-1', 'GET:', 'PUT:etag-2']);
    expect(calls.filter((call) => call.method !== 'POST').every((call) => call.url === RC_URL && call.auth === 'Bearer ya29.google-access-token-value')).toBe(true);
    const written = JSON.parse(calls.at(-1).body);
    expect(written.parameters.KEEP).toEqual({ defaultValue: { value: 'k' } });
    const value = written.parameters.CODEX_AUTH_JSON.defaultValue.value;
    expect(value).toBe(remoteConfigLogin(fresh));
    expect(value).not.toContain(fresh.tokens.refresh_token);
    expectOnlyMasked(run.stdout + run.stderr, [fresh.tokens.access_token, fresh.tokens.id_token, fresh.tokens.refresh_token, 'ya29.google-access-token-value', value]);
    expect(run.stdout).toContain('::add-mask::ya29.google-access-token-value');
    expect(run.stdout).toMatch(/Remote Config CODEX_AUTH_JSON updated \(attempt 2, refresh_token omitted\)/u);
    expect(state()).toMatchObject({ stage: 'done', remoteConfig: 'written' });
  });

  it('dry run: nessuna PUT, stato invariato', () => {
    const { dir, state } = prepared();
    const google = fakeGoogle(dir);
    const run = runWithPreload(google.preload, 'write-remote-config', {
      RUNNER_TEMP: dir, FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount, CODEX_AUTH_ROTATE_DRY_RUN: 'true',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(google.calls().map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(run.stdout).toMatch(/Dry run: .*nothing was written/u);
    expect(state()).toMatchObject({ stage: 'done', remoteConfig: 'dry-run' });
  });

  it('senza service account fallisce con il suo stage, senza coprire uno stage più grave', () => {
    const ok = prepared('done');
    const run = runCommand('write-remote-config', { RUNNER_TEMP: ok.dir });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/::error::FIREBASE_SERVICE_ACCOUNT_JSON is missing/u);
    expect(ok.state()).toMatchObject({ stage: 'write-remote-config', remoteConfig: 'failed', consumed: false });
    expectOnlyMasked(run.stdout, [ok.fresh.tokens.access_token, ok.fresh.tokens.refresh_token]);

    const worse = prepared('write-secondary');
    expect(runCommand('write-remote-config', { RUNNER_TEMP: worse.dir, FIREBASE_SERVICE_ACCOUNT_JSON: '{"not":"a service account"}' }).status).toBe(1);
    expect(worse.state()).toMatchObject({ stage: 'write-secondary', remoteConfig: 'failed' });
  });
});

describe('CODEX_AUTH_JSON non arriva mai alla CI da Remote Config', () => {
  it('non è mappato in RC_TO_ENV, né come chiave né come variabile d\'arrivo', () => {
    expect(RC_TO_ENV).not.toHaveProperty(REMOTE_CONFIG_PARAM);
    expect(Object.values(RC_TO_ENV).flat()).not.toContain('CODEX_AUTH_JSON');
  });
});

// ─── Wiring del workflow ────────────────────────────────────────────────────

const WORKFLOW_TEXT = fs.readFileSync(path.resolve('.github/workflows/codex-auth-rotate.yml'), 'utf8');
const WORKFLOW = YAML.parse(WORKFLOW_TEXT) as Record<string, any>;
type Step = { name?: string; id?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
const jobSteps = (job: string): Step[] => WORKFLOW.jobs[job].steps;

describe('workflow codex-auth-rotate.yml', () => {
  it('un solo rinfrescatore globale, mai cancellato a metà', () => {
    expect(WORKFLOW.concurrency).toEqual({ group: 'codex-auth-rotate', 'cancel-in-progress': false });
    for (const job of Object.values<any>(WORKFLOW.jobs)) expect(job.concurrency).toBeUndefined();
  });

  it('cron ogni SCHEDULE_INTERVAL_HOURS ore e input force/dry_run booleani', () => {
    expect(WORKFLOW.on.schedule).toEqual([{ cron: `41 */${SCHEDULE_INTERVAL_HOURS} * * *` }]);
    const inputs = WORKFLOW.on.workflow_dispatch.inputs;
    expect(inputs.force).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.dry_run).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.targets).toMatchObject({ type: 'string', default: '' });
  });

  it('permessi minimi per job', () => {
    expect(WORKFLOW.permissions).toEqual({});
    expect(WORKFLOW.jobs.plan.permissions).toEqual({ contents: 'read', issues: 'read' });
    expect(WORKFLOW.jobs.rotate.permissions).toEqual({ contents: 'read' });
    expect(WORKFLOW.jobs.report.permissions).toEqual({ contents: 'read', issues: 'write' });
    for (const job of Object.keys(WORKFLOW.jobs)) {
      const checkout = jobSteps(job).find((step) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with?.['persist-credentials'], job).toBe(false);
    }
  });

  it('il job che scrive gira solo su main, fuori dal dry run, nell\'environment dedicato', () => {
    const rotate = WORKFLOW.jobs.rotate;
    expect(rotate.environment).toBe('codex-auth-rotation');
    expect(rotate.if).toContain("inputs.dry_run != true");
    expect(rotate.if).toContain("github.ref == 'refs/heads/main'");
    expect(rotate.if).toContain("needs.plan.result == 'success'");
    expect(WORKFLOW.jobs.report.if).toContain("inputs.dry_run != true");
    expect(WORKFLOW.jobs.report.if).toContain("github.ref == 'refs/heads/main'");
    // Il dry run non installa la CLI per un refresh reale né scrive: solo plan + prova offline.
    const dryRunSteps = jobSteps('plan').filter((step) => step.if === 'inputs.dry_run == true');
    expect(dryRunSteps.map((step) => step.run?.includes('rehearse') || step.id === 'codex_cli')).toEqual([true, true]);
    expect(WORKFLOW_TEXT).not.toMatch(/codex-auth-rotate\.mjs (refresh|write)[\s\S]*dry_run == true/u);
  });

  it('il segreto e i token di scrittura arrivano solo agli step che li usano', () => {
    const stepsWith = (needle: string) => Object.entries<any>(WORKFLOW.jobs).flatMap(([job, def]) =>
      (def.steps as Step[]).filter((step) => JSON.stringify(step.env ?? {}).includes(needle)).map((step) => `${job}:${step.id ?? step.name}`));
    expect(stepsWith('secrets.CODEX_AUTH_JSON')).toEqual(['plan:plan', 'rotate:refresh']);
    expect(stepsWith('secrets.CODEX_SECRET_WRITER_TOKEN')).toEqual(['rotate:preflight', 'rotate:write']);
    expect(stepsWith('secrets.FIREBASE_SERVICE_ACCOUNT_JSON')).toEqual(['rotate:write_remote_config']);
    for (const job of Object.values<any>(WORKFLOW.jobs)) expect(JSON.stringify(job.env ?? {})).not.toContain('secrets.');
    expect(JSON.stringify(WORKFLOW.env)).not.toContain('secrets.');
  });

  it('la copia Remote Config segue la scrittura dei secret e precede la pulizia, solo col refresh validato', () => {
    const steps = jobSteps('rotate');
    const index = (id: string) => steps.findIndex((step) => step.id === id || step.name === id);
    const copy = steps[index('write_remote_config')];
    expect(copy.run).toBe('node scripts/ci/codex-auth-rotate.mjs write-remote-config');
    expect(copy.if).toContain('!cancelled()');
    expect(copy.if).toContain("steps.refresh.outcome == 'success'");
    expect(index('write')).toBeLessThan(index('write_remote_config'));
    expect(index('write_remote_config')).toBeLessThan(index('Remove the refreshed auth.json from the runner'));
    expect(index('write_remote_config')).toBeLessThan(index('summary'));
    // Mai nel job plan (che gira anche in dry run).
    expect(JSON.stringify(jobSteps('plan'))).not.toContain('write-remote-config');
  });

  it('ogni owner dei target di default riceve il suo token di scrittura', () => {
    const [source, ...others] = DEFAULT_TARGETS;
    const sourceOwner = source.split('/')[0];
    for (const id of ['preflight', 'write']) {
      const env = jobSteps('rotate').find((step) => step.id === id)!.env!;
      for (const target of [source, ...others]) {
        const name = writerTokenEnvName(target.split('/')[0], sourceOwner);
        expect(env[name], `${id}:${name}`).toBe(`\${{ secrets.${name} }}`);
      }
    }
    expect(WORKFLOW.env.CODEX_AUTH_ROTATE_TARGETS).toContain(`'${DEFAULT_TARGETS.join(' ')}'`);
    expect(WORKFLOW.env.CODEX_AUTH_ROTATE_SOURCE_REPO).toBe('${{ github.repository }}');
  });

  it('nessun token nei log: niente set -x, niente espressioni secrets/inputs dentro run', () => {
    for (const job of Object.values<any>(WORKFLOW.jobs)) {
      for (const step of job.steps as Step[]) {
        if (!step.run) continue;
        expect(step.run).not.toMatch(/set -[a-z]*x|set -o xtrace|xtrace/u);
        expect(step.run).not.toMatch(/\$\{\{\s*(secrets|inputs|github\.event)\./u);
        expect(step.run).not.toMatch(/(echo|printf)[^\n]*\$\{?(CODEX_AUTH_JSON|CODEX_SECRET_WRITER_TOKEN|GITHUB_TOKEN)/u);
      }
    }
  });

  it('pin della CLI e politica coincidono con lo script e con le action consumer', () => {
    expect(WORKFLOW.env.CODEX_CLI_VERSION).toBe(CODEX_CLI_VERSION);
    const fallback = fs.readFileSync(path.resolve('.github/actions/claude-codex-fallback/action.yml'), 'utf8');
    const haiku = fs.readFileSync(path.resolve('.github/actions/setup-claude-haiku-fallback/action.yml'), 'utf8');
    const broker = fs.readFileSync(path.resolve('.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs'), 'utf8');
    for (const text of [fallback, haiku]) expect(text).toContain(`@openai/codex@${CODEX_CLI_VERSION}`);
    expect(broker).toContain(`const CODEX_CLI_VERSION = '${CODEX_CLI_VERSION}';`);
    const { policy, errors } = parsePolicy(WORKFLOW.env);
    expect(errors).toEqual([]);
    expect(policy).toEqual({ ...DEFAULT_POLICY });
  });

  it('il run-name marca il dry run come lo riconosce codex-auth-recovery', () => {
    expect(WORKFLOW['run-name']).toContain("'Codex auth rotate (dry run)'");
    const recovery = fs.readFileSync(path.resolve('.github/workflows/codex-auth-recovery.yml'), 'utf8');
    expect(recovery).toContain('/\\(dry run\\)/u.test(String(run.display_title');
    expect(WORKFLOW.name).toBe('Codex auth rotate');
    expect((YAML.parse(recovery) as any).on.workflow_run.workflows).toContain(WORKFLOW.name);
  });

  it('describeLogin espone la durata del token per il riepilogo', () => {
    const info = describeLogin(login({ expInHours: 216 }), NOW);
    expect(info.lifetimeHours).toBeCloseTo(240, 0);
  });
});
