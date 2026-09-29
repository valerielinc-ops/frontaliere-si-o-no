#!/usr/bin/env node
/**
 * Guard for `firebase deploy --only storage` in CI.
 *
 * Storage rules that call `firestore.get()` / `firestore.exists()` only work
 * when the Cloud Storage for Firebase service agent holds
 * `roles/firebaserules.firestoreServiceAgent`. firebase-tools grants it only
 * interactively: in a non-interactive run
 * (`RulesDeploy.checkStorageRulesIamPermissions`) it returns before even
 * checking, so a CI deploy ships cross-service rules that deny every request.
 * That is how the paid assisted-application CV upload failed with 403 on every
 * attempt from its launch (2026-09-15) until the role was granted by hand on
 * 2026-09-29.
 *
 * Exit codes: 0 = no cross-service call, or role present; 1 = role missing OR
 * the IAM policy could not be read. Failing closed on a read error is
 * deliberate: a deploy that cannot prove the role exists would recreate the
 * silent 403 on every upload while the gate looks green. The rules-deploy
 * service account (Editor) can read the project IAM policy.
 *
 *   node scripts/ci/check-storage-cross-service-role.mjs [--project <id>] [--rules storage.rules]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CROSS_SERVICE_RULES_ROLE = 'roles/firebaserules.firestoreServiceAgent';
const CROSS_SERVICE_CALL_RX = /firestore\.(get|exists)\s*\(/;

/** @param {string} rulesSource */
export function storageRulesUseCrossService(rulesSource) {
  const withoutComments = String(rulesSource || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return CROSS_SERVICE_CALL_RX.test(withoutComments);
}

export function storageServiceAgent(projectNumber) {
  return `serviceAccount:service-${projectNumber}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
}

/** @param {{bindings?: Array<{role:string, members?:string[], condition?:unknown}>}} policy */
export function policyGrantsRole(policy, member, role = CROSS_SERVICE_RULES_ROLE) {
  return (policy?.bindings || []).some((binding) => (
    binding.role === role && !binding.condition && (binding.members || []).includes(member)
  ));
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function accessToken() {
  const { applicationDefault } = await import('firebase-admin/app');
  const token = await applicationDefault().getAccessToken();
  return token.access_token;
}

async function getJson(url, token, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data?.error?.status || ''} ${data?.error?.message || ''}`.trim());
  return data;
}

async function loadPolicyFromGoogle(project) {
  const token = await accessToken();
  const projectInfo = await getJson(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, token);
  const policy = await getJson(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
    token,
    { options: { requestedPolicyVersion: 3 } },
  );
  return { member: storageServiceAgent(projectInfo.projectNumber), policy };
}

/**
 * Decide the exit code. `loadPolicy(project)` resolves `{ member, policy }`;
 * any error it throws fails the check (see the header for why).
 * @returns {Promise<{ code: 0|1, message: string }>}
 */
export async function checkStorageCrossServiceRole({ rulesSource, project, loadPolicy = loadPolicyFromGoogle }) {
  if (!storageRulesUseCrossService(rulesSource)) {
    return { code: 0, message: '✅ storage.rules has no firestore.get()/exists(): no IAM role needed.' };
  }
  let loaded;
  try {
    loaded = await loadPolicy(project);
  } catch (error) {
    return {
      code: 1,
      message: `::error::Cannot read the IAM policy of ${project} (${error instanceof Error ? error.message : String(error)}): `
        + `refusing to deploy cross-service Storage rules without proof that the Storage service agent holds ${CROSS_SERVICE_RULES_ROLE}.`,
    };
  }
  if (policyGrantsRole(loaded.policy, loaded.member)) {
    return { code: 0, message: `✅ Storage service agent holds ${CROSS_SERVICE_RULES_ROLE}.` };
  }
  return {
    code: 1,
    message: `::error::storage.rules calls firestore.get()/exists() but ${String(loaded.member).replace(/\d{6,}/, '<project-number>')} `
      + `lacks ${CROSS_SERVICE_RULES_ROLE}: every such rule would deny. firebase-tools does not grant it in CI; `
      + 'grant it once (IAM → add role to the Storage service agent) and re-run.',
  };
}

async function main() {
  const project = argValue('--project', 'frontaliere-ticino');
  const rulesPath = resolve(argValue('--rules', 'storage.rules'));
  const { code, message } = await checkStorageCrossServiceRole({
    rulesSource: readFileSync(rulesPath, 'utf8'),
    project,
  });
  console.log(message);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
