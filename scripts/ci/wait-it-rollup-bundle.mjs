#!/usr/bin/env node
/**
 * wait-it-rollup-bundle — block a non-IT `build-locale` leg until the Rollup
 * bundle of this run's IT leg is downloadable, and name that artifact.
 *
 * The name carries the attempt in which IT built the bundle. When only another
 * leg is run again ("Re-run failed jobs", or the targeted one-leg rerun of
 * rearm-deploy-build.mjs), IT is listed under the new attempt as a copy of its
 * earlier success and uploads nothing: its bundle keeps the earlier attempt.
 * Waiting for the current attempt's name then lasts until the deadline and
 * fails a leg whose input already exists. Same tracing as the hreflang barrier
 * (see exchange-hreflang-manifests.mjs).
 *
 * Every wait ends:
 *   - IT failed in this attempt and left no bundle: fail at once;
 *   - IT succeeded but its bundle is not listed (expired or deleted): it can no
 *     longer appear, so fail after a few polls of listing lag;
 *   - otherwise fail at the deadline. API errors only count as "not yet".
 *
 * Usage (env: GH_TOKEN, GH_REPO, IT_BUNDLE_RUN_ID, IT_BUNDLE_RUN_ATTEMPT,
 * GITHUB_OUTPUT):
 *   node scripts/ci/wait-it-rollup-bundle.mjs
 */
import fs from 'node:fs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  describeError,
  isPublished,
  latestLocaleJob,
  manifestAttemptOf,
  readJobs,
  runGh,
} from './exchange-hreflang-manifests.mjs';

export const BUNDLE_WAIT_BUDGET_MS = 180 * 60_000;
export const BUNDLE_POLL_MS = 15_000;
// The job list is read before the artifact list, so a successful IT job has
// already uploaded. These polls only absorb a lagging artifact listing.
export const BUNDLE_MISSING_AFTER_SUCCESS_POLLS = 8;

export class BundleWaitError extends Error {}

export function bundleArtifactName(runId, runAttempt) {
  return `it-rollup-bundle-${runId}-${runAttempt}`;
}

/** @returns {Promise<string>} the name of the downloadable IT bundle artifact. */
export async function waitForItRollupBundle({
  gh,
  repo,
  runId,
  runAttempt,
  budgetMs = BUNDLE_WAIT_BUDGET_MS,
  pollMs = BUNDLE_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  log = console.log,
}) {
  for (const [label, value] of Object.entries({ repo, runId, runAttempt })) {
    if (!value) throw new BundleWaitError(`missing IT Rollup bundle wait input: ${label}`);
  }
  const deadline = now() + budgetMs;
  let missingAfterSuccess = 0;
  for (;;) {
    let state = 'unknown';
    try {
      const jobs = await readJobs({ gh, repo, runId });
      const job = latestLocaleJob('it', jobs);
      // Only the entry of this attempt says what IT does now. An older one can
      // be all the API lists just after a rerun that is about to run IT again,
      // and its bundle would belong to the previous build.
      const current = Number(job?.run_attempt) === Number(runAttempt) ? job : null;
      state = current ? `${current.status}:${current.conclusion || ''}` : 'missing';
      // The earlier attempt only for a copied success, else the current one.
      const attempt = current ? manifestAttemptOf('it', jobs, runAttempt) : String(runAttempt);
      const name = bundleArtifactName(runId, attempt);
      if (await isPublished({ gh, repo, runId, name })) {
        log(`IT Rollup bundle artifact is available: ${name} (IT job=${state})`);
        return name;
      }
      if (current?.status === 'completed') {
        if (current.conclusion !== 'success') {
          throw new BundleWaitError(`build-locale (it) ended as ${state} before publishing ${name}`);
        }
        missingAfterSuccess += 1;
        if (missingAfterSuccess >= BUNDLE_MISSING_AFTER_SUCCESS_POLLS) {
          throw new BundleWaitError(
            `build-locale (it) succeeded but ${name} is not available (expired or deleted): re-run all jobs`,
          );
        }
      }
      log(`Waiting for ${name} (IT job=${state})`);
    } catch (error) {
      if (error instanceof BundleWaitError) throw error;
      log(`::warning::IT Rollup bundle wait poll failed: ${describeError(error)}`);
    }
    if (now() >= deadline) {
      throw new BundleWaitError(`Timed out waiting for the IT Rollup bundle (last IT job state: ${state})`);
    }
    await sleep(pollMs);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new BundleWaitError('missing IT Rollup bundle wait input: GITHUB_OUTPUT');
    const name = await waitForItRollupBundle({
      gh: runGh,
      repo: process.env.GH_REPO,
      runId: process.env.IT_BUNDLE_RUN_ID,
      runAttempt: process.env.IT_BUNDLE_RUN_ATTEMPT,
    });
    fs.appendFileSync(output, `artifact_name=${name}\n`);
  } catch (error) {
    if (!(error instanceof BundleWaitError)) throw error;
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
