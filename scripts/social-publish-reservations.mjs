#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { fetchRcTemplate, getRemoteConfig } from './lib/remote-config-admin.mjs';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import {
  listStaleSocialPublishReservations,
  reconcileSocialPublishReservationPublished,
  SOCIAL_PUBLISH_RESERVATION_STALE_AFTER_MS,
} from './lib/social-publish-reservations.mjs';
import { verifyExactSocialPublishedPost } from './lib/social-publish-reconciliation.mjs';

const RC_CONFIG = Object.freeze({
  facebook: { account: ['FB_PAGE_ID', 'FB_PAGE_ID'], token: ['FB_PAGE_ACCESS_TOKEN', 'SERVER_FB_PAGE_ACCESS_TOKEN'] },
  instagram: { account: ['INSTAGRAM_BUSINESS_ACCOUNT_ID', 'INSTAGRAM_BUSINESS_ACCOUNT_ID'], token: ['INSTAGRAM_ACCESS_TOKEN', 'SERVER_INSTAGRAM_ACCESS_TOKEN'] },
  linkedinMember: { account: ['LINKEDIN_MEMBER_URN', 'LINKEDIN_MEMBER_URN'], token: ['LINKEDIN_MEMBER_ACCESS_TOKEN', 'LINKEDIN_MEMBER_ACCESS_TOKEN'] },
  telegram: { account: ['TELEGRAM_CHANNEL_ID', 'TELEGRAM_CHANNEL_ID'], token: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'] },
});

function parseArgs(argv) {
  const result = { action: null, platform: null, capGroup: 'feed', minimumAgeMs: SOCIAL_PUBLISH_RESERVATION_STALE_AFTER_MS };
  const values = new Map();
  for (const arg of argv) {
    if (arg === '--help') result.help = true;
    else if (arg === '--report' || arg === '--resolve-published' || arg === '--summary-all') {
      if (result.action) throw new Error('choose one command action');
      result.action = arg === '--report' ? 'report'
        : arg === '--resolve-published' ? 'resolve-published'
          : 'summary-all';
    } else if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      if (separator < 3) throw new Error('options must use --name=value');
      const name = arg.slice(2, separator);
      if (values.has(name)) throw new Error(`duplicate option --${name}`);
      values.set(name, arg.slice(separator + 1));
    } else throw new Error('unexpected argument');
  }
  for (const name of values.keys()) {
    if (!['platform', 'cap-group', 'min-age-minutes', 'key-hash', 'native-post-id'].includes(name)) {
      throw new Error(`unknown option --${name}`);
    }
  }
  result.platform = values.get('platform') || null;
  result.capGroup = values.get('cap-group') || 'feed';
  if (values.has('min-age-minutes')) {
    const minutes = Number(values.get('min-age-minutes'));
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10_080) throw new Error('min-age-minutes must be an integer from 1 to 10080');
    result.minimumAgeMs = minutes * 60_000;
  }
  result.keyHash = values.get('key-hash') || null;
  result.nativePostId = values.get('native-post-id') || null;
  if (result.help) return result;
  if (!result.action) throw new Error('an action is required');
  if (result.action === 'summary-all') {
    if (values.size) throw new Error('summary-all does not accept platform, cap-group, or post identifiers');
    return result;
  }
  if (!Object.hasOwn(RC_CONFIG, result.platform)) throw new Error('a supported platform is required');
  if (result.capGroup !== 'feed' && !(result.platform === 'instagram' && result.capGroup === 'story')) {
    throw new Error('cap-group must be feed, or story for Instagram');
  }
  if (result.action === 'report' && (result.keyHash || result.nativePostId)) throw new Error('report does not accept post identifiers');
  if (result.action === 'resolve-published'
    && (!/^[a-f0-9]{64}$/u.test(result.keyHash || '') || !result.nativePostId)) {
    throw new Error('resolve-published requires --key-hash=<64 lowercase hex> and --native-post-id=<exact platform ID>');
  }
  return result;
}

function rcParameter(template, name) {
  const value = template?.parameters?.[name]?.defaultValue?.value;
  return typeof value === 'string' ? value.trim() : '';
}

async function loadRemoteConfigTemplate() {
  try {
    return { template: await fetchRcTemplate(await getRemoteConfig()), available: true };
  } catch {
    // Environment values remain usable; callers must distinguish unknown RC state.
    return { template: null, available: false };
  }
}

function configuredValue([envName, rcName], template, env) {
  return String(env[envName] || rcParameter(template, rcName) || '').trim();
}

async function loadConfiguredAccountIds(env = process.env) {
  const { template, available } = await loadRemoteConfigTemplate();
  return {
    remoteConfigAvailable: available,
    accounts: Object.fromEntries(Object.entries(RC_CONFIG).map(([platform, mapping]) => [
      platform,
      configuredValue(mapping.account, template, env),
    ])),
  };
}

async function loadConfiguredValues(platform, env = process.env, { includeAccessToken = true } = {}) {
  const { template } = await loadRemoteConfigTemplate();
  const mapping = RC_CONFIG[platform];
  const accountId = configuredValue(mapping.account, template, env);
  if (!accountId) throw new Error(`configured ${platform} account ID is unavailable`);
  return {
    accountId,
    accessToken: includeAccessToken ? configuredValue(mapping.token, template, env) : '',
  };
}

function help() {
  return [
    'Aggregate stale-reservation health report (no post IDs or content):',
    '  node scripts/social-publish-reservations.mjs --summary-all',
    'Read-only stale reservation report:',
    '  node scripts/social-publish-reservations.mjs --report --platform=facebook [--cap-group=feed] [--min-age-minutes=30]',
    'Resolve only after the exact native API read confirms publication:',
    '  node scripts/social-publish-reservations.mjs --resolve-published --platform=facebook --key-hash=<hash> --native-post-id=<exact-id>',
    'Facebook, Instagram, and LinkedIn Member support exact positive verification; Telegram supports reporting only.',
  ].join('\n');
}

