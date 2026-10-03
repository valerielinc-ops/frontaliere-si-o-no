#!/usr/bin/env node
/**
 * rc-switches.mjs — read and set the three Remote Config switches of the
 * assisted application: the PDF renderer, one dossier or separate files, the
 * candidate's own DOCX as a third CV choice.
 *
 * Touches ONLY those three parameters. Of a switch that exists it replaces the
 * top-level default value and nothing else: what the parameter has (conditional
 * values, description, type) stays, and nothing it lacks is added. The rest of
 * the template (other parameters, conditions, groups) goes back as it was read.
 * All the keys leave in one publish, under the ETag of the template the plan
 * was computed from (`If-Match`) and in one attempt: a template somebody else
 * changed in between makes the publish fail, it is neither overwritten nor
 * re-applied unseen.
 *
 * Default = dry run: the plan, which Remote Config checks without writing it
 * (`?validate_only=true`, the validateTemplate of jobgate-v3-rc.mjs), so a
 * change it would refuse fails here and not at --apply. The values are not
 * secrets: they are printed here, and the loader never masks them
 * (PLAIN_WORD_RC_KEYS in scripts/load-rc-env.mjs).
 *
 * Usage (credentials as the other Remote Config scripts read them: the
 * service-account JSON file of GOOGLE_APPLICATION_CREDENTIALS, or the JSON
 * itself in FIREBASE_SERVICE_ACCOUNT_JSON):
 *
 *   node scripts/assisted-application/rc-switches.mjs status
 *   node scripts/assisted-application/rc-switches.mjs set ASSISTED_APPLICATION_PDF_RENDERER=legacy           # dry run
 *   node scripts/assisted-application/rc-switches.mjs set ASSISTED_APPLICATION_DOSSIER_MODE=single --apply
 *
 * A new value reaches the runner at the start of its next job (the loader
 * exports it as an environment variable) and the Cloud Functions, which read
 * the renderer switch from Remote Config, within their five-minute cache.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { INPLACE_KEY, docxInPlaceMode } from '../../functions/src/assistedApplicationDocxInPlace.js';
import { RENDERER_KEY, pdfRendererMode } from '../../functions/src/assistedApplicationPdfRenderer.js';
import { stageRcParamValue, updateRcTemplateWithEtag } from '../lib/remote-config-admin.mjs';
import { DOSSIER_KEY, dossierMode } from './lib/dossier.mjs';

export const RC_PROJECT_ID = 'frontaliere-ticino';

/**
 * The switches and the values `set` accepts: to accept a new value, add it to
 * `values` here, once its reader returns it. `description` is the sentence of
 * the key's comment in RC_TO_ENV (scripts/load-rc-env.mjs), written on a
 * parameter this tool creates. `read` is the code's own reading of a value, so
 * `status` reports what the runner will do with it, not what this table expects.
 */
export const RC_SWITCHES = {
  [RENDERER_KEY]: {
    description: '"legacy" switches the assisted application\'s PDFs back to the standard-font writer (default: typst).',
    values: ['typst', 'legacy'],
    read: (value) => pdfRendererMode({ env: { [RENDERER_KEY]: value } }),
  },
  [DOSSIER_KEY]: {
    description: '"single" e-mails one PDF dossier to a qualified candidate\'s employer (default: separate files).',
    values: ['separate', 'single'],
    read: (value) => dossierMode({ [DOSSIER_KEY]: value }),
  },
  [INPLACE_KEY]: {
    description: '"on" writes the adapted lines into the candidate\'s own DOCX as a third CV choice (default: off).',
    values: ['off', 'on'],
    read: (value) => docxInPlaceMode({ env: { [INPLACE_KEY]: value } }),
  },
};

const usage = () => [
  `Remote Config switches of the assisted application (project ${RC_PROJECT_ID}).`,
  '',
  '  node scripts/assisted-application/rc-switches.mjs status',
  '  node scripts/assisted-application/rc-switches.mjs set KEY=VALUE [KEY=VALUE ...] [--apply]',
  '',
  ...Object.entries(RC_SWITCHES).map(([key, { values }]) => `  ${key}  ${values.join(' | ')}`),
  '',
  'set prints the plan, has Remote Config check it (validate_only) and writes nothing unless --apply is given.',
  'Credentials: GOOGLE_APPLICATION_CREDENTIALS (service-account JSON file) or FIREBASE_SERVICE_ACCOUNT_JSON.',
].join('\n');

/**
 * KEY=VALUE pairs checked against RC_SWITCHES. Throws with every problem
 * found, so nothing half-valid is ever staged.
 */
