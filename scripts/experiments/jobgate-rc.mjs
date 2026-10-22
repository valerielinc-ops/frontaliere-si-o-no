#!/usr/bin/env node
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
/**
 * jobgate-rc.mjs — prepare (and, with --apply, publish) the Remote Config
 * values of the jobgate-v5 Spotlight experiment.
 *
 * Stages the three v5 experiment keys, a server-only start-date marker and
 * JOBGATE_EXPERIMENT_FORCE=spotlight for cached v4 clients. It reads the live
 * template, validates the exact diff, and publishes with the template etag
 * only when `--apply` is passed.
 *
 * Default = dry-run. The weights are validated with the same parser the
 * browser uses (services/jobGateExperimentCore.mjs), so a value this script
 * accepts is a value the site splits on; an invalid one would silently put
 * every visitor in Spotlight, so it is refused here.
 *
 * Usage (credentials: Application Default Credentials, e.g.
 * GOOGLE_APPLICATION_CREDENTIALS=~/.config/frontaliere/sa-frontaliere-ticino.json):
 *
 *   node scripts/experiments/jobgate-rc.mjs                      # dry-run launch config
 *   node scripts/experiments/jobgate-rc.mjs --apply              # publish after owner review
 *   node scripts/experiments/jobgate-rc.mjs --kill --apply       # v5 kill switch; Spotlight stays default
 *   node scripts/experiments/jobgate-rc.mjs --force-arm spotlight_quiet --apply
 *   node scripts/experiments/jobgate-rc.mjs --arms '{"spotlight":25,"spotlight_quiet":25,"spotlight_tinted":25,"spotlight_outline":25}'
 *
 * Remote Config changes reach the browser only through getPublicConfig
 * (functions/src/publicConfigKeys.js): the three v5 keys must be deployed in
 * that allowlist before a publish here has any effect. STARTED_AT is server-only.
 */

import {
  JOBGATE_ARMS,
  JOBGATE_EXPERIMENT_ID,
  JOBGATE_LEGACY_FORCE_KEY,
  JOBGATE_RC_KEYS,
  JOBGATE_STARTED_AT_KEY,
  normalizeJobGateArm,
  validateJobGateWeights,
} from '../../services/jobGateExperimentCore.mjs';

/** Launch configuration: promoted Spotlight plus three visual challengers. */
export const JOBGATE_LAUNCH_ARMS = '{"spotlight":25,"spotlight_quiet":25,"spotlight_tinted":25,"spotlight_outline":25}';

export function todayInZurich(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const DESCRIPTIONS = {
  [JOBGATE_RC_KEYS.enabled]: `${JOBGATE_EXPERIMENT_ID} kill switch: "true" enrols visitors, anything else = promoted Spotlight default.`,
  [JOBGATE_RC_KEYS.arms]: `${JOBGATE_EXPERIMENT_ID} integer weights per arm (${JOBGATE_ARMS.join(', ')}). Invalid JSON = Spotlight default.`,
  [JOBGATE_RC_KEYS.force]: `${JOBGATE_EXPERIMENT_ID} QA/promotion: a valid arm name forces it for every visitor while ENABLED=true; empty = weighted split.`,
  [JOBGATE_STARTED_AT_KEY]: 'Server-only Europe/Zurich launch date of jobgate-v5; analysis starts the next day.',
  [JOBGATE_LEGACY_FORCE_KEY]: 'Legacy jobgate-v4 clients are pinned to the promoted Spotlight default.',
};

export function parseArgs(argv) {
  const opts = { apply: false, enabled: 'true', arms: JOBGATE_LAUNCH_ARMS, force: '', startedAt: null };
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
    else if (arg === '--started-at') opts.startedAt = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/**
 * Validate the requested values; returns the canonical strings to stage.
 * Throws with every problem found so nothing half-valid is ever published.
 */
export function buildJobGateValues(opts, { existingStartedAt = '', now = new Date() } = {}) {
  const problems = [];
  const enabled = String(opts.enabled).trim().toLowerCase();
  if (enabled !== 'true' && enabled !== 'false') problems.push(`--enabled must be true|false, got "${opts.enabled}"`);
  const weights = validateJobGateWeights(opts.arms);
  if (!weights.valid) problems.push(`--arms invalid: ${weights.problems.join('; ')}`);
  const force = String(opts.force ?? '').trim().toLowerCase();
  if (force && !normalizeJobGateArm(force)) problems.push(`--force-arm "${opts.force}" is not a known arm`);
  const requestedStartedAt = opts.startedAt == null ? '' : String(opts.startedAt).trim();
  if (requestedStartedAt && !isDateOnly(requestedStartedAt)) problems.push(`--started-at must be a real YYYY-MM-DD date, got "${requestedStartedAt}"`);
  const preservedStartedAt = String(existingStartedAt ?? '').trim();
  if (preservedStartedAt && !isDateOnly(preservedStartedAt)) problems.push(`existing ${JOBGATE_STARTED_AT_KEY} is not a real YYYY-MM-DD date`);
  const startedAt = requestedStartedAt || preservedStartedAt || (enabled === 'true' ? todayInZurich(now) : '');
  if (problems.length) throw new Error(problems.join('\n'));
  return {
    [JOBGATE_RC_KEYS.enabled]: enabled,
    [JOBGATE_RC_KEYS.arms]: JSON.stringify(weights.weights),
    [JOBGATE_RC_KEYS.force]: force,
    [JOBGATE_STARTED_AT_KEY]: startedAt,
    [JOBGATE_LEGACY_FORCE_KEY]: 'spotlight',
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
  const { getRemoteConfig, fetchRcTemplate } = await import('../lib/remote-config-admin.mjs');
  const rc = await getRemoteConfig();
  const template = await fetchRcTemplate(rc);
  const existingStartedAt = currentValue(template, JOBGATE_STARTED_AT_KEY);
  const values = buildJobGateValues(opts, {
    existingStartedAt: existingStartedAt === '(in-app default)' ? '' : existingStartedAt || '',
  });
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
    console.log('Nothing to publish: all staged keys already hold these values.');
    return;
  }
  // No { force: true }: the etag from getTemplate guards against overwriting
  // a change somebody else published after we read the template.
  const published = await rc.publishTemplate(validated);
  console.log(`Published Remote Config version ${published.version?.versionNumber ?? '?'}.`);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`jobgate-rc: ${error?.message || error}`);
    process.exit(1);
  });
}
