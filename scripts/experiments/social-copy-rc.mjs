#!/usr/bin/env node
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { loadPrivateSocialNativeInsights } from '../lib/social-native-insights-store.mjs';
import { loadSocialCopyPack } from '../lib/social-copy-pack.mjs';
import { LINKEDIN_MEMBER_ANALYTICS_STORAGE_APPROVAL_ENV } from '../lib/linkedin-member-insights.mjs';
import { setRcParamWithEtag } from '../lib/remote-config-admin.mjs';
import {
  buildSocialCopyExperimentConfig,
  runSocialCopyExperimentProtocol,
  SOCIAL_COPY_EXPERIMENT_PARAM,
} from '../lib/social-copy-experiment-runner.mjs';
import { readFirebaseServiceAccount } from '../social-copy/experiment-protocol.mjs';

export const SOCIAL_COPY_EXPERIMENT_CONFIG = Object.freeze(buildSocialCopyExperimentConfig());
export { SOCIAL_COPY_EXPERIMENT_PARAM };

export async function run({
  env = process.env,
  setParam = setRcParamWithEtag,
  stdout = process.stdout,
  stderr = process.stderr,
  db,
  packLoader = loadSocialCopyPack,
  insightsLoader = loadPrivateSocialNativeInsights,
  asOf = new Date(),
} = {}) {
  const credentials = readFirebaseServiceAccount(env);
  if (!credentials) {
    stdout.write('Social copy experiment config skipped: Firebase service account unavailable.\n');
    return 0;
  }
  const current = asOf instanceof Date ? asOf : new Date(asOf);
  if (!Number.isFinite(current.getTime())) throw new Error('asOf must be a valid timestamp');
  const firestore = db || await getFirestoreDb();
  const pack = packLoader({ now: current, onWarning: (message) => stderr.write(`${message}\n`) });
  const insights = await insightsLoader(firestore, { asOf: current });
  const result = await runSocialCopyExperimentProtocol({
    db: firestore,
    pack,
    insights,
    asOf: current,
    linkedinPostAnalyticsStorageApproved: env[LINKEDIN_MEMBER_ANALYTICS_STORAGE_APPROVAL_ENV] === 'true',
    setRemoteConfig: async (config) => setParam({
      credentials,
      name: SOCIAL_COPY_EXPERIMENT_PARAM,
      value: JSON.stringify(config),
      description: 'Frozen exact-ID social-copy assignment and verified winner map.',
      versionDescription: 'Reconcile validated social-copy experiments',
    }),
    logger: (summary) => {
      stdout.write(`Social copy experiment config: ${summary.status}; candidates=${summary.candidates}; registrations=${summary.registrations}; winners=${summary.winners}; waiting=${summary.notReady}; remoteConfigChanged=${summary.remoteConfigChanged}.\n`);
    },
  });
  return result.status === 'pack-unavailable' || result.status === 'waiting-for-evidence' || result.status === 'reconciled' ? 0 : 1;
}

if (isInvokedDirectly(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write('Social copy experiment config failed: ' + String(error?.message || error).slice(0, 300) + '\n');
    process.exitCode = 1;
  });
}