function parseAssignments(args) {
  const values = {};
  const problems = [];
  for (const arg of args) {
    const at = arg.indexOf('=');
    if (at < 0) {
      problems.push(`"${arg}" is not KEY=VALUE`);
      continue;
    }
    const key = arg.slice(0, at);
    const value = arg.slice(at + 1);
    const allowed = Object.hasOwn(RC_SWITCHES, key) ? RC_SWITCHES[key].values : null;
    if (!allowed) problems.push(`"${key}" is not a switch of the assisted application`);
    else if (!allowed.includes(value)) problems.push(`${key} accepts ${allowed.join(' | ')}, got "${value}"`);
    else if (Object.hasOwn(values, key)) problems.push(`${key} is given twice`);
    else values[key] = value;
  }
  if (!args.length) problems.push('set needs at least one KEY=VALUE');
  if (problems.length) throw new Error(problems.join('\n'));
  return values;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || argv.includes('--help') || argv.includes('-h')) return { command: 'help' };
  if (command === 'status') {
    if (rest.length) throw new Error(`status takes no argument, got "${rest.join(' ')}"`);
    return { command };
  }
  if (command === 'set') {
    return { command, apply: rest.includes('--apply'), values: parseAssignments(rest.filter((arg) => arg !== '--apply')) };
  }
  throw new Error(`unknown command "${command}" (status | set)`);
}

/**
 * The service account, as the other Remote Config scripts get it: the JSON in
 * FIREBASE_SERVICE_ACCOUNT_JSON, or the file GOOGLE_APPLICATION_CREDENTIALS
 * points to. Another project is refused: the three switches exist in one.
 */
function readCredentials(env) {
  let credentials = null;
  try {
    credentials = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  } catch {
    // A parse error quotes what it could not read: only say what is missing.
    credentials = null;
  }
  if (!credentials?.client_email || !credentials?.private_key || !credentials?.project_id) {
    throw new Error('no service account: set GOOGLE_APPLICATION_CREDENTIALS to its JSON file, or FIREBASE_SERVICE_ACCOUNT_JSON to the JSON');
  }
  if (credentials.project_id !== RC_PROJECT_ID) {
    throw new Error(`the service account belongs to project "${credentials.project_id}", this tool only works on ${RC_PROJECT_ID}`);
  }
  return credentials;
}

/**
 * The switch in the template. `value` is the top-level default value: the only
 * one the loader and the Cloud Functions read (template.parameters). A switch
 * moved into a parameter group, which the console allows, is invisible to
 * them: `group` then names the group and `groupValue` is what it holds there.
 */
function currentValue(template, key) {
  const defaultOf = (parameter) => (typeof parameter?.defaultValue?.value === 'string' ? parameter.defaultValue.value : null);
  const parameter = template?.parameters?.[key];
  if (parameter) return { exists: true, value: defaultOf(parameter) };
  for (const [group, def] of Object.entries(template?.parameterGroups ?? {})) {
    if (def?.parameters && Object.hasOwn(def.parameters, key)) return { exists: false, value: null, group, groupValue: defaultOf(def.parameters[key]) };
  }
  return { exists: false, value: null };
}

const literal = (value) => (value === null ? 'no literal default' : JSON.stringify(value));
const shown = ({ exists, value, group, groupValue }) => (
  group !== undefined ? `${literal(groupValue)} in parameter group ${JSON.stringify(group.slice(0, 60))}` : !exists ? 'absent' : literal(value)
);
const versionLine = (template) => `Remote Config ${RC_PROJECT_ID}, template version ${template?.version?.versionNumber ?? '?'}`;

/** What a switch holds in the template and what the code does with it. */
async function switchStatus(template, key) {
  const { values, read } = RC_SWITCHES[key];
  const current = currentValue(template, key);
  const behaviour = await read(current.value ?? '');
  let note = '';
  if (current.group !== undefined) note = 'default: the loader and the Functions read top-level parameters only';
  else if (!current.exists) note = 'default, parameter absent';
  else if (!current.value) note = 'default, no value';
  else if (!values.includes(current.value)) note = `the value is not one of: ${values.join(' | ')}`;
  return { key, ...current, behaviour, note };
}

async function statusLines(template) {
  const lines = [];
  for (const key of Object.keys(RC_SWITCHES)) {
    const status = await switchStatus(template, key);
    lines.push(`${key}: ${shown(status)} -> ${status.behaviour}${status.note ? ` (${status.note})` : ''}`);
  }
  return lines;
}

