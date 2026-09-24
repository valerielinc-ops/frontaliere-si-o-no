#!/usr/bin/env node
/**
 * jobgate-v3-rc.mjs — prepare (and, with --apply, publish) the Remote Config
 * values of the jobgate-v3 auth-gate experiment.
 *
 * Touches ONLY the three keys JOBGATE_EXPERIMENT_ENABLED / _ARMS / _FORCE:
 * reads the live template with firebase-admin, stages the requested values,
 * runs `validateTemplate`, prints the diff of those keys, and publishes with
 * the template's etag (no `force`: a concurrent edit makes the publish fail
 * instead of being overwritten) only when `--apply` is passed.
 *
 * Default = dry-run. The weights are validated with the same parser the
 * browser uses (services/jobGateExperimentCore.mjs), so a value this script
 * accepts is a value the site splits on; an invalid one would silently put
 * every visitor in control, so it is refused here.
 *
 * Usage (credentials: Application Default Credentials, e.g.
 * GOOGLE_APPLICATION_CREDENTIALS=~/.config/frontaliere/sa-frontaliere-ticino.json):
 *
 *   node scripts/experiments/jobgate-v3-rc.mjs                      # dry-run of the launch config
 *   node scripts/experiments/jobgate-v3-rc.mjs --apply              # publish the launch config
 *   node scripts/experiments/jobgate-v3-rc.mjs --kill --apply       # ENABLED=false (kill switch)
 *   node scripts/experiments/jobgate-v3-rc.mjs --force-arm similar_alerts --apply   # promote/QA
 *   node scripts/experiments/jobgate-v3-rc.mjs --arms '{"control":50,"social_first":50}'
 *
 * Remote Config changes reach the browser only through getPublicConfig
 * (functions/src/publicConfigKeys.js): the three keys must be deployed in that
 * allowlist before a publish here has any effect.
 */

import { pathToFileURL } from 'node:url';
import {
  JOBGATE_RC_KEYS,
  normalizeJobGateArm,
  validateJobGateWeights,
} from '../../services/jobGateExperimentCore.mjs';

/** Launch configuration proposed in the PR that introduced the experiment. */
export const JOBGATE_LAUNCH_ARMS = '{"control":25,"similar_alerts":25,"social_first":25,"email_first":25}';

const DESCRIPTIONS = {
  [JOBGATE_RC_KEYS.enabled]: 'jobgate-v3 kill switch: "true" enrols visitors, anything else = today\'s gate for everybody.',
  [JOBGATE_RC_KEYS.arms]: 'jobgate-v3 integer weights per arm (control, similar_alerts, social_first, email_first). Invalid JSON = all control.',
  [JOBGATE_RC_KEYS.force]: 'jobgate-v3 QA/promotion: a valid arm name forces it for every visitor while ENABLED=true; empty = weighted split.',
};

export function parseArgs(argv) {
  const opts = { apply: false, enabled: 'true', arms: JOBGATE_LAUNCH_ARMS, force: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--kill') opts.enabled = 'false';
    else if (arg === '--enabled') opts.enabled = next();
    else if (arg === '--arms') opts.arms = next();
    else if (arg === '--force-arm') opts.force = next();
    else if (arg === '--no-force') opts.force = '';
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/**
 * Validate the requested values; returns the canonical strings to stage.
 * Throws with every problem found so nothing half-valid is ever published.
 */
export function buildJobGateValues(opts) {
  const problems = [];
  const enabled = String(opts.enabled).trim().toLowerCase();
  if (enabled !== 'true' && enabled !== 'false') problems.push(`--enabled must be true|false, got "${opts.enabled}"`);
  const weights = validateJobGateWeights(opts.arms);
  if (!weights.valid) problems.push(`--arms invalid: ${weights.problems.join('; ')}`);
  const force = String(opts.force ?? '').trim().toLowerCase();
  if (force && !normalizeJobGateArm(force)) problems.push(`--force-arm "${opts.force}" is not a known arm`);
  if (problems.length) throw new Error(problems.join('\n'));
  return {
    [JOBGATE_RC_KEYS.enabled]: enabled,
    [JOBGATE_RC_KEYS.arms]: JSON.stringify(weights.weights),
    [JOBGATE_RC_KEYS.force]: force,
  };
}

function currentValue(template, key) {
  const param = template.parameters?.[key];
  if (!param) return null;
  const dv = param.defaultValue;
  return dv && typeof dv === 'object' && 'value' in dv ? String(dv.value) : '(in-app default)';
}

/**
 * Stage the values on the template (only these keys; any conditional values
 * on them are kept) and return the per-key diff.
 */
export function stageJobGateValues(template, values) {
  template.parameters = template.parameters || {};
  const diff = [];
  for (const [key, value] of Object.entries(values)) {
    const before = currentValue(template, key);
    if (before === value) {
      diff.push({ key, before, after: value, changed: false });
      continue;
    }
    template.parameters[key] = {
      ...(template.parameters[key] || {}),
      defaultValue: { value },
      valueType: 'STRING',
      description: DESCRIPTIONS[key],
    };
    diff.push({ key, before, after: value, changed: true });
  }
  return diff;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const values = buildJobGateValues(opts);

  const { getRemoteConfig, fetchRcTemplate } = await import('../lib/remote-config-admin.mjs');
  const rc = await getRemoteConfig();
  const template = await fetchRcTemplate(rc);
  const diff = stageJobGateValues(template, values);

  console.log(`Remote Config template version ${template.version?.versionNumber ?? '?'} (etag ${template.etag ? 'present' : 'missing'})`);
  for (const { key, before, after, changed } of diff) {
    console.log(`${changed ? '~' : '='} ${key}: ${before === null ? '(absent)' : JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  const changed = diff.filter((d) => d.changed).length;

  const validated = await rc.validateTemplate(template);
  console.log(`validateTemplate: OK (${changed} key(s) to change)`);

  if (!opts.apply) {
    console.log('Dry-run: nothing published. Re-run with --apply to publish.');
    return;
  }
  if (changed === 0) {
    console.log('Nothing to publish: the three keys already hold these values.');
    return;
  }
  // No { force: true }: the etag from getTemplate guards against overwriting
  // a change somebody else published after we read the template.
  const published = await rc.publishTemplate(validated);
  console.log(`Published Remote Config version ${published.version?.versionNumber ?? '?'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`jobgate-v3-rc: ${error?.message || error}`);
    process.exit(1);
  });
}
