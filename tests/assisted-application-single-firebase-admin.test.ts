import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { functionsAdminModules } = await import('../scripts/assisted-application/lib/functions-admin.mjs');
const { getFirestoreDb } = await import('../scripts/lib/firestore-admin.mjs');
const { buildAssistedApplicationEvent } = await import('../functions/src/assistedApplicationAudit.js');
const { safeErrorInfo } = await import('../scripts/assisted-application/lib/portal/verify.mjs');

const DIR = path.resolve(__dirname, '../scripts/assisted-application');
const WRITERS = /applyAutomationEvent|buildAssistedApplicationEvent|recordOwnerSubmission|relaunchAuthorizedOwnerTakeover|settleFromApplicationExists|reconcileSubmissionReceipt|handleAutomationAdminAction|startAutomation/;

describe('one firebase-admin for a script and the functions code it hands its database to', () => {
  it('the FieldValue the functions modules build is of the instance the scripts\' helper creates the db from', () => {
    // The audit event of the functions code carries a serverTimestamp sentinel built by ITS firebase-admin. A db of
    // another instance rejects it: «Couldn't serialize object of type "ServerTimestampTransform"» (run 46146945250).
    const sentinel = buildAssistedApplicationEvent('automation_transition', { actor: 'test', eventType: 'owner_retry_submit' }).createdAt;
    const fromHelper = functionsAdminModules().firestore.FieldValue.serverTimestamp();
    expect(sentinel.constructor).toBe(fromHelper.constructor);
    expect(typeof functionsAdminModules().app.initializeApp).toBe('function');
  });

  it('every script that writes through functions modules creates its db with the functions helper, never with the root one', () => {
    const offenders: string[] = [];
    const checked: string[] = [];
    for (const name of readdirSync(DIR).filter((file) => file.endsWith('.mjs'))) {
      const source = readFileSync(path.join(DIR, name), 'utf8');
      if (!/getFirestoreDb\b|getFunctionsFirestoreDb\b/.test(source) || !WRITERS.test(source)) continue;
      checked.push(name);
      if (/\bawait getFirestoreDb\(|\bgetFirestoreDb\s*\}\s*from|import\s*\{\s*getFirestoreDb\b/.test(source) || !/getFunctionsFirestoreDb/.test(source)) offenders.push(name);
    }
    expect(checked).toEqual(expect.arrayContaining([
      'verify-portal.mjs', 'owner-takeover-relaunch-check.mjs', 'reconcile-final-review-ambiguous.mjs',
      'reconcile-inpage-confirmation.mjs', 'reconcile-owner-submitted-flows.mjs', 'reconcile-portal-code.mjs',
    ]));
    expect(offenders).toEqual([]);
  });

  it('getFirestoreDb takes the firebase-admin modules to read the database from, and keeps a cache of its own for them', () => {
    const source = readFileSync(path.resolve(__dirname, '../scripts/lib/firestore-admin.mjs'), 'utf8');
    expect(source).toMatch(/getFirestoreDb\(projectId = FIRESTORE_PROJECT_ID, \{ adminModules = null \} = \{\}\)/);
    expect(source).toMatch(/adminModules\?\.app \|\| await import\('firebase-admin\/app'\)/);
    expect(source).toMatch(/adminModules\?\.firestore \|\| await import\('firebase-admin\/firestore'\)/);
    expect(source).toMatch(/activeAdminModulesFirestoreDb/);
    expect(typeof getFirestoreDb).toBe('function');
  });

  it('names the failure of a db that rejects a foreign sentinel, as an identifier', () => {
    const error = new Error('Value for argument "data" is not a valid Firestore document. Couldn\'t serialize object of type "ServerTimestampTransform" (found in field "createdAt"). Firestore doesn\'t support JavaScript objects');
    expect(safeErrorInfo(error, 'settle')).toEqual({ stage: 'settle', name: 'Error', message: 'firestore_serialize' });
  });
});
