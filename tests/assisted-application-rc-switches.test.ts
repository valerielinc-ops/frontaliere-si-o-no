import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLAIN_WORD_RC_KEYS, RC_TO_ENV } from '../scripts/load-rc-env.mjs';
import { RC_PROJECT_ID, RC_SWITCHES, run } from '../scripts/assisted-application/rc-switches.mjs';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = 'scripts/assisted-application/rc-switches.mjs';
const RENDERER = 'ASSISTED_APPLICATION_PDF_RENDERER';
const DOSSIER = 'ASSISTED_APPLICATION_DOSSIER_MODE';
const INPLACE = 'ASSISTED_APPLICATION_DOCX_INPLACE';
const RC_URL = `https://firebaseremoteconfig.googleapis.com/v1/projects/${RC_PROJECT_ID}/remoteConfig`;

// An invented service account: the key is never used, the token exchange is replaced.
const SA = { client_email: 'rc-switches@example.iam.gserviceaccount.com', private_key: 'invented-private-key', project_id: RC_PROJECT_ID };
const OTHER_SECRET = 'invented-secret-value';

/** A template with everything the tool must leave alone: other parameters, a condition, a group, conditional values. */
const template = (switches: Record<string, any> = {}) => ({
  conditions: [{ name: 'ios', expression: "device.os == 'ios'", tagColor: 'BLUE' }],
  parameters: {
    RESEND_API_KEY: { defaultValue: { value: OTHER_SECRET }, description: 'Resend', valueType: 'STRING' },
    ENABLE_JOB_ALERTS: { defaultValue: { value: 'true' }, conditionalValues: { ios: { value: 'false' } }, valueType: 'BOOLEAN' },
    ...switches,
  },
  parameterGroups: { experiments: { description: 'A/B', parameters: { JOBGATE_EXPERIMENT_FORCE: { defaultValue: { useInAppDefault: true } } } } },
});

type RcCall = { method: string; url: string; ifMatch: string | null; body: any };

/**
 * A fake Remote Config REST endpoint: GET → the template with its ETag, PUT →
 * the new template, PUT `?validate_only=true` → the check alone, no write.
 * `putStatus` rejects the PUT; `validateStatus` rejects the check; `undone`
 * accepts the PUT and then loses it, as a forced publish by another writer
 * would; `readBackStatus` answers the GET after a PUT. `trace` keeps the
 * requests and (see `cli`) the printed lines in the order they happened.
 */
function fakeRemoteConfig(initial: any, { putStatus = 200, validateStatus = 200, undone = false, readBackStatus = 200 } = {}) {
  let version = 41;
  let getStatus = 200;
  let current = structuredClone(initial);
  const calls: RcCall[] = [];
  const trace: string[] = [];
  const fetchImpl = async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    const validateOnly = String(url).endsWith('?validate_only=true');
    trace.push(validateOnly ? `${method} validate_only` : method);
    calls.push({ method, url: String(url), ifMatch: init.headers?.['If-Match'] ?? null, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'GET') {
      if (getStatus !== 200) return new Response('{}', { status: getStatus });
      return new Response(JSON.stringify({ ...current, version: { versionNumber: String(version) } }), { status: 200, headers: { etag: `etag-${version}` } });
    }
    if (validateOnly) {
      if (validateStatus !== 200) {
        return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: '[VALIDATION_ERROR]: invented refusal' } }), { status: validateStatus });
      }
      // Remote Config answers a successful check with the ETag suffixed -0, and keeps the template as it was.
      return new Response('{}', { status: 200, headers: { etag: `etag-${version}-0` } });
    }
    if (putStatus !== 200) {
      return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION', message: 'the template changed' } }), { status: putStatus });
    }
    const body = JSON.parse(init.body);
    if (!undone) current = { conditions: body.conditions, parameters: body.parameters, parameterGroups: body.parameterGroups };
    version += 1;
    getStatus = readBackStatus;
    return new Response('{}', { status: 200, headers: { etag: `etag-${version}` } });
  };
  return { fetchImpl, calls, trace, current: () => current };
}

