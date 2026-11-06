/**
 * Shared Firebase Remote Config admin-write plumbing for the scripts/set-*-rc.mjs
 * one-shot family (+ seo-serp-autopilot.mjs). Centralizes admin init, template
 * fetch, per-key stage-if-changed, and publish so a fix to any of those lands
 * everywhere at once instead of drifting across copy-pasted siblings.
 *
 * updateRcTemplateWithEtag() (setRcParamWithEtag() for one parameter) is the
 * dependency-free sibling for jobs that run without `npm ci`
 * (codex-auth-rotate.yml): REST + service-account JWT, the same path as
 * load-rc-env.mjs's fetchTemplateViaRest.
 */
import { getServiceAccountAccessToken } from './google-service-account-token.mjs';

export const RC_SCOPE = 'https://www.googleapis.com/auth/firebase.remoteconfig';
const RC_API = 'https://firebaseremoteconfig.googleapis.com/v1';
const RC_REQUEST_TIMEOUT_MS = 30_000;

export async function getRemoteConfig() {
  const { applicationDefault, getApps, initializeApp } = await import('firebase-admin/app');
  const { getRemoteConfig: getAdminRemoteConfig } = await import('firebase-admin/remote-config');
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault() });
  }
  return getAdminRemoteConfig();
}

export async function fetchRcTemplate(rc) {
  const template = await rc.getTemplate();
  template.parameters = template.parameters || {};
  return template;
}

/**
 * Stages `key` = `value` in `template` if it differs from the current
 * defaultValue. Returns true if staged (change pending publish), false if
 * already up-to-date.
 */
export function stageRcParam(template, key, value, description) {
  const existing = template.parameters[key]?.defaultValue?.value;
  if (existing === value) return false;
  template.parameters[key] = {
    defaultValue: { value },
    valueType: 'STRING',
    description,
  };
  return true;
}

