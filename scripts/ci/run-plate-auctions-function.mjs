#!/usr/bin/env node
/**
 * Esegue subito il job Cloud Scheduler di `refreshPlateAuctions` e aspetta che
 * il relay pubblico `getPlateAuctions` mostri il giro nuovo.
 *
 * Perché: la function gira in europe-west6 (Zurigo) ogni 6 ore ed è l'unico
 * collector diretto di FR e TI, geo-fenced su IP svizzeri dal 2026-09-25 (il
 * collector statico li legge dal relay). Dopo un deploy serviva poter
 * verificare subito che il giro includa le fonti attive, invece di aspettare
 * fino a 6 ore.
 *
 * Cosa fa, con il service account di FIREBASE_SERVICE_ACCOUNT_JSON (scope
 * cloud-platform):
 *   1. elenca i job Cloud Scheduler di projects/<project_id>/locations/europe-west6
 *      e sceglie l'UNICO il cui nome contiene `refreshPlateAuctions` (0 o più
 *      di uno → errore che li elenca);
 *   2. in dry-run (default del workflow) si ferma lì e stampa lo stato attuale
 *      del relay;
 *   3. altrimenti chiama `<job>:run`, poi legge il relay ogni 30 s per al
 *      massimo 12 minuti, finché ogni fonte `active` nel registry ha
 *      `lastFetchedAt` non anteriore al momento del trigger;
 *   4. stampa per fonte status, lastFetchedAt, lastSuccessAt, rowCount e
 *      ultimo errore; fallisce se allo scadere qualche fonte attiva non è
 *      stata rinfrescata, e la nomina.
 *
 * Il token non viene mai stampato: `::add-mask::` appena ottenuto. Su 403 il
 * messaggio nomina il permesso mancante (roles/cloudscheduler.admin, oppure un
 * ruolo con cloudscheduler.jobs.list e cloudscheduler.jobs.run).
 *
 * Uso: FIREBASE_SERVICE_ACCOUNT_JSON=… node scripts/ci/run-plate-auctions-function.mjs [--dry-run]
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { googleApiJson } from '../lib/google-api-json.mjs';
import { getServiceAccountAccessToken } from '../lib/google-service-account-token.mjs';
import { PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY } from '../../functions/src/plateAuctionSourceRegistry.js';
import { PLATE_AUCTION_PUBLIC_API_RELAY_URL } from '../plate-auctions/connectors/api-relay.mjs';

export const SCHEDULER_LOCATION = 'europe-west6';
export const JOB_NAME_FRAGMENT = 'refreshPlateAuctions';
export const POLL_INTERVAL_MS = 30_000;
export const POLL_TIMEOUT_MS = 12 * 60_000;
const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const SCHEDULER = 'https://cloudscheduler.googleapis.com/v1';
const ROLE_HINT = {
  list: 'the service account lacks cloudscheduler.jobs.list: grant roles/cloudscheduler.admin (or roles/cloudscheduler.viewer plus a role with cloudscheduler.jobs.run) in Google Cloud IAM, then re-run',
  run: 'the service account lacks cloudscheduler.jobs.run: grant roles/cloudscheduler.admin (or a custom role with cloudscheduler.jobs.run) in Google Cloud IAM, then re-run',
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FunctionRunError extends Error {}

async function googleJson(fetchImpl, url, { token, method = 'GET', body, permission }) {
  const { json, response } = await googleApiJson(fetchImpl, url, {
    token,
    method,
    body,
    forbiddenHint: ROLE_HINT[permission] || ROLE_HINT.run,
    ErrorClass: FunctionRunError,
  });
  return { json, date: response.headers?.get?.('date') || null };
}

/** Tutti i job della location, pagina per pagina. */
export async function listSchedulerJobs(fetchImpl, token, projectId, location = SCHEDULER_LOCATION) {
  const base = `${SCHEDULER}/projects/${encodeURIComponent(projectId)}/locations/${location}/jobs`;
  const jobs = [];
  let pageToken = '';
  for (let page = 0; page < 50; page += 1) {
    const url = `${base}?pageSize=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const { json } = await googleJson(fetchImpl, url, { token, permission: 'list' });
    jobs.push(...(json.jobs || []));
    pageToken = json.nextPageToken || '';
    if (!pageToken) return jobs;
  }
  throw new FunctionRunError(`${base}: more than 50 pages of jobs`);
}

/** L'unico job di refreshPlateAuctions, o un errore che dice cosa c'è. */
export function selectRefreshJob(jobs, fragment = JOB_NAME_FRAGMENT) {
  const matching = jobs.filter((job) => String(job?.name || '').includes(fragment));
  if (matching.length === 1) return matching[0];
  const names = (list) => (list.length ? list.map((job) => job.name).join(', ') : 'none');
  if (matching.length === 0) {
    throw new FunctionRunError(`no Cloud Scheduler job in ${SCHEDULER_LOCATION} contains "${fragment}" (jobs: ${names(jobs)}); is the function deployed?`);
  }
  throw new FunctionRunError(`${matching.length} Cloud Scheduler jobs contain "${fragment}" (${names(matching)}); refusing to guess which one to run`);
}

/** Le fonti che il giro deve rinfrescare: quelle `active` nel registry della function. */
export function expectedSourceKeys(registry = PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY) {
  return Object.entries(registry)
    .filter(([, source]) => source?.status === 'active')
    .map(([key]) => key)
    .sort();
}

function isFreshSince(value, sinceMs) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed >= sinceMs;
}

/**
 * Una riga per fonte attesa. `refreshed`: il giro nuovo ha raggiunto la fonte
 * (lastFetchedAt del giro), anche solo per registrarla `degraded`. Ferma il
 * polling. `succeeded`: la fonte è `active` con un lastSuccessAt del giro. È
 * l'esito: `refreshPlateAuctions` scrive lastFetchedAt anche sul percorso
 * `degraded`/`zero_rows`, quindi da solo non prova uno snapshot riuscito.
 */
export function sourceRows(payload, keys, sinceMs) {
  return keys.map((key) => {
    const source = payload?.sources?.[key] || {};
    return {
      key,
      status: source.status || 'missing',
      lastFetchedAt: source.lastFetchedAt || '-',
      lastSuccessAt: source.lastSuccessAt || '-',
      rowCount: typeof source.rowCount === 'number' ? source.rowCount : '-',
      lastError: source.errorCode || '-',
      refreshed: sinceMs === undefined ? undefined : isFreshSince(source.lastFetchedAt, sinceMs),
      succeeded: sinceMs === undefined
        ? undefined
        : source.status === 'active' && isFreshSince(source.lastSuccessAt, sinceMs),
    };
  });
}

export function renderTable(rows) {
  const header = ['source', 'status', 'lastFetchedAt', 'lastSuccessAt', 'rowCount', 'lastError'];
  const cells = rows.map((row) => [row.key, row.status, row.lastFetchedAt, row.lastSuccessAt, String(row.rowCount), row.lastError]);
  const widths = header.map((title, index) => Math.max(title.length, ...cells.map((line) => line[index].length)));
  const format = (line) => line.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
  return [format(header), ...cells.map(format)].join('\n');
}

export function renderMarkdownTable(rows) {
  return [
    '| source | status | lastFetchedAt | lastSuccessAt | rowCount | lastError |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.key} | ${row.status} | ${row.lastFetchedAt} | ${row.lastSuccessAt} | ${row.rowCount} | ${row.lastError} |`),
  ].join('\n');
}

