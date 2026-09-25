#!/usr/bin/env node
/**
 * Crea (o riallinea) la chiave API usata per PageSpeed Insights e Chrome UX
 * Report e la scrive in Remote Config come `PAGESPEED_API_KEY`.
 *
 * Perché: dal 2026-09-11 la chiave in Remote Config risponde 403 «Requests to
 * this API … are blocked» su entrambe le API (restrizioni della chiave che non
 * le includono più), e PSI senza chiave ha quota 0 (429). I tre consumatori —
 * cwv-field-criterion.yml, post-deploy-validate-live.yml (gate CLS) e
 * analytics.yml — restavano verdi senza misurare niente.
 *
 * Cosa fa, con il service account di FIREBASE_SERVICE_ACCOUNT_JSON:
 *   1. abilita pagespeedonline, chromeuxreport e apikeys nel progetto;
 *   2. riusa una chiave `frontaliere-pagespeed-crux*` già ristretta esattamente
 *      a quelle due API; altrimenti ne crea una NUOVA con suffisso data. Una
 *      chiave esistente non viene mai modificata: potrebbe essere quella che
 *      Remote Config usa già, e una modifica seguita da una verifica fallita
 *      la lascerebbe alterata sotto i consumatori;
 *   3. la verifica con una chiamata vera a ogni endpoint usato dai
 *      consumatori (PSI runPagespeed, CrUX queryRecord e queryHistoryRecord),
 *      riprovando mentre la chiave nuova si propaga;
 *   4. SOLO se la verifica passa, la scrive in Remote Config (ETag).
 * Nessuna chiave viene modificata o cancellata: quelle vecchie possono servire ad altro.
 *
 * Il valore della chiave non viene mai stampato: `::add-mask::` appena letto.
 * Serve che il service account abbia `roles/serviceusage.apiKeysAdmin` e
 * `roles/serviceusage.serviceUsageAdmin`; senza, lo script si ferma dicendolo.
 *
 * Uso: FIREBASE_SERVICE_ACCOUNT_JSON=… node scripts/ci/provision-pagespeed-key.mjs [--dry-run]
 */
import { pathToFileURL } from 'node:url';
import { googleApiJson } from '../lib/google-api-json.mjs';
import { getServiceAccountAccessToken } from '../lib/google-service-account-token.mjs';
import { setRcParamWithEtag } from '../lib/remote-config-admin.mjs';

export const KEY_ID = 'frontaliere-pagespeed-crux';
/** Id di una chiave nuova: stesso prefisso, suffisso UTC al minuto (regex keyId di API Keys v2). */
export function newKeyId(now) {
  return `${KEY_ID}-${now.toISOString().slice(0, 16).replace(/[-:T]/gu, '')}`;
}
export const KEY_SERVICES = Object.freeze(['pagespeedonline.googleapis.com', 'chromeuxreport.googleapis.com']);
const REQUIRED_SERVICES = Object.freeze([...KEY_SERVICES, 'apikeys.googleapis.com']);
const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const APIKEYS = 'https://apikeys.googleapis.com/v2';
const SERVICEUSAGE = 'https://serviceusage.googleapis.com/v1';
const SITE_ORIGIN = 'https://frontaliereticino.ch';
const RC_PARAM = 'PAGESPEED_API_KEY';
const MISSING_ROLES_HINT = 'grant the service account roles/serviceusage.apiKeysAdmin and roles/serviceusage.serviceUsageAdmin in Google Cloud IAM, then re-run';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ProvisionError extends Error {}

/** Restrizioni volute: solo le due API, nessuna restrizione di client (gli IP dei runner cambiano). */
export function desiredRestrictions() {
  return { apiTargets: KEY_SERVICES.map((service) => ({ service })) };
}

/**
 * true se la chiave consente esattamente le due API, su tutti i loro metodi, e
 * nessun client è ristretto. Un target con `methods` limita la chiave ad alcuni
 * endpoint (es. solo queryRecord e non queryHistoryRecord): non basta.
 */
