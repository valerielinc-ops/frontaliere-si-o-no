#!/usr/bin/env node
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  checkSocialCopyCodexInvocation,
  reserveSocialCopyCodexInvocation,
  SOCIAL_COPY_CODEX_INVOCATION_LIMIT,
} from '../lib/social-copy-invocation-limit.mjs';

export function socialCopyInvocationId(env = process.env) {
  const repository = String(env.GITHUB_REPOSITORY || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  const runAttempt = String(env.GITHUB_RUN_ATTEMPT || '').trim();
  if (!repository || !runId || !runAttempt) {
    throw new Error('GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT are required');
  }
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)) {
    throw new Error('GitHub run identity is malformed');
  }
  return `${repository}/${runId}/${runAttempt}`;
}

/** Give scheduled runs a stable Monday UTC slot despite setup and queue jitter. */
export function socialCopyReservationTimestamp({ env = process.env, now = new Date() } = {}) {
  const current = now instanceof Date ? new Date(now) : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error('reservation time must be a valid timestamp');
  if (String(env.GITHUB_EVENT_NAME || '').trim() !== 'schedule') return current;
  const daysSinceMonday = (current.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() - daysSinceMonday,
  ));
}

function assertSocialCopyPackProductionRef(env = process.env) {
  if (String(env.GITHUB_REF || '').trim() !== 'refs/heads/main') {
    throw new Error('Social copy production generation is restricted to refs/heads/main');
  }
}

export async function run({ env = process.env, db, now = new Date(), stdout = process.stdout, mode = 'reserve' } = {}) {
  assertSocialCopyPackProductionRef(env);
  if (mode !== 'check' && mode !== 'reserve') throw new Error('mode must be check or reserve');
  const firestore = db || await getFirestoreDb();
  const operation = mode === 'check' ? checkSocialCopyCodexInvocation : reserveSocialCopyCodexInvocation;
  const result = await operation({
    db: firestore,
    invocationId: socialCopyInvocationId(env),
    now: socialCopyReservationTimestamp({ env, now }),
  });
  stdout.write(`allowed=${result.allowed}\n`);
  stdout.write(`count=${result.count}\n`);
  stdout.write(`limit=${result.limit}\n`);
  stdout.write(`mode=${mode}\n`);
  if (!result.allowed) {
    stdout.write(`window_ends_at=${result.windowEndsAt}\n`);
    stdout.write(`message=rolling seven-day Codex generation limit reached; ${mode === 'check' ? 'no reservation was created' : 'generation must be skipped'}\n`);
  } else if (result.alreadyReserved) {
    stdout.write('message=invocation already reserved for this workflow attempt\n');
  }
  return result;
}

export { SOCIAL_COPY_CODEX_INVOCATION_LIMIT };

if (isInvokedDirectly(import.meta.url)) {
  run({ mode: process.argv.includes('--check') ? 'check' : 'reserve' }).catch((error) => {
    process.stderr.write(`Social copy Codex budget reservation failed: ${String(error?.message || error).slice(0, 300)}\n`);
    process.exitCode = 1;
  });
}
