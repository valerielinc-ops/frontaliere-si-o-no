#!/usr/bin/env node

/**
 * Admission marker for translation commits.
 *
 * The marker is committed in the same tree as every translation write. A
 * translation phase therefore cannot push a data SHA before the deploy
 * resolver knows that the SHA is held back. The final completeness check
 * commits the same marker with `state: complete`, which is the first tree the
 * self-driven deploy is allowed to build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

export const TRANSLATION_DEPLOY_HANDOFF_PATH = 'data/translation-deploy-handoff.json';
export const TRANSLATION_DEPLOY_HANDOFF_STATES = Object.freeze(['pending', 'complete']);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function resolvePath(filePath = TRANSLATION_DEPLOY_HANDOFF_PATH) {
  return path.resolve(process.cwd(), filePath);
}

/**
 * @returns {{state: 'unmarked'|'pending'|'complete'|'invalid', admitted: boolean, reason: string}}
 */
export function readTranslationDeployHandoff({ filePath = TRANSLATION_DEPLOY_HANDOFF_PATH } = {}) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    return { state: 'unmarked', admitted: true, reason: 'marker is absent (pre-marker commit)' };
  }
  try {
    const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const state = text(value?.state).toLowerCase();
    if (state === 'complete') return { state, admitted: true, reason: 'translation handoff is complete' };
    if (state === 'pending') return { state, admitted: false, reason: 'translation completeness is still pending' };
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
    throw new Error(`translation handoff state must be pending or complete, got ${JSON.stringify(state)}`);
  }
  const resolved = resolvePath(filePath);
  const current = readTranslationDeployHandoff({ filePath });
  if (current.state === normalized) return false;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify({
    state: normalized,
    updatedAt: new Date().toISOString(),
    ...(text(runId) ? { runId: text(runId) } : {}),
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
