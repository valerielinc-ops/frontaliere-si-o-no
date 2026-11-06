import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CROSS_SERVICE_RULES_ROLE,
  checkStorageCrossServiceRole,
  policyGrantsRole,
  storageRulesUseCrossService,
  storageServiceAgent,
} from '../scripts/ci/check-storage-cross-service-role.mjs';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/deploy-firestore-rules.yml'), 'utf8');
const storageRules = readFileSync(resolve(process.cwd(), 'storage.rules'), 'utf8');

describe('Storage cross-service rules guard', () => {
  it('detects firestore.get()/exists() calls but not mentions in comments', () => {
    expect(storageRulesUseCrossService(storageRules)).toBe(true);
    expect(storageRulesUseCrossService('allow read: if firestore.exists(/databases/x);')).toBe(true);
    expect(storageRulesUseCrossService('// firestore.get(...) is not used here\nallow read: if false;')).toBe(false);
  });

  it('requires an unconditional binding of the role to the Storage service agent', () => {
    const member = storageServiceAgent('123456789');
    expect(member).toBe('serviceAccount:service-123456789@gcp-sa-firebasestorage.iam.gserviceaccount.com');
    expect(policyGrantsRole({ bindings: [{ role: CROSS_SERVICE_RULES_ROLE, members: [member] }] }, member)).toBe(true);
    expect(policyGrantsRole({ bindings: [{ role: 'roles/firebasestorage.serviceAgent', members: [member] }] }, member)).toBe(false);
    expect(policyGrantsRole({
      bindings: [{ role: CROSS_SERVICE_RULES_ROLE, members: [member], condition: { expression: 'false' } }],
    }, member)).toBe(false);
  });

  it('fails closed when the IAM policy cannot be read, and passes only with the role', async () => {
    const member = storageServiceAgent('42');
    const unreadable = await checkStorageCrossServiceRole({
      rulesSource: storageRules,
      project: 'p',
      loadPolicy: async () => { throw new Error('403 PERMISSION_DENIED'); },
    });
    expect(unreadable.code).toBe(1);
    expect(unreadable.message).toContain('::error::Cannot read the IAM policy');

    const missing = await checkStorageCrossServiceRole({
      rulesSource: storageRules, project: 'p', loadPolicy: async () => ({ member, policy: { bindings: [] } }),
    });
    expect(missing.code).toBe(1);

    const granted = await checkStorageCrossServiceRole({
      rulesSource: storageRules,
      project: 'p',
      loadPolicy: async () => ({ member, policy: { bindings: [{ role: CROSS_SERVICE_RULES_ROLE, members: [member] }] } }),
    });
    expect(granted.code).toBe(0);

    const noCrossService = await checkStorageCrossServiceRole({
      rulesSource: 'allow read: if false;', project: 'p', loadPolicy: async () => { throw new Error('never called'); },
    });
    expect(noCrossService.code).toBe(0);
  });

  it('ships storage.rules from CI, behind the IAM guard', () => {
    expect(workflow).toContain("- 'storage.rules'");
    const guard = workflow.indexOf('node scripts/ci/check-storage-cross-service-role.mjs');
    const deploy = workflow.indexOf('firebase deploy --only storage --project frontaliere-ticino');
    expect(guard).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(guard);
  });
});