export function restrictionsMatch(restrictions) {
  const apiTargets = restrictions?.apiTargets || [];
  if (apiTargets.some((target) => Array.isArray(target?.methods) && target.methods.length > 0)) return false;
  const targets = apiTargets.map((target) => target?.service).filter(Boolean).sort();
  const clientRestricted = ['browserKeyRestrictions', 'serverKeyRestrictions', 'androidKeyRestrictions', 'iosKeyRestrictions']
    .some((field) => restrictions?.[field]);
  return !clientRestricted && JSON.stringify(targets) === JSON.stringify([...KEY_SERVICES].sort());
}

async function googleJson(fetchImpl, url, { token, method = 'GET', body } = {}) {
  const { json } = await googleApiJson(fetchImpl, url, { token, method, body, forbiddenHint: MISSING_ROLES_HINT, ErrorClass: ProvisionError });
  return json;
}

async function waitOperation(fetchImpl, base, operation, token, { sleep, attempts = 30, delayMs = 2_000 }) {
  let current = operation;
  for (let attempt = 0; !current?.done; attempt += 1) {
    if (attempt >= attempts) throw new ProvisionError(`operation ${current?.name} did not complete in time`);
    await sleep(delayMs);
    current = await googleJson(fetchImpl, `${base}/${current.name}`, { token });
  }
  if (current.error) throw new ProvisionError(`operation ${current.name} failed: ${current.error.message || JSON.stringify(current.error)}`);
  return current.response ?? {};
}

/**
 * Chiama con la chiave ogni endpoint dei consumatori: PSI runPagespeed
 * (audit-cls-live, analytics-report) e CrUX queryRecord + queryHistoryRecord
 * (check-cwv-field-criterion). `ok` solo quando tutti rispondono autorizzati.
 */
export async function probeKey(fetchImpl, keyString) {
  const key = encodeURIComponent(keyString);
  const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(`${SITE_ORIGIN}/`)}&strategy=mobile&category=performance&key=${key}`;
  const psi = await fetchImpl(psiUrl, { signal: AbortSignal.timeout(90_000) });
  const cruxCall = (method) => fetchImpl(`https://chromeuxreport.googleapis.com/v1/records:${method}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: SITE_ORIGIN }),
    signal: AbortSignal.timeout(30_000),
  });
  const crux = await cruxCall('queryRecord');
  const cruxHistory = await cruxCall('queryHistoryRecord');
  // CrUX risponde 404 NOT_FOUND quando l'origine non ha abbastanza dati: la
  // chiave è comunque autorizzata. 403/400 no.
  const authorized = (status) => status === 200 || status === 404;
  return {
    ok: psi.status === 200 && authorized(crux.status) && authorized(cruxHistory.status),
    psiStatus: psi.status,
    cruxStatus: crux.status,
    cruxHistoryStatus: cruxHistory.status,
  };
}

