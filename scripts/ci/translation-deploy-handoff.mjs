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
} = {}) {
  const normalized = text(state).toLowerCase();
  if (!TRANSLATION_DEPLOY_HANDOFF_STATES.includes(normalized)) {
    throw new Error(`translation handoff state must be pending, complete, or fallback, got ${JSON.stringify(state)}`);
  }
  const resolved = resolvePath(filePath);
  const current = readTranslationDeployHandoff({ filePath });
  const normalizedRunId = text(runId);
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

if (isInvokedDirectly(import.meta.url)) {
  const filePath = process.argv.includes('--file')
    ? process.argv[process.argv.indexOf('--file') + 1]
    : TRANSLATION_DEPLOY_HANDOFF_PATH;
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