/**
 * The requested values staged on the template, with the plan. stageRcParamValue
 * creates a missing switch (STRING, with the description of the table) and
 * refuses a name that sits in a parameter group, where no reader would see it.
 * Of a switch that exists only the default value changes: stageRcParamValue
 * would also fill in a description or type the parameter lacks.
 */
function stageSwitches(template, values) {
  const plan = [];
  let staged = template;
  for (const [key, value] of Object.entries(values)) {
    const result = stageRcParamValue(staged, key, value, RC_SWITCHES[key].description);
    if (result.error) return { changed: false, error: result.error };
    plan.push({ key, before: currentValue(template, key), after: value, changed: result.changed });
    if (!result.changed) continue;
    const existing = staged.parameters?.[key];
    staged = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...staged, parameters: { ...staged.parameters, [key]: { ...existing, defaultValue: { value } } } }
      : result.template;
  }
  return { changed: plan.some((entry) => entry.changed), template: staged, plan };
}

/** The live template: an update that stages nothing ends after its GET. */
async function readTemplate(remoteConfig) {
  let template = null;
  const result = await updateRcTemplateWithEtag({
    ...remoteConfig,
    stage: (current) => {
      template = current;
      return { changed: false };
    },
  });
  if (!result.ok) throw new Error(result.detail);
  return template;
}

async function setSwitches(remoteConfig, values, apply, out) {
  let staged = null;
  const result = await updateRcTemplateWithEtag({
    ...remoteConfig,
    // The dry run has Remote Config check the staged template without writing it. --apply stays
    // one PUT: the publish is checked the same way and refused whole.
    validateOnly: !apply,
    // One attempt: after a conflict the plan just printed is no longer what a re-apply would publish.
    attempts: 1,
    versionDescription: `rc-switches.mjs: ${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(' ')}`,
    // The plan is printed here, before the PUT, from the template whose ETag guards it.
    stage: (template) => {
      staged = stageSwitches(template, values);
      if (staged.plan) {
        out(versionLine(template));
        for (const { key, before, after, changed } of staged.plan) out(`${changed ? '~' : '='} ${key}: ${shown(before)} -> ${JSON.stringify(after)}`);
      }
      return staged;
    },
  });
  if (!result.ok) {
    // `changed`: the PUT was sent. With --apply, after a network error nobody knows whether it went
    // through; in the dry run it only asked for the check, which writes nothing.
    if (!staged?.changed) throw new Error(result.detail);
    throw new Error(`${result.detail}\n${apply ? 'The publish was not retried: run status to see the live values, then set again.' : 'Dry run: nothing was written.'}`);
  }
  if (!result.changed) {
    out('Nothing to publish: the switches already hold these values.');
    return;
  }
  if (result.validated) {
    out('validate_only: OK, Remote Config accepts this template.');
    out('Dry run: nothing was written. Re-run with --apply to publish.');
    return;
  }
  // Said before the read-back: if only that fails, the publish still went through.
  out('Published. Read back:');
  const published = await readTemplate(remoteConfig);
  out(versionLine(published));
  for (const line of await statusLines(published)) out(line);
  // A forced publish by another writer at the same moment can still undo an ETag-guarded one.
  const undone = Object.keys(values).filter((key) => currentValue(published, key).value !== values[key]);
  if (undone.length) throw new Error(`the read-back does not show the value just published for ${undone.join(', ')}: run status again`);
}

/**
 * @param {string[]} argv
 * @param {{env?: Record<string, string|undefined>, out?: (line: string) => void, err?: (line: string) => void,
 *   fetchImpl?: typeof fetch, getAccessToken?: Function, sleep?: Function}} [options] the last three reach
 *   updateRcTemplateWithEtag (the tests pass fakes)
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, { env = process.env, out = console.log, err = console.error, ...remoteConfig } = {}) {
  let credentials = null;
  try {
    const options = parseArgs(argv);
    if (options.command === 'help') {
      out(usage());
      return 0;
    }
    credentials = readCredentials(env);
    if (options.command === 'status') {
      const template = await readTemplate({ ...remoteConfig, credentials });
      out(versionLine(template));
      for (const line of await statusLines(template)) out(line);
    } else {
      await setSwitches({ ...remoteConfig, credentials }, options.values, options.apply, out);
    }
    return 0;
  } catch (error) {
    err(`rc-switches: ${String(error?.message || error).replaceAll(credentials?.private_key || '\u0000', '[redacted]')}`);
    return 1;
  }
}

// Only run when executed directly (not when imported by tests). realpathSync: through a symlink
// argv[1] is the link and import.meta.url the real file, and doing nothing would exit 0 as if done.
const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