async function cli(argv: string[], rc = fakeRemoteConfig(template()), env: Record<string, string> = { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(SA) }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    env,
    out: (line: string) => { out.push(line); rc.trace.push(line); },
    err: (line: string) => { err.push(line); rc.trace.push(line); },
    fetchImpl: rc.fetchImpl,
    getAccessToken: async () => 'ya29.invented',
    sleep: async () => {},
  });
  return { code, out, err, calls: rc.calls, printed: [...out, ...err].join('\n') };
}

describe('the table of the switches', () => {
  const keys = Object.keys(RC_SWITCHES);

  it('holds the keys the loader exports to the runner and never masks', () => {
    expect(keys).toEqual([RENDERER, DOSSIER, INPLACE]);
    expect([...keys].sort()).toEqual([...PLAIN_WORD_RC_KEYS].sort());
    for (const key of keys) expect((RC_TO_ENV as Record<string, string[]>)[key], key).toContain(key);
  });

  it('accepts the values of each switch, and only values the code reads as themselves', async () => {
    expect(RC_SWITCHES[RENDERER].values).toEqual(expect.arrayContaining(['typst', 'legacy']));
    expect(RC_SWITCHES[DOSSIER].values).toEqual(expect.arrayContaining(['separate', 'single']));
    expect(RC_SWITCHES[INPLACE].values).toEqual(expect.arrayContaining(['off', 'on']));
    for (const key of keys) {
      const { values, read } = RC_SWITCHES[key];
      // A value the runner would read as something else must not be offered: it would be set and ignored.
      for (const value of values) expect(await read(value), `${key}=${value}`).toBe(value);
      // An absent or unknown value falls to a behaviour of the table, never to a third one.
      for (const value of ['', 'something-else']) expect(values, `${key}=${value}`).toContain(await read(value));
    }
  });

  it('describes a parameter with the sentence of its comment in RC_TO_ENV', () => {
    const loader = fs.readFileSync(path.join(ROOT, 'scripts', 'load-rc-env.mjs'), 'utf8');
    for (const key of keys) {
      const comment = new RegExp(`^ *// (.+)\\n *${key}:`, 'm').exec(loader)?.[1];
      expect(comment, key).toBeTruthy();
      expect(RC_SWITCHES[key].description, key).toBe(comment);
    }
  });

  // firebase-admin documents a parameter description as "Should not be over 100 characters".
  it('keeps each description within the 100 characters of a Remote Config parameter description', () => {
    for (const key of keys) expect(RC_SWITCHES[key].description.length, key).toBeLessThanOrEqual(100);
  });
});

describe('status', () => {
  it('says for each switch whether it exists, its value and what the code does with it', async () => {
    const rc = fakeRemoteConfig(template({
      [DOSSIER]: { defaultValue: { value: 'single' } },
      [INPLACE]: { defaultValue: { value: 'yes' } },
    }));
    const result = await cli(['status'], rc);
    expect(result.code, result.printed).toBe(0);
    expect(result.out).toEqual([
      `Remote Config ${RC_PROJECT_ID}, template version 41`,
      `${RENDERER}: absent -> typst (default, parameter absent)`,
      `${DOSSIER}: "single" -> single`,
      `${INPLACE}: "yes" -> off (the value is not one of: off | on)`,
    ]);
    expect(rc.calls.map((call) => [call.method, call.url])).toEqual([['GET', RC_URL]]);
  });

  it('reads an empty value, a missing default and an unusual spelling as the code does', async () => {
    const result = await cli(['status'], fakeRemoteConfig(template({
      [RENDERER]: { defaultValue: { value: '' } },
      [DOSSIER]: { defaultValue: { useInAppDefault: true } },
      [INPLACE]: { defaultValue: { value: ' ON ' } },
    })));
    expect(result.out.slice(1)).toEqual([
      `${RENDERER}: "" -> typst (default, no value)`,
      `${DOSSIER}: no literal default -> separate (default, no value)`,
      `${INPLACE}: " ON " -> on (the value is not one of: off | on)`,
    ]);
  });

  it('prints nothing about any other parameter', async () => {
    const result = await cli(['status']);
    expect(result.printed).not.toMatch(/RESEND|ENABLE_JOB_ALERTS|JOBGATE|experiments/);
    expect(result.printed).not.toContain(OTHER_SECRET);
  });

  // The console can move a parameter into a group; the loader and the Functions read template.parameters only.
  it('names the parameter group that hides a switch from its readers', async () => {
    const grouped = template();
    grouped.parameterGroups.experiments.parameters[RENDERER] = { defaultValue: { value: 'legacy' } };
    const result = await cli(['status'], fakeRemoteConfig(grouped));
    expect(result.code, result.printed).toBe(0);
    expect(result.out.slice(1)).toEqual([
      `${RENDERER}: "legacy" in parameter group "experiments" -> typst (default: the loader and the Functions read top-level parameters only)`,
      `${DOSSIER}: absent -> separate (default, parameter absent)`,
      `${INPLACE}: absent -> off (default, parameter absent)`,
    ]);
  });
});