export async function publishRcTemplate(rc, template, changedCount) {
  if (changedCount === 0) return false;
  await rc.publishTemplate(template, { force: true });
  return true;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const retryableStatus = (status) => status === 429 || status >= 500;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `template.parameters[name]` = `value` in a copy of the template. Only
 * top-level parameters: that is all functions/src/remoteConfigSecrets.js reads,
 * so a copy inside a parameter group would be invisible to the functions.
 * @returns {{changed: boolean, template?: object, error?: string}}
 */
export function stageRcParamValue(template, name, value, description) {
  for (const [group, def] of Object.entries(template?.parameterGroups ?? {})) {
    if (isPlainObject(def?.parameters) && name in def.parameters) {
      return { changed: false, error: `${name} sits in parameter group ${JSON.stringify(group.slice(0, 60))}; it must be a top-level parameter` };
    }
  }
  const parameters = isPlainObject(template?.parameters) ? { ...template.parameters } : {};
  const existing = isPlainObject(parameters[name]) ? parameters[name] : null;
  if (existing?.defaultValue?.value === value) return { changed: false, template };
  parameters[name] = {
    ...(existing ?? {}),
    defaultValue: { value },
    valueType: existing?.valueType ?? 'STRING',
    description: existing?.description ?? description,
  };
  return { changed: true, template: { ...template, parameters } };
}

async function rcErrorDetail(response) {
  try {
    const error = (await response.json())?.error;
    return [error?.status, error?.message].filter((part) => typeof part === 'string').join(': ');
  } catch {
    return '';
  }
}

/**
 * Publishes a change of the Remote Config template with optimistic concurrency:
 * GET returns the template with its ETag, PUT sends `If-Match: <etag>`
 * (https://firebase.google.com/docs/remote-config/use-config-rest#etag_usage_and_forced_updates).
 * A template changed by someone else in between is rejected (409/412) instead
 * of being overwritten: the loop re-reads and re-applies on top of it. 429/5xx
 * and network errors are retried the same way; the re-read also tells whether
 * an ambiguous PUT went through (nothing left to change → done). Never `If-Match: *`.
 *
 * `stage(template)` gets the template just read and returns what
 * stageRcParamValue returns ({changed, template, error}); it runs once per
 * attempt. One publish carries everything it staged. `attempts: 1` turns a
 * conflict into a failure instead of a re-apply.
 *
 * `dryRun` reads and compares only: no PUT. `validateOnly` sends the same PUT
 * (body and If-Match) to `?validate_only=true`, the REST form of the Admin
 * SDK's validateTemplate: Remote Config checks the staged template and writes
 * nothing, so a template it would refuse fails here and not at the publish
 * (`validated` in the result). Nothing here logs a value; `detail`
 * carries only HTTP statuses and Google error statuses/messages. Throws only
 * when the service-account token exchange itself fails.
 *
 * @param {{credentials: {client_email:string, private_key:string, project_id:string},
 *   stage: (template: object) => {changed: boolean, template?: object, error?: string},
 *   versionDescription?: string, dryRun?: boolean, validateOnly?: boolean, attempts?: number, retryDelayMs?: number,
 *   fetchImpl?: typeof fetch, getAccessToken?: Function, sleep?: Function, onAccessToken?: Function}} options
 * @returns {Promise<{ok: boolean, changed?: boolean, dryRun?: boolean, validated?: boolean, attempt: number, detail?: string}>}
 */
export async function updateRcTemplateWithEtag({
  credentials, stage, versionDescription = '', dryRun = false, validateOnly = false,
  attempts = 4, retryDelayMs = 2_000, fetchImpl = fetch, getAccessToken = getServiceAccountAccessToken,
  sleep = defaultSleep, onAccessToken = () => {},
}) {
  const projectId = credentials?.project_id;
  if (typeof projectId !== 'string' || !projectId) return { ok: false, attempt: 0, detail: 'service account JSON has no project_id' };
  const accessToken = await getAccessToken(credentials, RC_SCOPE);
  onAccessToken(accessToken);
  const url = `${RC_API}/projects/${encodeURIComponent(projectId)}/remoteConfig`;
  // Without Accept-Encoding: gzip the GET may omit the ETag (REST doc note linked above).
  const headers = { Authorization: `Bearer ${accessToken}`, 'Accept-Encoding': 'gzip' };
  let detail = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(retryDelayMs * (attempt - 1));
    try {
      const got = await fetchImpl(url, { headers, signal: AbortSignal.timeout(RC_REQUEST_TIMEOUT_MS) });
      if (!got.ok) {
        detail = `GET remoteConfig → HTTP ${got.status}`;
        if (retryableStatus(got.status)) continue;
        return { ok: false, attempt, detail };
      }
      const etag = got.headers.get('etag');
      const template = await got.json();
      if (!etag) return { ok: false, attempt, detail: 'GET remoteConfig returned no ETag' };
      const staged = stage(template);
      if (staged.error) return { ok: false, attempt, detail: staged.error };
      if (!staged.changed) return { ok: true, changed: false, attempt };
      if (dryRun) return { ok: true, changed: true, dryRun: true, attempt };
      const put = await fetchImpl(validateOnly ? `${url}?validate_only=true` : url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json; UTF-8', 'If-Match': etag },
        body: JSON.stringify({
          conditions: staged.template.conditions,
          parameters: staged.template.parameters,
          parameterGroups: staged.template.parameterGroups,
          version: { description: versionDescription.slice(0, 256) },
        }),
        signal: AbortSignal.timeout(RC_REQUEST_TIMEOUT_MS),
      });
      if (put.ok) return validateOnly ? { ok: true, changed: true, validated: true, attempt } : { ok: true, changed: true, attempt };
      const why = await rcErrorDetail(put);
      detail = `PUT remoteConfig${validateOnly ? '?validate_only=true' : ''} → HTTP ${put.status}${why ? ` (${why.slice(0, 200)})` : ''}`;
      if (put.status === 409 || put.status === 412 || retryableStatus(put.status)) continue;
      return { ok: false, attempt, detail };
    } catch (error) {
      detail = `remoteConfig request failed: ${String(error?.message ?? error).slice(0, 200)}`;
    }
  }
  return { ok: false, attempt: attempts, detail };
}

/**
 * updateRcTemplateWithEtag for one top-level parameter (stageRcParamValue).
 *
 * @param {{credentials: {client_email:string, private_key:string, project_id:string}, name: string, value: string,
 *   description?: string, versionDescription?: string, dryRun?: boolean, attempts?: number, retryDelayMs?: number,
 *   fetchImpl?: typeof fetch, getAccessToken?: Function, sleep?: Function, onAccessToken?: Function}} options
 * @returns {Promise<{ok: boolean, changed?: boolean, dryRun?: boolean, attempt: number, detail?: string}>}
 */
export async function setRcParamWithEtag({ name, value, description = '', versionDescription = `set ${name}`, ...options }) {
  return updateRcTemplateWithEtag({
    ...options,
    versionDescription,
    stage: (template) => stageRcParamValue(template, name, value, description),
  });
}