export async function provisionPagespeedKey({
  credentials,
  dryRun = false,
  fetchImpl = fetch,
  getAccessToken = getServiceAccountAccessToken,
  writeRemoteConfig = setRcParamWithEtag,
  sleep = defaultSleep,
  log = console.log,
  mask = (value) => console.log(`::add-mask::${value}`),
  probeAttempts = 6,
  probeDelayMs = 20_000,
  now = new Date(),
}) {
  const projectId = credentials?.project_id;
  if (!credentials?.client_email || !credentials?.private_key || !projectId) {
    throw new ProvisionError('FIREBASE_SERVICE_ACCOUNT_JSON is missing or is not a service account JSON');
  }
  const token = await getAccessToken(credentials, CLOUD_SCOPE);
  if (token) mask(token);
  const project = `projects/${encodeURIComponent(projectId)}`;

  const enabled = await googleJson(fetchImpl, `${SERVICEUSAGE}/${project}/services?filter=state:ENABLED&pageSize=200`, { token });
  const enabledNames = new Set((enabled.services || []).map((service) => service?.config?.name));
  const toEnable = REQUIRED_SERVICES.filter((service) => !enabledNames.has(service));
  log(`APIs to enable in ${projectId}: ${toEnable.length ? toEnable.join(', ') : 'none'}`);
  if (toEnable.length && !dryRun) {
    const operation = await googleJson(fetchImpl, `${SERVICEUSAGE}/${project}/services:batchEnable`, { token, method: 'POST', body: { serviceIds: toEnable } });
    await waitOperation(fetchImpl, SERVICEUSAGE, operation, token, { sleep });
  }

  const keysBase = `${APIKEYS}/${project}/locations/global/keys`;
  if (dryRun && toEnable.includes('apikeys.googleapis.com')) {
    // Con l'API Keys spenta non c'è niente da elencare: la run vera la accende.
    log('API Keys API is disabled: existing keys cannot be listed until the real run enables it');
    return { dryRun: true, created: true, servicesEnabled: toEnable };
  }
  const listed = await googleJson(fetchImpl, keysBase, { token });
  const ours = (listed.keys || []).filter((key) => {
    const id = String(key?.name || '').split('/').pop();
    return (id === KEY_ID || id.startsWith(`${KEY_ID}-`)) && !key?.deleteTime;
  });
  // Solo una chiave già conforme si riusa, la più recente. Una non conforme
  // resta com'è: potrebbe essere quella che Remote Config usa oggi.
  const reusable = ours
    .filter((key) => restrictionsMatch(key.restrictions))
    .sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')))[0];
  log(`Keys ${KEY_ID}*: ${ours.length} found, ${reusable ? 'reusing a conforming one' : 'creating a new one'}`);
  if (dryRun) return { dryRun: true, created: !reusable, servicesEnabled: toEnable };

  let keyName = reusable?.name;
  if (!reusable) {
    const keyId = newKeyId(now);
    const operation = await googleJson(fetchImpl, `${keysBase}?keyId=${keyId}`, {
      token,
      method: 'POST',
      body: { displayName: 'frontaliere PageSpeed + CrUX (CI)', restrictions: desiredRestrictions() },
    });
    const created = await waitOperation(fetchImpl, APIKEYS, operation, token, { sleep });
    keyName = created.name || `${project}/locations/global/keys/${keyId}`;
  }

  const { keyString } = await googleJson(fetchImpl, `${APIKEYS}/${keyName}/keyString`, { token });
  if (!keyString) throw new ProvisionError(`GET ${keyName}/keyString returned no key`);
  mask(keyString);

  // Una chiave nuova (o appena riallineata) impiega qualche minuto a valere.
  let probe = null;
  for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
    if (attempt > 1) await sleep(probeDelayMs);
    probe = await probeKey(fetchImpl, keyString);
    log(`Probe ${attempt}/${probeAttempts}: PSI HTTP ${probe.psiStatus}, CrUX queryRecord HTTP ${probe.cruxStatus}, queryHistoryRecord HTTP ${probe.cruxHistoryStatus}`);
    if (probe.ok) break;
  }
  if (!probe?.ok) {
    throw new ProvisionError(`the key does not authorize every consumer endpoint yet (PSI HTTP ${probe?.psiStatus}, CrUX queryRecord HTTP ${probe?.cruxStatus}, queryHistoryRecord HTTP ${probe?.cruxHistoryStatus}); Remote Config left unchanged`);
  }

  const written = await writeRemoteConfig({
    credentials,
    name: RC_PARAM,
    value: keyString,
    description: `Google API key restricted to PageSpeed Insights + Chrome UX Report (${keyName.split('/').pop()}). Written by pagespeed-api-key-provision.yml.`,
    versionDescription: `pagespeed-api-key-provision: ${RC_PARAM}`,
    onAccessToken: (rcToken) => { if (rcToken) mask(rcToken); },
  });
  if (!written.ok) throw new ProvisionError(`Remote Config write failed (attempt ${written.attempt}): ${written.detail || 'no detail'}`);
  log(`Remote Config ${RC_PARAM}: ${written.changed ? 'written' : 'already current'}`);
  return { dryRun: false, created: !reusable, keyId: keyName.split('/').pop(), servicesEnabled: toEnable, remoteConfig: written.changed ? 'written' : 'unchanged' };
}

async function main() {
  let credentials = null;
  try { credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ''); } catch { credentials = null; }
  const dryRun = process.argv.includes('--dry-run') || process.env.PAGESPEED_KEY_DRY_RUN === 'true';
  try {
    const result = await provisionPagespeedKey({ credentials, dryRun });
    console.log(`Result: ${JSON.stringify(result)}`);
  } catch (error) {
    const message = String(error?.message || error).replaceAll(credentials?.private_key || '\u0000', '[redacted]');
    console.log(`::error::PageSpeed key provisioning failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