describe('set', () => {
  const existing = { defaultValue: { value: 'separate' }, conditionalValues: { ios: { value: 'single' } }, description: 'as the owner wrote it', valueType: 'STRING' };
  const request = ['set', `${RENDERER}=legacy`, `${DOSSIER}=single`];

  it('is a dry run by default: the plan, checked by Remote Config, and no write', async () => {
    const rc = fakeRemoteConfig(template({ [DOSSIER]: existing }));
    const result = await cli(request, rc);
    expect(result.code, result.printed).toBe(0);
    expect(result.out).toEqual([
      `Remote Config ${RC_PROJECT_ID}, template version 41`,
      `~ ${RENDERER}: absent -> "legacy"`,
      `~ ${DOSSIER}: "separate" -> "single"`,
      'validate_only: OK, Remote Config accepts this template.',
      'Dry run: nothing was written. Re-run with --apply to publish.',
    ]);
    // The only PUT is the check (validate_only), under the ETag it read and with the body --apply would publish.
    expect(rc.calls.map((call) => [call.method, call.url, call.ifMatch])).toEqual([['GET', RC_URL, null], ['PUT', `${RC_URL}?validate_only=true`, 'etag-41']]);
    const applied = await cli([...request, '--apply'], fakeRemoteConfig(template({ [DOSSIER]: existing })));
    expect(rc.calls[1].body).toEqual(applied.calls[1].body);
    expect(rc.trace.slice(0, 5)).toEqual(['GET', ...result.out.slice(0, 3), 'PUT validate_only']);
    expect(rc.current()).toEqual(template({ [DOSSIER]: existing }));
  });

  it('fails a dry run that Remote Config refuses, which --apply would not publish either', async () => {
    const before = template({ [DOSSIER]: existing });
    const rc = fakeRemoteConfig(before, { validateStatus: 400 });
    const result = await cli(request, rc);
    expect(result.code).toBe(1);
    expect(rc.calls.map((call) => [call.method, call.url])).toEqual([['GET', RC_URL], ['PUT', `${RC_URL}?validate_only=true`]]);
    expect(result.out).toEqual([
      `Remote Config ${RC_PROJECT_ID}, template version 41`,
      `~ ${RENDERER}: absent -> "legacy"`,
      `~ ${DOSSIER}: "separate" -> "single"`,
    ]);
    expect(result.err).toEqual([
      'rc-switches: PUT remoteConfig?validate_only=true → HTTP 400 (INVALID_ARGUMENT: [VALIDATION_ERROR]: invented refusal)\n'
      + 'Dry run: nothing was written.',
    ]);
    expect(rc.current()).toEqual(before);
  });

  it('--apply sends one PUT under the ETag it read, with only the intended change', async () => {
    const before = template({ [DOSSIER]: existing });
    const rc = fakeRemoteConfig(before);
    const result = await cli([...request, '--apply'], rc);
    expect(result.code, result.printed).toBe(0);
    expect(rc.calls.map((call) => [call.method, call.url, call.ifMatch])).toEqual([['GET', RC_URL, null], ['PUT', RC_URL, 'etag-41'], ['GET', RC_URL, null]]);

    const put = rc.calls[1].body;
    const expected = structuredClone(before);
    // Only the default value of the existing switch; its conditional value, description and type stay.
    expected.parameters[DOSSIER].defaultValue = { value: 'single' };
    // A new parameter: STRING, with the description of the table.
    expected.parameters[RENDERER] = { defaultValue: { value: 'legacy' }, valueType: 'STRING', description: RC_SWITCHES[RENDERER].description };
    expect(put).toEqual({ ...expected, version: { description: `rc-switches.mjs: ${RENDERER}=legacy ${DOSSIER}=single` } });
    // Byte for byte, order included, for what was not asked to change.
    expect(JSON.stringify(put.conditions)).toBe(JSON.stringify(before.conditions));
    expect(JSON.stringify(put.parameterGroups)).toBe(JSON.stringify(before.parameterGroups));
    for (const key of ['RESEND_API_KEY', 'ENABLE_JOB_ALERTS']) expect(JSON.stringify(put.parameters[key])).toBe(JSON.stringify(before.parameters[key]));
    expect(Object.keys(put.parameters)).toEqual([...Object.keys(before.parameters), RENDERER]);

    // What was printed, around the requests: the plan before the PUT, the publish before its read-back.
    expect(rc.trace).toEqual([
      'GET',
      `Remote Config ${RC_PROJECT_ID}, template version 41`,
      `~ ${RENDERER}: absent -> "legacy"`,
      `~ ${DOSSIER}: "separate" -> "single"`,
      'PUT',
      'Published. Read back:',
      'GET',
      `Remote Config ${RC_PROJECT_ID}, template version 42`,
      `${RENDERER}: "legacy" -> legacy`,
      `${DOSSIER}: "single" -> single`,
      `${INPLACE}: absent -> off (default, parameter absent)`,
    ]);
    expect(result.err).toEqual([]);
  });

  it('adds no description or type to a switch that exists without them', async () => {
    const bare = { defaultValue: { value: 'separate' }, conditionalValues: { ios: { value: 'single' } } };
    const rc = fakeRemoteConfig(template({ [DOSSIER]: bare }));
    const result = await cli(['set', `${DOSSIER}=single`, '--apply'], rc);
    expect(result.code, result.printed).toBe(0);
    expect(rc.calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(rc.calls[1].body.parameters[DOSSIER]).toEqual({ defaultValue: { value: 'single' }, conditionalValues: { ios: { value: 'single' } } });
  });

  it('publishes nothing when the switches already hold the values', async () => {
    const rc = fakeRemoteConfig(template({ [DOSSIER]: existing }));
    const result = await cli(['set', `${DOSSIER}=separate`, '--apply'], rc);
    expect(result.code, result.printed).toBe(0);
    expect(result.out.slice(1)).toEqual([`= ${DOSSIER}: "separate" -> "separate"`, 'Nothing to publish: the switches already hold these values.']);
    expect(rc.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it.each([
    ['an unknown key', ['set', 'ASSISTED_APPLICATION_RUN_KEY=legacy'], /"ASSISTED_APPLICATION_RUN_KEY" is not a switch/],
    ['an invalid value', ['set', `${DOSSIER}=dossier`], /ASSISTED_APPLICATION_DOSSIER_MODE accepts separate \| single, got "dossier"/],
    ['another spelling of a value', ['set', `${RENDERER}=Legacy`], /accepts typst \| legacy, got "Legacy"/],
    ['an empty value', ['set', `${INPLACE}=`], /accepts off \| on, got ""/],
    ['a key given twice', ['set', `${INPLACE}=on`, `${INPLACE}=off`], /is given twice/],
    ['an argument that is not KEY=VALUE', ['set', `${INPLACE}=on`, '--force'], /"--force" is not KEY=VALUE/],
    ['no assignment', ['set'], /set needs at least one KEY=VALUE/],
    ['one bad pair among good ones', ['set', `${RENDERER}=legacy`, `${DOSSIER}=both`], /accepts separate \| single, got "both"/],
    ['an unknown command', ['publish', `${RENDERER}=legacy`], /unknown command "publish"/],
    ['an argument to status', ['status', RENDERER], /status takes no argument/],
  ])('refuses %s before any request, also with --apply', async (_case, argv, message) => {
    for (const args of [argv, [...argv, '--apply']]) {
      const result = await cli(args);
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toMatch(message);
      expect(result.out).toEqual([]);
      expect(result.calls).toEqual([]);
    }
  });

  // 412 is the ETag mismatch; the library treats 409 as the same conflict.
  it.each([412, 409])('an ETag mismatch (HTTP %i) is a failure: one PUT, no retry, nothing published', async (putStatus) => {
    const before = template({ [DOSSIER]: existing });
    const rc = fakeRemoteConfig(before, { putStatus });
    const result = await cli([...request, '--apply'], rc);
    expect(result.code).toBe(1);
    expect(rc.calls.map((call) => `${call.method}:${call.ifMatch ?? ''}`)).toEqual(['GET:', 'PUT:etag-41']);
    expect(result.err).toEqual([
      `rc-switches: PUT remoteConfig → HTTP ${putStatus} (FAILED_PRECONDITION: the template changed)\n`
      + 'The publish was not retried: run status to see the live values, then set again.',
    ]);
    // The plan was shown, the publish was not announced.
    expect(result.out).toEqual([
      `Remote Config ${RC_PROJECT_ID}, template version 41`,
      `~ ${RENDERER}: absent -> "legacy"`,
      `~ ${DOSSIER}: "separate" -> "single"`,
    ]);
    expect(rc.current()).toEqual(before);
  });

  it('refuses a switch that sits in a parameter group, where no reader sees it', async () => {
    const grouped = template();
    grouped.parameterGroups.experiments.parameters[RENDERER] = { defaultValue: { value: 'typst' } };
    const rc = fakeRemoteConfig(grouped);
    const result = await cli([...request, '--apply'], rc);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/ASSISTED_APPLICATION_PDF_RENDERER sits in parameter group "experiments"/);
    expect(rc.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('fails when the read-back does not show what was published', async () => {
    const rc = fakeRemoteConfig(template(), { undone: true });
    const result = await cli(['set', `${INPLACE}=on`, '--apply'], rc);
    expect(result.code).toBe(1);
    expect(rc.calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(result.err.join('\n')).toMatch(/read-back does not show the value just published for ASSISTED_APPLICATION_DOCX_INPLACE/);
  });

  it('says the publish went through when only the read-back fails', async () => {
    const rc = fakeRemoteConfig(template(), { readBackStatus: 403 });
    const result = await cli(['set', `${INPLACE}=on`, '--apply'], rc);
    expect(result.code).toBe(1);
    expect(rc.calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(result.out.at(-1)).toBe('Published. Read back:');
    expect(result.err).toEqual(['rc-switches: GET remoteConfig → HTTP 403']);
    expect(rc.current().parameters[INPLACE].defaultValue).toEqual({ value: 'on' });
  });
});

describe('credentials', () => {
  it('reads the service-account file of GOOGLE_APPLICATION_CREDENTIALS and never prints it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-switches-'));
    try {
      const file = path.join(dir, 'service-account.json');
      fs.writeFileSync(file, JSON.stringify(SA));
      const result = await cli(['status'], fakeRemoteConfig(template()), { GOOGLE_APPLICATION_CREDENTIALS: file });
      expect(result.code, result.printed).toBe(0);
      expect(result.calls.map((call) => call.method)).toEqual(['GET']);
      expect(result.printed).not.toContain(SA.private_key);
      expect(result.printed).not.toContain(SA.client_email);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['none', {}, /no service account/],
    ['a file that does not exist', { GOOGLE_APPLICATION_CREDENTIALS: path.join(os.tmpdir(), 'rc-switches-missing', 'service-account.json') }, /no service account/],
    ['text that is not a service account', { FIREBASE_SERVICE_ACCOUNT_JSON: `{"private_key": "${SA.private_key}"` }, /no service account/],
    ['a service account of another project', { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...SA, project_id: 'another-project' }) }, /belongs to project "another-project"/],
  ])('%s: refused before any request', async (_case, env, message) => {
    const result = await cli(['set', `${RENDERER}=legacy`, '--apply'], fakeRemoteConfig(template()), env as Record<string, string>);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(message);
    expect(result.printed).not.toContain(SA.private_key);
    expect(result.calls).toEqual([]);
  });
});

describe('the command line', () => {
  // No credentials in the environment: whatever needs the network fails before reaching it.
  const executeAt = (script: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
  });
  const execute = (...args: string[]) => executeAt(SCRIPT, ...args);

  it.each([
    ['--help', ['--help']],
    ['-h', ['-h']],
    ['no argument', []],
  ])('prints a short usage with %s', (_case, args) => {
    const result = execute(...args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('rc-switches.mjs set KEY=VALUE [KEY=VALUE ...] [--apply]');
    for (const [key, { values }] of Object.entries(RC_SWITCHES)) expect(result.stdout).toContain(`${key}  ${values.join(' | ')}`);
    expect(result.stdout.trim().split('\n').length).toBeLessThan(15);
  });

  it('exits non-zero on a refused value and on missing credentials', () => {
    const refused = execute('set', `${RENDERER}=pdf`, '--apply');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/accepts typst \| legacy, got "pdf"/);
    const noCredentials = execute('status');
    expect(noCredentials.status).toBe(1);
    expect(noCredentials.stderr).toMatch(/no service account/);
  });

  // Through a symlink argv[1] is the link while import.meta.url is the real file: the tool must still run, not exit 0 silently.
  it('runs the same when reached through a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-switches-'));
    try {
      const link = path.join(dir, 'rc-switches.mjs');
      fs.symlinkSync(path.join(ROOT, SCRIPT), link);
      const help = executeAt(link, '--help');
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain('rc-switches.mjs set KEY=VALUE [KEY=VALUE ...] [--apply]');
      const refused = executeAt(link, 'set', `${RENDERER}=pdf`, '--apply');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(/accepts typst \| legacy, got "pdf"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The whole path as it runs for real, with nothing injected: the credentials
  // file, the signed token exchange and the default `fetch`, replaced by a
  // preload that plays Google's OAuth authority and Remote Config (never the network).
  it('publishes through the service-account token exchange and prints no credential', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-switches-'));
    try {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const credentials = path.join(dir, 'service-account.json');
      fs.writeFileSync(credentials, JSON.stringify({ ...SA, type: 'service_account', private_key: privateKey }));
      const log = path.join(dir, 'google-calls.jsonl');
      const preload = path.join(dir, 'fake-google.mjs');
      fs.writeFileSync(preload, `
import fs from 'node:fs';
let version = 41;
let template = ${JSON.stringify(template())};
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  const headers = init.headers ?? {};
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), method, ifMatch: headers['If-Match'] ?? null, auth: headers.Authorization ?? null }) + '\\n');
  if (String(url) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'ya29.invented-access-token' }), { status: 200 });
  if (String(url) !== ${JSON.stringify(RC_URL)}) return new Response('{}', { status: 404 });
  if (method === 'GET') return new Response(JSON.stringify({ ...template, version: { versionNumber: String(version) } }), { status: 200, headers: { etag: 'etag-' + version } });
  template = JSON.parse(init.body);
  version += 1;
  return new Response('{}', { status: 200, headers: { etag: 'etag-' + version } });
};
`);
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, SCRIPT, 'set', `${INPLACE}=on`, '--apply'], {
        cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, GOOGLE_APPLICATION_CREDENTIALS: credentials },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      // One token exchange for the publish, one for the read-back.
      expect(calls.map((call) => `${call.method}:${call.ifMatch ?? ''}`)).toEqual(['POST:', 'GET:', 'PUT:etag-41', 'POST:', 'GET:']);
      expect(calls.filter((call) => call.method !== 'POST').every((call) => call.url === RC_URL && call.auth === 'Bearer ya29.invented-access-token')).toBe(true);
      expect(result.stdout.trim().split('\n')).toEqual([
        `Remote Config ${RC_PROJECT_ID}, template version 41`,
        `~ ${INPLACE}: absent -> "on"`,
        'Published. Read back:',
        `Remote Config ${RC_PROJECT_ID}, template version 42`,
        `${RENDERER}: absent -> typst (default, parameter absent)`,
        `${DOSSIER}: absent -> separate (default, parameter absent)`,
        `${INPLACE}: "on" -> on`,
      ]);
      const printed = result.stdout + result.stderr;
      expect(printed).not.toContain('ya29.invented-access-token');
      expect(printed).not.toContain(privateKey.split('\n')[1]);
      expect(printed).not.toContain(SA.client_email);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
