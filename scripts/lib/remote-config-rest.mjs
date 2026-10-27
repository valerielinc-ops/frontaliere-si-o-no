/**
 * Dependency-free Firebase Remote Config REST helpers.
 *
 * This module deliberately has no firebase-admin import so scheduled scripts
 * that run without npm install can still update a template with an ETag.
 */
import { getServiceAccountAccessToken } from './google-service-account-token.mjs';

export const RC_SCOPE = 'https://www.googleapis.com/auth/firebase.remoteconfig';
const RC_API = 'https://firebaseremoteconfig.googleapis.com/v1';
const RC_REQUEST_TIMEOUT_MS = 30_000;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const retryableStatus = (status) => status === 429 || status >= 500;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stages a top-level parameter in a copy of the template.
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
 * Publishes a staged template with optimistic concurrency. Conflicts, rate
 * limits, and transient server errors are retried by reading the latest
 * template and applying the stage function again.
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

export async function setRcParamWithEtag({ name, value, description = '', versionDescription = `set ${name}`, ...options }) {
  return updateRcTemplateWithEtag({
    ...options,
    versionDescription,
    stage: (template) => stageRcParamValue(template, name, value, description),
  });
}
