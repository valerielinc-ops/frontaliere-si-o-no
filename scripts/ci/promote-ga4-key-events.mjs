#!/usr/bin/env node

/**
 * Trusted-runner promotion for issue #15877.
 *
 * The Codex fallback deliberately has no network and no service-account
 * credentials. Keep the credentialed GA4 read and the follow-up write here,
 * on the Actions runner, and pass only the sanitized result to callers.
 *
 * The underlying GA4 command remains the source of truth for the event list
 * and its `eventCount > 0` guard. This wrapper only proves that the read-only
 * plan contains the two events requested by the issue and that no other
 * missing event is promoted as a side effect.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GA4_PROMOTION_ISSUE_NUMBER = 15877;
export const GA4_PROMOTION_EVENT_NAMES = Object.freeze([
  'newsletter_subscribe',
  'login',
]);

const SCRIPT_PATH = fileURLToPath(new URL('../ga4-key-events.mjs', import.meta.url));
const TARGET_ARGS = ['--only=newsletter_subscribe,login'];

function positiveEventCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0;
}

function planEntries(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.plan)) {
    throw new Error('GA4 promotion plan has an invalid shape');
  }
  const byName = new Map();
  for (const entry of result.plan) {
    if (!entry || typeof entry.eventName !== 'string' || byName.has(entry.eventName)) {
      throw new Error('GA4 promotion plan has duplicate or invalid event names');
    }
    byName.set(entry.eventName, entry);
  }
  return { plan: result.plan, byName };
}

/**
 * Validate the read-only plan before any Admin API write is attempted.
 *
 * @param {unknown} result
 * @returns {true}
 */
export function validateReadPlan(result) {
  const { plan, byName } = planEntries(result);
  const missing = GA4_PROMOTION_EVENT_NAMES.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`GA4 read plan is missing: ${missing.join(', ')}`);

  const unobserved = GA4_PROMOTION_EVENT_NAMES.filter((name) => {
    const entry = byName.get(name);
    return !positiveEventCount(entry.eventCount);
  });
  if (unobserved.length) throw new Error(`GA4 read plan has no settled observations for: ${unobserved.join(', ')}`);

  const invalidTargetActions = GA4_PROMOTION_EVENT_NAMES.filter((name) => {
    const action = byName.get(name).action;
    return action !== 'create' && action !== 'exists';
  });
  if (invalidTargetActions.length) {
    throw new Error(`GA4 target action is not safe to promote: ${invalidTargetActions.join(', ')}`);
  }

  const unexpectedCreates = plan
    .filter((entry) => entry.action === 'create' && !GA4_PROMOTION_EVENT_NAMES.includes(entry.eventName))
    .map((entry) => entry.eventName);
  if (unexpectedCreates.length) {
    throw new Error(`GA4 read plan would create unexpected events: ${unexpectedCreates.join(', ')}`);
  }
  return true;
}

/**
 * Validate the second read performed by `--apply`. A concurrent run may have
 * created a target between the two reads, so `exists` is valid as well as
 * `created`; every other action remains fail-closed.
 *
 * @param {unknown} result
 * @returns {true}
 */
export function validateAppliedPlan(result) {
  const { plan, byName } = planEntries(result);
  const missing = GA4_PROMOTION_EVENT_NAMES.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`GA4 apply plan is missing: ${missing.join(', ')}`);

  const unfinished = GA4_PROMOTION_EVENT_NAMES.filter((name) => {
    const entry = byName.get(name);
    return !positiveEventCount(entry.eventCount) || !['created', 'exists'].includes(entry.action);
  });
  if (unfinished.length) throw new Error(`GA4 apply did not confirm: ${unfinished.join(', ')}`);

  const unexpectedCreates = plan
    .filter((entry) => entry.action === 'created' && !GA4_PROMOTION_EVENT_NAMES.includes(entry.eventName))
    .map((entry) => entry.eventName);
  if (unexpectedCreates.length) {
    throw new Error(`GA4 apply created unexpected events: ${unexpectedCreates.join(', ')}`);
  }
  return true;
}

function sanitizedPlan(result) {
  return result.plan.map((entry) => ({
    eventName: entry.eventName,
    action: entry.action,
    counting: entry.counting,
    eventCount: Number(entry.eventCount || 0),
    currentCounting: entry.currentCounting || null,
  }));
}

/**
 * Remove reasons and resource identifiers before the report is made
 * available to a model or a later workflow step.
 */
export function sanitizePromotionReport({ issueNumber, read, applied }) {
  return {
    schemaVersion: 1,
    source: 'trusted-ga4-key-events-promotion',
    issueNumber: Number(issueNumber),
    status: 'promoted',
    propertyId: read.propertyId,
    lookbackDays: read.lookbackDays,
    targetEventNames: [...GA4_PROMOTION_EVENT_NAMES],
    readOnlyPlan: sanitizedPlan(read),
    appliedPlan: sanitizedPlan(applied),
  };
}

function runGa4Command(args) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [SCRIPT_PATH, ...args, '--json'], {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim().split(/\r?\n/u).at(-1) || 'command failed';
    throw new Error(`GA4 ${args.includes('--apply') ? 'apply' : 'read'} failed: ${stderr.slice(0, 240)}`);
  }
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    throw new Error('GA4 command returned invalid JSON');
  }
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function isDirectInvocation() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

function main() {
  const issueNumber = Number(process.env.GA4_PROMOTION_ISSUE_NUMBER || 0);
  if (issueNumber !== GA4_PROMOTION_ISSUE_NUMBER) {
    throw new Error(`GA4 promotion is restricted to issue #${GA4_PROMOTION_ISSUE_NUMBER}`);
  }
  const output = process.env.GA4_PROMOTION_REPORT;
  if (!output) throw new Error('GA4_PROMOTION_REPORT is required');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GA4 promotion requires FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
  }

  const read = runGa4Command(TARGET_ARGS);
  validateReadPlan(read);
  const applied = runGa4Command([...TARGET_ARGS, '--apply']);
  validateAppliedPlan(applied);

  writeReport(output, sanitizePromotionReport({ issueNumber, read, applied }));
  console.log(`GA4 promotion verified for issue #${issueNumber}: ${GA4_PROMOTION_EVENT_NAMES.join(', ')}`);
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : 'GA4 promotion failed'}`);
    process.exitCode = 1;
  }
}
