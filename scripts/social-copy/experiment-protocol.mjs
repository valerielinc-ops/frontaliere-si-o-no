#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { LINKEDIN_MEMBER_ANALYTICS_STORAGE_APPROVAL_ENV } from '../lib/linkedin-member-insights.mjs';
import { setRcParamWithEtag } from '../lib/remote-config-admin.mjs';
import { loadPrivateSocialNativeInsights } from '../lib/social-native-insights-store.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { loadSocialCopyPack } from '../lib/social-copy-pack.mjs';
import {
  SOCIAL_COPY_EXPERIMENT_PARAM,
  runSocialCopyExperimentProtocol,
} from '../lib/social-copy-experiment-runner.mjs';

function parseArgs(argv = []) {
  const options = { asOf: new Date() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--as-of') options.asOf = new Date(argv[++index]);
    else if (arg.startsWith('--as-of=')) options.asOf = new Date(arg.slice('--as-of='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.help && !Number.isFinite(options.asOf.getTime())) throw new Error('--as-of must be a valid timestamp');
  return options;
}

export function readFirebaseServiceAccount(env = process.env) {
  let raw = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const credentialPath = String(env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!raw && credentialPath) {
    if (!existsSync(credentialPath)) throw new Error('GOOGLE_APPLICATION_CREDENTIALS points to a missing file');
    raw = readFileSync(credentialPath, 'utf8');
  }
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    if (credentials?.type !== 'service_account'
      || typeof credentials.project_id !== 'string'
      || typeof credentials.client_email !== 'string'
      || typeof credentials.private_key !== 'string') return null;
    return credentials;
  } catch {
    throw new Error('Firebase service-account credentials are not valid JSON');
  }
}

export async function run({
  env = process.env,
  asOf = new Date(),
  db,
  packLoader = loadSocialCopyPack,
  insightsLoader = loadPrivateSocialNativeInsights,
  setParam = setRcParamWithEtag,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const current = asOf instanceof Date ? asOf : new Date(asOf);
  if (!Number.isFinite(current.getTime())) throw new Error('asOf must be a valid timestamp');
  const credentials = readFirebaseServiceAccount(env);
  if (!db && !credentials && !env.GOOGLE_APPLICATION_CREDENTIALS) {
    stdout.write('Social copy experiment protocol skipped: Firebase credentials unavailable.\n');
    return 0;
  }

  const firestore = db || await getFirestoreDb();
  const pack = packLoader({ now: current, onWarning: (message) => stderr.write(`${message}\n`) });
  const insights = await insightsLoader(firestore, { asOf: current });
  const setRemoteConfig = async (config) => {
    if (!credentials) return { ok: false, detail: 'service-account credentials unavailable for Remote Config' };
    return setParam({
      credentials,
      name: SOCIAL_COPY_EXPERIMENT_PARAM,
      value: JSON.stringify(config),
      description: 'Frozen exact-ID social-copy assignment and verified winner map.',
      versionDescription: 'Reconcile validated social-copy experiments',
    });
  };
  await runSocialCopyExperimentProtocol({
    db: firestore,
    pack,
    insights,
    asOf: current,
    linkedinPostAnalyticsStorageApproved: env[LINKEDIN_MEMBER_ANALYTICS_STORAGE_APPROVAL_ENV] === 'true',
    setRemoteConfig,
    logger: (summary) => {
      stdout.write(`Social copy experiment protocol: ${summary.status}; candidates=${summary.candidates}; registrations=${summary.registrations}; winners=${summary.winners}; waiting=${summary.notReady}; remoteConfigChanged=${summary.remoteConfigChanged}.\n`);
    },
  });
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/social-copy/experiment-protocol.mjs [--as-of ISO]\n');
  } else {
    run(options).catch((error) => {
      process.stderr.write(`Social copy experiment protocol failed: ${String(error?.message || error).slice(0, 300)}\n`);
      process.exitCode = 1;
    });
  }
}
