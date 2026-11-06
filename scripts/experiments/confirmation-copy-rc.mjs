#!/usr/bin/env node
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
/**
 * confirmation-copy-rc.mjs — prepare (and, with --apply, publish) the Remote
 * Config rollout of the confirmation-copy experiment (#6317).
 *
 * Touches ONLY the key NEWSLETTER_CONFIRMATION_COPY_ROLLOUT: reads the live
 * template with firebase-admin, stages the requested value, runs
 * `validateTemplate`, prints the diff of that key, and publishes with the
 * template's etag (no `force`: a concurrent edit makes the publish fail
 * instead of being overwritten) only when `--apply` is passed.
 *
 * Default = dry-run. The value is checked against the parser the Cloud
 * Function uses (functions/src/lib/confirmationCopyExperiment.js): that parser
 * clamps out-of-range numbers and reads anything unparsable as "off", so a
 * typo would silently change the split. Here it is refused instead.
 *
 * The template also carries the project's secrets: this script never prints
 * the value of any other parameter. After a publish it compares the previous
 * and the new version and reports the NAMES of the keys that differ.
 *
 * Usage (credentials: Application Default Credentials, e.g.
 * GOOGLE_APPLICATION_CREDENTIALS=~/.config/frontaliere/sa-frontaliere-ticino.json):
 *
 *   node scripts/experiments/confirmation-copy-rc.mjs --rollout 0.5          # dry-run
 *   node scripts/experiments/confirmation-copy-rc.mjs --rollout 0.5 --apply  # half of the eligible requests get the generic copy
 *   node scripts/experiments/confirmation-copy-rc.mjs --kill --apply         # rollout 0: everybody back on the contextual copy
 *
 * The functions cache the template for 5 minutes
 * (functions/src/remoteConfigSecrets.js): a publish is effective within that
 * window. An arm already frozen in a subscriber's snapshot keeps being used
 * for that subscriber's reminders, whatever the rollout becomes.
 */

import {
  CONFIRMATION_COPY_ROLLOUT_RC_KEY,
  readConfirmationCopyConfig,
} from '../../functions/src/lib/confirmationCopyExperiment.js';

const DESCRIPTION = 'Confirmation-copy experiment (#6317): share 0..1 of the eligible first confirmation requests (job gate) that gets the generic copy. 0 or absent = off, everybody gets the contextual copy.';

