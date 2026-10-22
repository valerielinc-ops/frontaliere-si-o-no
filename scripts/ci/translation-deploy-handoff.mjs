#!/usr/bin/env node

/**
 * Admission marker for translation commits.
 *
 * The marker is committed in the same tree as every translation write. A
 * translation phase therefore cannot push a data SHA before the deploy
 * resolver knows that the SHA is being observed. A complete handoff is the
 * preferred path; a terminal/incomplete run records `fallback`, while a stale
 * `pending` marker expires so a translation outage cannot wedge production.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

export const TRANSLATION_DEPLOY_HANDOFF_PATH = 'data/translation-deploy-handoff.json';
export const TRANSLATION_DEPLOY_HANDOFF_STATES = Object.freeze(['pending', 'complete', 'fallback']);
export const DEFAULT_TRANSLATION_PENDING_TTL_MS = 2 * 60 * 60 * 1000;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function resolvePath(filePath = TRANSLATION_DEPLOY_HANDOFF_PATH) {
  return path.resolve(process.cwd(), filePath);
}

function durationLabel(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60000));
  return `${minutes}m`;
}

/**
 * @returns {{state: 'unmarked'|'pending'|'complete'|'fallback'|'invalid', admitted: boolean, reason: string, runId?: string, updatedAt?: string, ageMs?: number, expired?: boolean}}
 */
export function readTranslationDeployHandoff({
  filePath = TRANSLATION_DEPLOY_HANDOFF_PATH,
  nowMs = Date.now(),
  pendingTtlMs = DEFAULT_TRANSLATION_PENDING_TTL_MS,
} = {}) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return { state: 'unmarked', admitted: true, reason: 'marker is absent (pre-marker commit)' };
  }
  try {
    const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const state = text(value?.state).toLowerCase();
    const runId = text(value?.runId);
    const updatedAt = text(value?.updatedAt);
    if (state === 'complete') return { state, admitted: true, runId, updatedAt, reason: 'translation handoff is complete' };
    if (state === 'fallback') {
      return {
        state,
        admitted: true,
        runId,
        updatedAt,
        reason: 'translation handoff is incomplete; deploy uses the existing locale fallback',
      };
    }
    if (state === 'pending') {
      const updatedAtMs = Date.parse(updatedAt);
      if (!Number.isFinite(updatedAtMs)) {
        return {
          state,
          admitted: false,
          runId,
          updatedAt,
          reason: 'translation handoff pending marker has no valid updatedAt',
        };
      }
      const ageMs = Number(nowMs) - updatedAtMs;
      const ttlMs = Number(pendingTtlMs);
      if (Number.isFinite(ttlMs) && ttlMs >= 0 && ageMs >= ttlMs) {
        return {
          state,
          admitted: true,
          runId,
          updatedAt,
          ageMs,
          expired: true,
          reason: `translation handoff pending expired after ${durationLabel(ageMs)}; deploy uses the existing locale fallback`,
        };
      }
      return {
        state,
        admitted: false,
        runId,
        updatedAt,
        ageMs,
        reason: `translation completeness is still pending (${durationLabel(Math.max(0, ageMs))}; TTL ${durationLabel(ttlMs)})`,
      };
    }
    return { state: 'invalid', admitted: false, reason: `unsupported translation handoff state ${JSON.stringify(state || '<missing>')}` };
  } catch (error) {
    return { state: 'invalid', admitted: false, reason: `translation handoff marker is unreadable: ${error?.message || error}` };
  }
}

