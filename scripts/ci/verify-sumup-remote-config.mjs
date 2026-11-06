#!/usr/bin/env node
/**
 * Verify the top-level Remote Config contract consumed by the SumUp assisted
 * application checkout.
 *
 * Cloud Functions read `template.parameters` and its default values directly;
 * a parameter placed only in a parameter group is invisible to them. This
 * verifier therefore checks the exact shape the runtime reads and reports only
 * parameter names and validation states. It never prints a Remote Config
 * value, including the SumUp API key or merchant code.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-sa.json \
 *     node scripts/ci/verify-sumup-remote-config.mjs
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchRcTemplate, getRemoteConfig } from '../lib/remote-config-admin.mjs';
import {
  isValidSumUpWebhookUrl,
  SUMUP_PAYMENT_PROVIDER,
  SUMUP_CONFIG_LIMITS,
  SUMUP_REMOTE_CONFIG_KEYS,
} from '../../functions/src/sumupAssistedApplicationCore.js';

const CHECKS = Object.freeze([
  { name: 'provider', key: SUMUP_REMOTE_CONFIG_KEYS.provider },
  { name: 'apiKey', key: SUMUP_REMOTE_CONFIG_KEYS.apiKey },
  { name: 'merchantCode', key: SUMUP_REMOTE_CONFIG_KEYS.merchantCode },
  { name: 'webhookUrl', key: SUMUP_REMOTE_CONFIG_KEYS.webhookUrl },
]);

function groupContainingKey(template, key) {
  for (const [group, definition] of Object.entries(template?.parameterGroups ?? {})) {
    if (definition?.parameters && Object.hasOwn(definition.parameters, key)) return group;
  }
  return null;
}

function topLevelDefault(template, key) {
  const parameter = template?.parameters?.[key];
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
    const group = groupContainingKey(template, key);
    return {
      ok: false,
      reason: group ? 'must be a top-level parameter, not a parameter-group member' : 'missing top-level parameter',
      value: '',
    };
  }

  const value = parameter.defaultValue?.value;
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'missing non-empty top-level default value', value: '' };
  }
  return { ok: true, reason: 'top-level default present', value: value.trim() };
}

function checkValue(template, { name, key }) {
  const current = topLevelDefault(template, key);
  if (!current.ok) return { name, key, ok: false, reason: current.reason };

  if (name === 'provider') {
    return {
      name,
      key,
      ok: current.value.toLowerCase() === SUMUP_PAYMENT_PROVIDER,
      reason: current.value.toLowerCase() === SUMUP_PAYMENT_PROVIDER
        ? 'SumUp provider active'
        : 'must select the SumUp provider',
    };
  }

  const valid = name === 'apiKey'
    ? current.value.length <= SUMUP_CONFIG_LIMITS.apiKey
    : name === 'merchantCode'
      ? current.value.length <= SUMUP_CONFIG_LIMITS.merchantCode
      : isValidSumUpWebhookUrl(current.value)
        && current.value.length <= SUMUP_CONFIG_LIMITS.webhookUrl;
  return {
    name,
    key,
    ok: valid,
    reason: valid ? current.reason : 'invalid value shape for the SumUp runtime contract',
  };
}

/**
 * Validate a fetched Firebase Remote Config template without returning any
 * secret value to callers or logs.
 */
export function verifySumUpRemoteConfigTemplate(template) {
  const checks = CHECKS.map((check) => checkValue(template, check));

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export async function verifySumUpRemoteConfig({
  readTemplate = async () => fetchRcTemplate(await getRemoteConfig()),
  log = console.log,
} = {}) {
  const template = await readTemplate();
  const result = verifySumUpRemoteConfigTemplate(template);
  for (const check of result.checks) {
    log(`${check.ok ? 'OK' : 'FAIL'} ${check.key}: ${check.reason}`);
  }
  if (result.ok) {
    log(`SumUp Remote Config verified (template ${template?.version?.versionNumber ?? '?'})`);
  }
  return result;
}

function directInvocation() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (directInvocation()) {
  verifySumUpRemoteConfig()
    .then((result) => {
      if (!result.ok) {
        console.error('SumUp Remote Config verification failed. No secret value was printed.');
        process.exitCode = 1;
      }
    })
    .catch(() => {
      console.error('SumUp Remote Config verification could not read the template. No secret value was printed.');
      process.exitCode = 1;
    });
}