export function parseArgs(argv) {
  const opts = { apply: false, rollout: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--kill') opts.rollout = '0';
    else if (arg === '--rollout') opts.rollout = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/**
 * Validate the requested rollout; returns the canonical string to stage.
 * Throws instead of clamping: a value this script accepts is a value the
 * function splits on exactly as written.
 */
export function buildRolloutValue(opts) {
  const raw = opts?.rollout;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw new Error('pass --rollout <0..1> or --kill');
  }
  const text = String(raw).trim();
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--rollout must be a number between 0 and 1, got "${raw}"`);
  }
  const value = String(parsed);
  const read = readConfirmationCopyConfig({ [CONFIRMATION_COPY_ROLLOUT_RC_KEY]: value }).rollout;
  if (read !== parsed) {
    throw new Error(`--rollout "${raw}" would be read as ${read} by the function`);
  }
  return value;
}

function currentValue(template) {
  const param = template.parameters?.[CONFIRMATION_COPY_ROLLOUT_RC_KEY];
  if (!param) return null;
  const dv = param.defaultValue;
  return dv && typeof dv === 'object' && 'value' in dv ? String(dv.value) : '(in-app default)';
}

/**
 * Stage the value on the template (only this key) and return its diff.
 * Refuses the two shapes the function would not read as written: a copy of
 * the key inside a parameter group (remoteConfigSecrets.js reads top-level
 * parameters only) and conditional values (it reads the default value only).
 */
export function stageRolloutValue(template, value) {
  const key = CONFIRMATION_COPY_ROLLOUT_RC_KEY;
  for (const [group, def] of Object.entries(template.parameterGroups ?? {})) {
    if (def?.parameters && key in def.parameters) {
      throw new Error(`${key} sits in parameter group ${JSON.stringify(group)}; it must be a top-level parameter`);
    }
  }
  template.parameters = template.parameters || {};
  const existing = template.parameters[key];
  if (existing?.conditionalValues && Object.keys(existing.conditionalValues).length) {
    throw new Error(`${key} has conditional values; the function reads the default value only`);
  }
  const before = currentValue(template);
  if (before === value) return { key, before, after: value, changed: false };
  template.parameters[key] = {
    ...(existing || {}),
    defaultValue: { value },
    valueType: existing?.valueType ?? 'STRING',
    description: existing?.description ?? DESCRIPTION,
  };
  return { key, before, after: value, changed: true };
}

/**
 * Names of what differs between two template versions — never a value.
 * `onlyExpected` is true when the rollout key is the single difference.
 */
export function diffTemplateKeyNames(before, after) {
  const a = before?.parameters || {};
  const b = after?.parameters || {};
  const added = Object.keys(b).filter((k) => !(k in a)).sort();
  const removed = Object.keys(a).filter((k) => !(k in b)).sort();
  const changed = Object.keys(b)
    .filter((k) => k in a && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();
  const parameterGroupsChanged = JSON.stringify(before?.parameterGroups || {}) !== JSON.stringify(after?.parameterGroups || {});
  const conditionsChanged = JSON.stringify(before?.conditions || []) !== JSON.stringify(after?.conditions || []);
  const touched = [...added, ...changed];
  const onlyExpected = removed.length === 0
    && !parameterGroupsChanged
    && !conditionsChanged
    && touched.length === 1
    && touched[0] === CONFIRMATION_COPY_ROLLOUT_RC_KEY;
  return { added, removed, changed, parameterGroupsChanged, conditionsChanged, onlyExpected };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const value = buildRolloutValue(opts);

  const { getRemoteConfig, fetchRcTemplate } = await import('../lib/remote-config-admin.mjs');
  const rc = await getRemoteConfig();
  const template = await fetchRcTemplate(rc);
  const versionBefore = template.version?.versionNumber ?? null;
  const { key, before, changed } = stageRolloutValue(template, value);

  console.log(`Remote Config template version ${versionBefore ?? '?'} (etag ${template.etag ? 'present' : 'missing'})`);
  console.log(`${changed ? '~' : '='} ${key}: ${before === null ? '(absent)' : JSON.stringify(before)} -> ${JSON.stringify(value)}`);
  if (!changed) {
    console.log('Nothing to publish: the key already holds this value.');
    return;
  }

  const validated = await rc.validateTemplate(template);
  console.log('validateTemplate: OK (1 key to change)');

  if (!opts.apply) {
    console.log('Dry-run: nothing published. Re-run with --apply to publish.');
    return;
  }
  // No { force: true }: the etag from getTemplate guards against overwriting
  // a change somebody else published after we read the template.
  const published = await rc.publishTemplate(validated);
  const versionAfter = published.version?.versionNumber ?? null;
  console.log(`Published Remote Config version ${versionAfter ?? '?'} at ${new Date().toISOString()} (previous ${versionBefore ?? '?'}).`);

  if (versionBefore && versionAfter) {
    const diff = diffTemplateKeyNames(
      await rc.getTemplateAtVersion(String(versionBefore)),
      await rc.getTemplateAtVersion(String(versionAfter)),
    );
    console.log(`Versions ${versionBefore} -> ${versionAfter}: ${JSON.stringify(diff)}`);
    if (!diff.onlyExpected) {
      console.error('The two versions differ in more than the rollout key: read the names above.');
      process.exitCode = 2;
    }
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`confirmation-copy-rc: ${error?.message || error}`);
    process.exit(1);
  });
}