function formatAggregateSummary(report) {
  const rows = report.reservations.map((row) => [
    row.platform,
    row.capGroup,
    row.status,
    row.staleCount ?? '—',
    row.fingerprintAvailableCount ?? '—',
  ]);
  return [
    '## Stale social publish reservations',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '| Platform | Cap group | Status | Stale | Content fingerprint stored |',
    '|---|---|---:|---:|---:|',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    `Known stale reservations: **${report.totalStaleCount}** across **${report.readableScopeCount}** readable scopes; unknown scopes: **${report.unknownScopeCount}**; not configured: **${report.unconfiguredScopeCount}**. Fingerprint counts do not verify API read grants. This aggregate contains no account IDs, post IDs, hashes, or content.`,
    '',
  ].join('\n');
}

export async function runSocialPublishReservationsCli(argv = process.argv.slice(2), {
  env = process.env,
  fetchImpl = fetch,
  getDb = getFirestoreDb,
  loadValues = loadConfiguredValues,
  loadAccountIds = loadConfiguredAccountIds,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log(help());
    return { status: 'help' };
  }
  if (args.action === 'summary-all') {
    const configuration = await loadAccountIds(env);
    const accountIds = configuration?.accounts || configuration || {};
    const remoteConfigAvailable = configuration?.remoteConfigAvailable !== false;
    const db = await getDb();
    const asOf = now();
    const scopes = [
      { platform: 'facebook', capGroup: 'feed' },
      { platform: 'instagram', capGroup: 'feed' },
      { platform: 'instagram', capGroup: 'story' },
      { platform: 'linkedinMember', capGroup: 'feed' },
      { platform: 'telegram', capGroup: 'feed' },
    ];
    const reservations = [];
    for (const scope of scopes) {
      const accountId = accountIds?.[scope.platform];
      if (!accountId) {
        reservations.push({
          ...scope,
          status: remoteConfigAvailable ? 'not-configured' : 'config-unknown',
          staleCount: null,
          fingerprintAvailableCount: null,
        });
        continue;
      }
      try {
        const stale = await listStaleSocialPublishReservations({ db, ...scope, accountId, now: asOf });
        const fingerprintAvailableCount = stale.filter((row) => row.fingerprintAvailable).length;
        reservations.push({
          ...scope,
          status: 'ok',
          staleCount: stale.length,
          fingerprintAvailableCount,
        });
      } catch {
        reservations.push({ ...scope, status: 'read-error', staleCount: null, fingerprintAvailableCount: null });
      }
    }
    const report = {
      status: reservations.some((row) => row.status === 'read-error' || row.status === 'config-unknown') ? 'partial' : 'ok',
      generatedAt: new Date(asOf).toISOString(),
      reservations,
      totalStaleCount: reservations.reduce((sum, row) => sum + (row.staleCount || 0), 0),
      readableScopeCount: reservations.filter((row) => row.status === 'ok').length,
      unknownScopeCount: reservations.filter((row) => row.status === 'read-error' || row.status === 'config-unknown').length,
      unconfiguredScopeCount: reservations.filter((row) => row.status === 'not-configured').length,
    };
    log(formatAggregateSummary(report));
    if (report.status !== 'ok') throw new Error('one or more stale-reservation scopes could not be read or configured');
    return report;
  }
  const { accountId, accessToken } = await loadValues(args.platform, env, {
    includeAccessToken: args.action === 'resolve-published',
  });
  const db = await getDb();
  const reservations = await listStaleSocialPublishReservations({
    db,
    platform: args.platform,
    capGroup: args.capGroup,
    accountId,
    now: now(),
    minimumAgeMs: args.minimumAgeMs,
  });

  if (args.action === 'report') {
    const output = { status: 'ok', platform: args.platform, capGroup: args.capGroup, reservations };
    log(JSON.stringify(output, null, 2));
    return output;
  }

  const candidate = reservations.find((reservation) => reservation.keyHash === args.keyHash);
  if (!candidate) throw new Error('the exact reservation hash is not currently stale and unresolved in this account scope');
  if (!candidate.fingerprintAvailable) throw new Error('this reservation predates content matching and cannot be safely reconciled automatically');
  if (!accessToken) throw new Error(`the configured ${args.platform} read token is unavailable`);
  const verifiedAt = now();
  const verification = await verifyExactSocialPublishedPost({
    platform: args.platform,
    capGroup: args.capGroup,
    accountId,
    nativePostId: args.nativePostId,
    accessToken,
    fetchImpl,
  });
  const applied = await reconcileSocialPublishReservationPublished({
    db,
    platform: args.platform,
    capGroup: args.capGroup,
    accountId,
    keyHash: args.keyHash,
    nativePostId: args.nativePostId,
    provider: verification.provider,
    nativeContentFingerprint: verification.nativeContentFingerprint,
    publishedAt: verification.publishedAt,
    verifiedAt,
    minimumAgeMs: args.minimumAgeMs,
  });
  if (!applied) throw new Error('the reservation was already reconciled');
  const output = {
    status: 'resolved-published',
    platform: args.platform,
    capGroup: args.capGroup,
    keyHash: args.keyHash,
    provider: verification.provider,
    publishedAt: verification.publishedAt,
    verifiedAt: new Date(verifiedAt).toISOString(),
  };
  log(JSON.stringify(output, null, 2));
  return output;
}

const directInvocation = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (directInvocation) {
  runSocialPublishReservationsCli().catch((error) => {
    console.error(`social-publish-reservations: ${error?.message || 'operation failed'}`);
    process.exitCode = 1;
  });
}
