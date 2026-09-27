#!/usr/bin/env node
/**
 * translate-repair-lane-gate.mjs — decide, BEFORE the Codex auth broker starts,
 * whether the Phase 2d/2e repair lanes of translate-pending still have a useful
 * slice of the run-wide translation envelope.
 *
 * Why. Phases 2d (titles) and 2e (descriptions) are the last translation lanes
 * of the job and share the 210min run-wide deadline measured from the shared
 * run clock (scripts/lib/translate-run-clock.mjs). Each lane already stops at
 * that deadline, but only INSIDE its own process: the steps around it still ran.
 * Measured on the corpus runs of 2026-09-23..27 (frontaliere-articles):
 *   · 36240711198: Phase 2d started at 215min (deadline 210). Broker setup 21s,
 *     lane 10s to load 12'330 slots and translate 0, then "Commit title fixes"
 *     137s of 3-way merges ending in "No effective changes".
 *   · 36169299281: Phase 2e started at 252min. Broker 22s, lane 0s, then
 *     "Commit description fixes" 850s; the job was killed at the 350min cap
 *     13min later, in "Log translation stats (after)".
 *   · 35897636278 (pre-broker): Phase 2e at 304min, lane 0s, commit 713s, then
 *     the same 350min kill.
 * Every start with budget measured instead had >= 57min left (2d/2e at
 * 99-153min). A lane that starts with less than one Codex budget
 * (FREE_TRANSLATE_CODEX_MAX_MS, 15min) cannot spend it, and its fixed costs
 * (broker + Codex CLI install ~21s, lane start-up, a commit step of 2-14min
 * even when nothing changed) then come out of the 140min queue that the slug
 * regeneration, the translation-cache save and the deploy trigger depend on.
 *
 * Output: `run=true|false` on $GITHUB_OUTPUT, plus a ::notice:: when the lanes
 * are skipped. A missing run-clock marker is not decided here: with
 * TRANSLATE_RUN_CLOCK_REQUIRED=1 resolveRunStartMs() throws and the step fails
 * loud, exactly as the lanes themselves would.
 *
 * Env:
 *   REPAIR_LANE_DEADLINE_MS       — run-wide deadline shared with the lanes.
 *   REPAIR_LANE_MIN_REMAINING_MS  — minimum budget left for the lanes to start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRunStartMs } from './lib/translate-run-clock.mjs';

export const DEFAULT_REPAIR_LANE_DEADLINE_MS = 210 * 60 * 1000;
export const DEFAULT_REPAIR_LANE_MIN_REMAINING_MS = 15 * 60 * 1000;

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Pure decision: the lanes run only when the run-wide envelope still holds at
 * least `minRemainingMs`.
 */
export function decideRepairLane({ startMs, nowMs, deadlineMs, minRemainingMs }) {
  const elapsedMs = Math.max(0, nowMs - startMs);
  const remainingMs = deadlineMs - elapsedMs;
  return {
    run: remainingMs >= minRemainingMs,
    elapsedMs,
    remainingMs,
    deadlineMs,
    minRemainingMs,
  };
}

function minutes(ms) {
  return Math.round(ms / 60000);
}

export function describeDecision(decision) {
  const { run, elapsedMs, remainingMs, deadlineMs, minRemainingMs } = decision;
  const where = `${minutes(elapsedMs)}min elapsed of the ${minutes(deadlineMs)}min run-wide translation envelope`;
  if (run) {
    return `Phase 2d/2e repair lanes start: ${where}, ${minutes(remainingMs)}min left (threshold ${minutes(minRemainingMs)}min).`;
  }
  const left = remainingMs > 0 ? `only ${minutes(remainingMs)}min left` : `deadline passed ${minutes(-remainingMs)}min ago`;
  return `Phase 2d/2e repair lanes skipped: ${where}, ${left} (threshold ${minutes(minRemainingMs)}min). `
    + 'Codex auth broker not started; the untranslated slots stay queued for the next scheduled run.';
}

function main() {
  const decision = decideRepairLane({
    startMs: resolveRunStartMs(),
    nowMs: Date.now(),
    deadlineMs: positiveMs(process.env.REPAIR_LANE_DEADLINE_MS, DEFAULT_REPAIR_LANE_DEADLINE_MS),
    minRemainingMs: positiveMs(process.env.REPAIR_LANE_MIN_REMAINING_MS, DEFAULT_REPAIR_LANE_MIN_REMAINING_MS),
  });
  const message = describeDecision(decision);
  console.log(decision.run ? message : `::notice title=translate-pending repair lanes skipped::${message}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${decision.run ? 'true' : 'false'}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
