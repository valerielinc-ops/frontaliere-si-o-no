#!/usr/bin/env node
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  pruneExpiredSocialCopyAssignments,
  SOCIAL_COPY_ASSIGNMENT_RETENTION_DAYS,
} from '../lib/firebase-social-copy-assignment.mjs';

export async function run({ env = process.env, prune = pruneExpiredSocialCopyAssignments, stdout = process.stdout } = {}) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON && !env.GOOGLE_APPLICATION_CREDENTIALS) {
    stdout.write('Social copy assignment cleanup skipped: Firebase credentials unavailable.\n');
    return 0;
  }
  const result = await prune({ retentionDays: SOCIAL_COPY_ASSIGNMENT_RETENTION_DAYS, pageSize: 250 });
  stdout.write(`Pruned ${result.deleted} expired social-copy assignment records (cutoff ${result.cutoff}).\n`);
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write('Social copy assignment cleanup failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
