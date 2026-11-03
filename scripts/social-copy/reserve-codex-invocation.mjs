#!/usr/bin/env node
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
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

export async function run({ env = process.env, db, now = new Date(), stdout = process.stdout } = {}) {
  const firestore = db || await getFirestoreDb();
  const result = await reserveSocialCopyCodexInvocation({
    db: firestore,
    invocationId: socialCopyInvocationId(env),
    now,
  });
  stdout.write(`allowed=${result.allowed}\n`);
  stdout.write(`count=${result.count}\n`);
  stdout.write(`limit=${result.limit}\n`);
  if (!result.allowed) {
    stdout.write(`window_ends_at=${result.windowEndsAt}\n`);
    stdout.write(`message=rolling seven-day Codex generation limit reached\n`);
  } else if (result.alreadyReserved) {
    stdout.write('message=invocation already reserved for this workflow attempt\n');
  }
  return result;
}

export { SOCIAL_COPY_CODEX_INVOCATION_LIMIT };

if (isInvokedDirectly(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`Social copy Codex budget reservation failed: ${String(error?.message || error).slice(0, 300)}\n`);
    process.exitCode = 1;
  });
}