export function writeTranslationDeployHandoff({
  state,
  filePath = TRANSLATION_DEPLOY_HANDOFF_PATH,
  runId = process.env.GITHUB_RUN_ID || '',
  expectedRunId = process.env.TRANSLATION_DEPLOY_HANDOFF_EXPECTED_RUN_ID || '',
} = {}) {
  const normalized = text(state).toLowerCase();
  if (!TRANSLATION_DEPLOY_HANDOFF_STATES.includes(normalized)) {
    throw new Error(`translation handoff state must be pending, complete, or fallback, got ${JSON.stringify(state)}`);
  }
  const resolved = resolvePath(filePath);
  const current = readTranslationDeployHandoff({ filePath });
  const normalizedRunId = text(runId);
  const normalizedExpectedRunId = text(expectedRunId);
  if (normalizedExpectedRunId) {
    if (!/^\d+$/u.test(normalizedExpectedRunId) || normalizedRunId !== normalizedExpectedRunId) {
      throw new Error('translation handoff expected run id must match GITHUB_RUN_ID');
    }
    if (current.state === 'invalid') {
      throw new Error(`cannot compare-and-set an invalid translation handoff marker: ${current.reason}`);
    }
    // Timeout recovery may release only the pending marker owned by the run
    // that timed out. A later run can already have reopened the marker while
    // this recovery job waits for the shared data-pipeline concurrency slot.
    if (current.state !== 'pending' || current.runId !== normalizedExpectedRunId) return false;
  }
  // A later failure in the same translation run must not downgrade a handoff
  // that was already proven complete. A new run may reopen it as pending,
  // which is how the next completeness attempt gets a fresh TTL.
  if (current.state === 'complete'
      && normalized !== 'complete'
      && current.runId === normalizedRunId) return false;
  // A translation run may invoke git-commit-data.sh more than once. Refresh a
  // pending marker only when a NEW run owns it; otherwise every data commit in
  // one run would move the TTL and create needless marker commits.
  if (current.state === normalized
      && (normalized !== 'pending' || current.runId === normalizedRunId)) return false;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify({
    state: normalized,
    updatedAt: new Date().toISOString(),
    ...(normalizedRunId ? { runId: normalizedRunId } : {}),
  }, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Checks the handoff owner either in the current checkout or at a fetched git
 * ref. A missing marker is a normal mismatch; unreadable refs or malformed
 * JSON throw so callers fail closed instead of publishing a guessed state.
 */
export function translationDeployHandoffMatches({
  state,
  runId,
  filePath = TRANSLATION_DEPLOY_HANDOFF_PATH,
  gitRef,
} = {}) {
  const expectedState = text(state).toLowerCase();
  const expectedRunId = text(runId);
  if (!TRANSLATION_DEPLOY_HANDOFF_STATES.includes(expectedState) || !/^\d+$/u.test(expectedRunId)) {
    throw new Error('translation handoff match requires a valid state and numeric run id');
  }

  let raw;
  if (gitRef) {
    let commit;
    try {
      commit = execFileSync('git', ['rev-parse', '--verify', `${gitRef}^{commit}`], { encoding: 'utf8' }).trim();
    } catch (error) {
      throw new Error(`cannot resolve translation handoff git ref ${JSON.stringify(gitRef)}: ${error?.message || error}`);
    }
    const object = `${commit}:${filePath}`;
    try {
      execFileSync('git', ['cat-file', '-e', object], { stdio: 'ignore' });
    } catch {
      return false;
    }
    try {
      raw = execFileSync('git', ['show', object], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error(`cannot read translation handoff from ${JSON.stringify(gitRef)}: ${error?.message || error}`);
    }
  } else {
    const resolved = resolvePath(filePath);
    if (!fs.existsSync(resolved)) return false;
    raw = fs.readFileSync(resolved, 'utf8');
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse translation handoff marker: ${error?.message || error}`);
  }
  return text(value?.state).toLowerCase() === expectedState
    && text(value?.runId) === expectedRunId;
}

if (isInvokedDirectly(import.meta.url)) {
  const filePath = process.argv.includes('--file')
    ? process.argv[process.argv.indexOf('--file') + 1]
    : TRANSLATION_DEPLOY_HANDOFF_PATH;
  const matchesIndex = process.argv.indexOf('--matches');
  if (matchesIndex !== -1) {
    const state = process.argv[matchesIndex + 1];
    const runId = process.argv[matchesIndex + 2];
    const gitRefIndex = process.argv.indexOf('--git-ref');
    const gitRef = gitRefIndex === -1 ? undefined : process.argv[gitRefIndex + 1];
    try {
      const matches = translationDeployHandoffMatches({ state, runId, filePath, gitRef });
      console.log(`[translation-handoff] ${matches ? 'matches' : 'does not match'} ${state} for run ${runId}`);
      if (!matches) process.exitCode = 1;
    } catch (error) {
      console.error(`[translation-handoff] cannot validate marker: ${error?.message || error}`);
      process.exitCode = 2;
    }
  } else {
    const writeIndex = process.argv.indexOf('--write');
    if (writeIndex !== -1) {
      const state = process.argv[writeIndex + 1];
      const changed = writeTranslationDeployHandoff({ state, filePath });
      console.log(`[translation-handoff] ${changed ? 'wrote' : 'kept'} ${state}`);
    } else {
      const verdict = readTranslationDeployHandoff({ filePath });
      console.log(`[translation-handoff] ${verdict.admitted ? 'admit' : 'hold'}: ${verdict.reason}`);
      if (!verdict.admitted) process.exitCode = 1;
    }
  }
}