async function readRelay(fetchImpl, relayUrl, nowMs) {
  // Parametro ignorato dalla function: evita una risposta in cache
  // (`Cache-Control: max-age=300`) che mostrerebbe il giro precedente.
  const response = await fetchImpl(`${relayUrl}?fresh=${nowMs}`, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new FunctionRunError(`GET ${relayUrl} → HTTP ${response.status}`);
  return JSON.parse(await response.text());
}

export async function runPlateAuctionsFunction({
  credentials,
  dryRun = true,
  fetchImpl = fetch,
  getAccessToken = getServiceAccountAccessToken,
  sleep = defaultSleep,
  now = () => Date.now(),
  log = console.log,
  mask = (value) => console.log(`::add-mask::${value}`),
  summary = (_markdown) => {},
  relayUrl = PLATE_AUCTION_PUBLIC_API_RELAY_URL,
  expectedKeys = expectedSourceKeys(),
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS,
}) {
  const projectId = credentials?.project_id;
  if (!credentials?.client_email || !credentials?.private_key || !projectId) {
    throw new FunctionRunError('FIREBASE_SERVICE_ACCOUNT_JSON is missing or is not a service account JSON');
  }
  const token = await getAccessToken(credentials, CLOUD_SCOPE);
  if (!token) throw new FunctionRunError('service account token exchange returned no token');
  mask(token);

  const job = selectRefreshJob(await listSchedulerJobs(fetchImpl, token, projectId));
  log(`Cloud Scheduler job: ${job.name} (schedule "${job.schedule || '?'}" ${job.timeZone || ''}, state ${job.state || '?'}, last attempt ${job.lastAttemptTime || 'never'})`);

  if (dryRun) {
    // Solo lettura: nessun trigger, e il relay mostra il giro più recente.
    const rows = sourceRows(await readRelay(fetchImpl, relayUrl, now()), expectedKeys);
    log(`Dry run: job not triggered. Current relay state of the ${expectedKeys.length} active sources:`);
    log(renderTable(rows));
    summary(`### refreshPlateAuctions (dry run)\n\nJob \`${job.name}\` not triggered.\n\n${renderMarkdownTable(rows)}\n`);
    return { dryRun: true, job: job.name, rows };
  }

  // Il limite inferiore è il più basso fra l'orologio locale prima della
  // chiamata e l'header Date di Google (troncato al secondo): uno scarto fra i
  // due orologi non deve far scartare il giro appena lanciato.
  const requestedAt = now();
  const { date } = await googleJson(fetchImpl, `${SCHEDULER}/${job.name}:run`, { token, method: 'POST', body: {}, permission: 'run' });
  const serverMs = Date.parse(date || '');
  const triggeredAt = Number.isFinite(serverMs) ? Math.min(requestedAt, serverMs) : requestedAt;
  log(`Triggered ${job.name} at ${new Date(triggeredAt).toISOString()}; polling ${relayUrl} every ${pollIntervalMs / 1000}s for up to ${pollTimeoutMs / 60_000} min`);

  const deadline = triggeredAt + pollTimeoutMs;
  let rows = null;
  let stale = expectedKeys;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    try {
      rows = sourceRows(await readRelay(fetchImpl, relayUrl, now()), expectedKeys, triggeredAt);
    } catch (error) {
      // Un errore di lettura del relay non è un esito: si riprova al giro dopo.
      log(`Relay read failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    stale = rows.filter((row) => !row.refreshed).map((row) => row.key);
    log(`Poll: ${expectedKeys.length - stale.length}/${expectedKeys.length} active sources refreshed${stale.length ? ` (waiting for ${stale.join(', ')})` : ''}`);
    if (stale.length === 0) break;
  }
  if (rows) {
    log(renderTable(rows));
    summary(`### refreshPlateAuctions run\n\nJob \`${job.name}\` triggered at ${new Date(triggeredAt).toISOString()}.\n\n${renderMarkdownTable(rows)}\n`);
  }
  if (stale.length > 0) {
    throw new FunctionRunError(`after ${pollTimeoutMs / 60_000} min these active sources still have no lastFetchedAt from this run: ${stale.join(', ')}`);
  }
  // Raggiunte ma non riuscite: il giro le ha registrate senza un successo
  // (degraded, zero_rows, source_disappeared, ...). Il run non è verde.
  const failed = rows.filter((row) => !row.succeeded);
  if (failed.length > 0) {
    const detail = failed.map((row) => `${row.key} ${row.status}${row.lastError !== '-' ? ` (${row.lastError})` : ''}`).join(', ');
    throw new FunctionRunError(`these active sources were reached by this run but have no successful snapshot from it: ${detail}`);
  }
  return { dryRun: false, job: job.name, triggeredAt: new Date(triggeredAt).toISOString(), rows };
}

async function main() {
  let credentials = null;
  try { credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ''); } catch { credentials = null; }
  const dryRun = process.argv.includes('--dry-run') || process.env.PLATE_AUCTIONS_FUNCTION_RUN_DRY_RUN !== 'false';
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  try {
    const result = await runPlateAuctionsFunction({
      credentials,
      dryRun,
      summary: summaryPath ? (markdown) => appendFileSync(summaryPath, `${markdown}\n`) : () => {},
    });
    console.log(`Result: ${result.dryRun ? 'dry run' : 'run'} of ${result.job}`);
  } catch (error) {
    const message = String(error?.message || error).replaceAll(credentials?.private_key || '\u0000', '[redacted]');
    console.log(`::error::refreshPlateAuctions run failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
