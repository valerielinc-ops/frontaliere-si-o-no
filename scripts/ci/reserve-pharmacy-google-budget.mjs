import fs, { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const MAX_GOOGLE_PLACES_MONTHLY_REQUESTS = 10_000;

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function monthKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid checkedAt: ${value}`);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function validMonth(value) {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(String(value || ''));
}

function providerLimit(provider) {
  const configured = Number(provider?.monthlyRequestLimit);
  if (!Number.isInteger(configured) || configured <= 0) {
    return MAX_GOOGLE_PLACES_MONTHLY_REQUESTS;
  }
  if (configured > MAX_GOOGLE_PLACES_MONTHLY_REQUESTS) {
    throw new Error(`googlePlaces monthlyRequestLimit cannot exceed ${MAX_GOOGLE_PLACES_MONTHLY_REQUESTS}`);
  }
  return configured;
}

function currentUsage(snapshot, month) {
  if (snapshot?.providerUsage === undefined) return 0;
  const usage = snapshot.providerUsage;
  if (!validMonth(usage?.month)) throw new Error('current providerUsage month is invalid');
  if (usage.month !== month) return 0;
  const requests = usage?.googlePlaces?.requests;
  if (!Number.isInteger(requests) || requests < 0 || requests > MAX_GOOGLE_PLACES_MONTHLY_REQUESTS) {
    throw new Error('current providerUsage Google Places requests are invalid');
  }
  return requests;
}

function reservationUsage(reservation, month) {
  if (!reservation) return null;
  if (!validMonth(reservation.month)) throw new Error('reservation month is invalid');
  if (reservation.month !== month) return null;
  const requests = reservation?.googlePlaces?.requests;
  if (!Number.isInteger(requests) || requests < 0 || requests > MAX_GOOGLE_PLACES_MONTHLY_REQUESTS) {
    throw new Error('reservation Google Places requests are invalid');
  }
  return requests;
}

function sourceIsFresh(record, checkedAt, maxAgeDays) {
  const source = (record?.externalSources || []).find(
    (candidate) => candidate.sourceType === 'google_business_profile',
  );
  const sourceCheckedAt = Date.parse(source?.checkedAt || '');
  const current = Date.parse(checkedAt);
  return Number.isFinite(sourceCheckedAt)
    && Number.isFinite(current)
    && current >= sourceCheckedAt
    && current - sourceCheckedAt < Number(maxAgeDays) * 86_400_000;
}

function catalogueIds(catalogues) {
  return new Set(catalogues.flatMap((catalogue) => (
    Array.isArray(catalogue?.pharmacies) ? catalogue.pharmacies : []
  )).map((pharmacy) => pharmacy?.id).filter(Boolean));
}

/**
 * Plan one serialized quota reservation before any provider request is made.
 *
 * A reservation branch is intentionally separate from the refresh PR. The
 * refresh PR can remain pending for hours, while this branch is the durable
 * lease that prevents a later scheduled run from spending the same quota from
 * the same main-branch snapshot. The Actions workflow's concurrency group
 * serializes updates to the branch; a pending reservation fails closed.
 */
export function planGooglePlacesReservation({
  catalogues = [],
  config = {},
  snapshot = {},
  reservation = null,
  checkedAt = new Date().toISOString(),
  apiKeyConfigured = true,
} = {}) {
  const provider = config?.providers?.googlePlaces;
  const month = monthKey(checkedAt);
  const limit = providerLimit(provider);
  const mainRequests = currentUsage(snapshot, month);
  const remoteReservedRequests = reservationUsage(reservation, month);

  const base = {
    month,
    mainRequests,
    reservedRequests: remoteReservedRequests ?? mainRequests,
    requestCount: 0,
    allowGoogle: false,
  };

  if (!provider?.enabled) return { ...base, reason: 'provider_disabled' };
  if (!apiKeyConfigured) return { ...base, reason: 'api_key_missing' };
  if (remoteReservedRequests !== null && remoteReservedRequests > mainRequests) {
    return { ...base, reason: 'pending_reservation' };
  }
  if (mainRequests >= limit) return { ...base, reason: 'budget_exhausted' };

  const ids = catalogueIds(catalogues);
  const configuredIds = [...new Set(Array.isArray(provider.pharmacyIds) ? provider.pharmacyIds : [])]
    .filter((id) => ids.has(id));
  const staleIds = configuredIds.filter((id) => !sourceIsFresh(
    snapshot?.records?.[id],
    checkedAt,
    provider.maxAgeDays,
  ));
  const requestCount = Math.min(staleIds.length, limit - mainRequests);
  if (requestCount <= 0) return { ...base, reason: 'no_stale_pharmacies' };

  return {
    ...base,
    reason: 'reserved',
    requestCount,
    reservedRequests: mainRequests + requestCount,
    allowGoogle: true,
    pharmacyIds: staleIds.slice(0, requestCount),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === 'api-key-configured') {
      args.apiKeyConfigured = argv[index + 1] !== 'false';
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    args[name] = value;
    index += 1;
  }
  return args;
}

function writeGithubOutput(file, plan) {
  if (!file) return;
  fs.appendFileSync(file, [
    `allow_google=${plan.allowGoogle ? 'true' : 'false'}`,
    `request_count=${plan.requestCount}`,
    `reserved_requests=${plan.reservedRequests}`,
    `reservation_month=${plan.month}`,
    `reservation_reason=${plan.reason}`,
  ].join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['config', 'snapshot', 'ticino-catalogue', 'italy-catalogue', 'plan-output'];
  for (const name of required) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const checkedAt = args['checked-at'] || new Date().toISOString();
  const config = readJson(args.config, 'pharmacy enrichment config');
  const snapshot = readJson(args.snapshot, 'pharmacy enrichment snapshot');
  const catalogues = [
    readJson(args['ticino-catalogue'], 'Ticino pharmacy catalogue'),
    readJson(args['italy-catalogue'], 'Italian pharmacy catalogue'),
  ];
  const reservation = args.reservation && fs.existsSync(args.reservation)
    ? readJson(args.reservation, 'Google Places reservation')
    : null;
  const plan = planGooglePlacesReservation({
    catalogues,
    config,
    snapshot,
    reservation,
    checkedAt,
    apiKeyConfigured: args.apiKeyConfigured !== false,
  });

  fs.writeFileSync(args['plan-output'], `${JSON.stringify(plan, null, 2)}\n`);
  if (plan.allowGoogle && args['reservation-output']) {
    fs.writeFileSync(args['reservation-output'], `${JSON.stringify({
      schemaVersion: 1,
      month: plan.month,
      googlePlaces: { requests: plan.reservedRequests },
    }, null, 2)}\n`);
  }
  writeGithubOutput(args['github-output'], plan);
  console.log(`[reserve-pharmacy-google-budget] ${plan.reason}; reserved ${plan.reservedRequests}/${MAX_GOOGLE_PLACES_MONTHLY_REQUESTS}`);
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  try {
    main();
  } catch (error) {
    console.error(`[reserve-pharmacy-google-budget] fatal: ${error?.stack || error}`);
    process.exitCode = 1;
  }
}
