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
 * Exit codes: 0 = no cross-service call, or role present; 1 = role missing
 * (the deploy must not proceed silently broken). An IAM read that is itself
 * denied only warns: the guard must not wedge a rules deploy it cannot judge.
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

async function main() {
  const project = argValue('--project', 'frontaliere-ticino');
  const rulesPath = resolve(argValue('--rules', 'storage.rules'));
  if (!storageRulesUseCrossService(readFileSync(rulesPath, 'utf8'))) {
    console.log(`✅ ${rulesPath} has no firestore.get()/exists(): no IAM role needed.`);
    return 0;
  }

  let policy;
  let member;
  try {
    const token = await accessToken();
    const projectInfo = await getJson(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, token);
    member = storageServiceAgent(projectInfo.projectNumber);
    policy = await getJson(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
      token,
      { options: { requestedPolicyVersion: 3 } },
    );
  } catch (error) {
    console.log(`::warning::Cannot read the IAM policy of ${project} (${error.message}); `
      + `cross-service Storage rules need ${CROSS_SERVICE_RULES_ROLE} on the Storage service agent.`);
    return 0;
  }

  if (policyGrantsRole(policy, member)) {
    console.log(`✅ Storage service agent holds ${CROSS_SERVICE_RULES_ROLE}.`);
    return 0;
  }
  console.log(`::error::storage.rules calls firestore.get()/exists() but ${member.replace(/\d{6,}/, '<project-number>')} `
    + `lacks ${CROSS_SERVICE_RULES_ROLE}: every such rule would deny. firebase-tools does not grant it in CI; `
    + 'grant it once (IAM → add role to the Storage service agent) and re-run.');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
