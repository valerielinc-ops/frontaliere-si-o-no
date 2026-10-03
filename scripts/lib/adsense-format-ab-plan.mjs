#!/usr/bin/env node
/**
 * Weekly plan of the AdSense format A/B monitor: which experiments are active
 * right now, and therefore whether the workflow has anything to do.
 *
 * Why it exists. After the TI treatment was rolled back the weekly workflow
 * kept running end to end and posted one fixed "paused" sentence on the
 * tracking issue every Monday; `github-issue-creator.mjs` reopens that issue
 * when someone closes it. With no active experiment there is nothing to
 * measure, so the workflow must stay silent: no install, no credentials, no
 * report, no comment.
 *
 * Why a separate module. The gate runs in its own light job. It imports only
 * `services/adExperiment.ts` on purpose: the report script pulls in
 * `revenue-monitor.mjs`, whose import closure forces a full checkout. Keep
 * this file free of heavy imports and of npm dependencies (the gate job does
 * not run `npm ci`).
 *
 * The plan is derived from `services/adExperiment.ts`, so declaring a surface
 * again restarts the measurement on the next cron run without touching the
 * workflow.
 *
 * Usage:
 *   node scripts/lib/adsense-format-ab-plan.mjs   # prints the plan; in Actions
 *                                                 # also writes the step outputs
 *                                                 # `active` and `experiments`
 *
 * Unlike the report (which always exits 0), this is a gate input and fails
 * loudly: a missing output would silently skip the whole monitor.
 */

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isInfeedAdExperimentSurface } from '../../services/adExperiment.ts';

/**
 * Report experiment id → canton surface that keeps it active. Every id must
 * exist in EXPERIMENTS of `scripts/adsense-format-ab-report.mjs` (enforced by
 * tests/scripts/adsense-format-ab-report.test.ts).
 */
export const EXPERIMENT_SURFACES = Object.freeze([
  Object.freeze({ id: 'svizzera-ticino', canton: 'TI' }),
]);

export const ACTIVE_EXPERIMENT_IDS = Object.freeze(
  EXPERIMENT_SURFACES.filter((surface) => isInfeedAdExperimentSurface(surface.canton)).map((surface) => surface.id),
);

export const PAUSED_REASON = 'nessun esperimento in-feed attivo: il trattamento TI è stato ritirato dopo la regressione CLS del 2026-09-16';

export function buildReportPlan(activeExperimentIds = ACTIVE_EXPERIMENT_IDS) {
  const experimentIds = [...activeExperimentIds];
  for (const id of experimentIds) {
    // The ids end up in a shell loop of the workflow.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id))) {
      throw new Error(`Id esperimento non valido per il workflow: ${JSON.stringify(id)}`);
    }
  }
  const active = experimentIds.length > 0;
  return {
    active,
    experimentIds,
    message: active
      ? `AdSense format A/B — esperimenti attivi: ${experimentIds.join(', ')}.`
      : `AdSense format A/B — PAUSED: ${PAUSED_REASON}. Nessun report e nessun aggiornamento della issue di monitoraggio.`,
  };
}

export function publishReportPlan(plan, env = process.env) {
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `active=${plan.active}\nexperiments=${plan.experimentIds.join(' ')}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## AdSense format A/B reports\n\n${plan.message}\n`);
  }
  console.log(plan.message);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) publishReportPlan(buildReportPlan());
