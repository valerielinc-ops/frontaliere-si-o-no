import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directRules, matchBlock } from './helpers/firestoreRulesBlock';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const uploadSource = readFileSync(resolve(repoRoot, 'components/community/AssistedApplicationUpload.tsx'), 'utf8');
const firestoreRules = readFileSync(resolve(repoRoot, 'firestore.rules'), 'utf8');
const storageRules = readFileSync(resolve(repoRoot, 'storage.rules'), 'utf8');

describe('assisted application post-payment upload', () => {
  it('keeps the browser flow consent-first and never requests a download URL', () => {
    expect(uploadSource).toContain("useState(false)");
    expect(uploadSource).toContain("paymentStatus !== 'paid'");
    expect(uploadSource).toContain("consentVersion: ASSISTED_APPLICATION_CONSENT_VERSION");
    expect(uploadSource).toContain("trackAssistedApplicationEvent('consent_confirmed'");
    expect(uploadSource).toContain("trackAssistedApplicationEvent('cv_upload_started'");
    expect(uploadSource).toContain("submissionStatus: 'ready_for_manual_submission'");
    expect(uploadSource).toContain('submittedAt:');
    expect(uploadSource).toContain('uploadBytes(');
    expect(uploadSource).toContain('assisted-application-uploads/${orderId}/');
    expect(uploadSource).not.toContain('getDownloadURL');
    expect(uploadSource).toContain('MAX_PAYMENT_POLL_INTERVAL_MS');
    expect(uploadSource).toContain('Math.min(pollDelayMs * 2, MAX_PAYMENT_POLL_INTERVAL_MS)');
    expect(uploadSource).not.toContain('MAX_PAYMENT_POLLS');
    expect(uploadSource).toContain('consentPersisted');
    expect(uploadSource).toContain('disabled={consentPersisted || consentSaving || uploading || submitBusy}');
    expect(uploadSource).toContain('cvUploadedAt: firestoreModule.serverTimestamp()');
    expect(uploadSource).toContain('await updateOrder({');
    expect(uploadSource).toContain('disabled={!consent || Boolean(cvStorageKey)');
  });

  it('allows only the server to create/pay an order and freezes payment identity for clients', () => {
    const block = directRules(matchBlock(firestoreRules, 'match /assisted_applications/{orderId}'));

    expect(block).toContain('allow get:');
    expect(block).toContain('allow list: if false;');
    expect(block).toContain('allow create: if false;');
    expect(block).toContain("resource.data.paymentStatus == 'paid'");
    expect(block).toContain('request.resource.data.paymentStatus == resource.data.paymentStatus');
    expect(block).toContain("'consentVersion', 'consentedAt'");
    expect(block).toContain("'submittedAt'");
    expect(block).toContain("'cvUploadedAt'");
    expect(block).toContain('request.resource.data.cvUploadedAt is timestamp');
    expect(block).toContain('request.resource.data.cvStorageKey == resource.data.cvStorageKey');
    expect(block).toContain("request.resource.data.consentVersion == 'assisted-application-v1'");
    expect(block).toContain('allow delete: if false;');
  });

  it('gates Storage creation on the owner, paid state and timestamped mandate, with reads denied', () => {
    const block = directRules(matchBlock(storageRules, 'match /assisted-application-uploads/{orderId}/{file}'));

    expect(block).toContain('request.auth != null');
    expect(block).toContain(".data.paymentStatus == 'paid'");
    expect(block).toContain(".data.consentVersion == 'assisted-application-v1'");
    expect(block).toContain('.data.consentedAt is timestamp');
    expect(block).toContain('allow read: if false;');
    expect(block).toContain('allow update, delete: if false;');
    expect(block).toContain('request.resource.contentType.matches');
  });
});
