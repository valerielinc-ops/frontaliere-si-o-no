import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

// #6378 (phase 4 of #5928): both subscriber roots split `create` (unchanged,
// still anonymous) from `update`, which is gated by `consentFieldsTouched()` —
// a write may only change `consent_*` on an existing document if it comes from
// a session whose email matches the document id. These tests exercise that
// guard against an emulator, not an assumption: forging consent is rejected,
// the mixed-case owner lookup remains case-insensitive, and the regression-net
// case proves the still-legitimate non-consent write path keeps working.
const SUBSCRIBER_EMAIL = 'existing-subscriber@example.com';
const ALERT_EMAIL = 'existing-alert-subscriber@example.com';
const MIXED_CASE_EMAIL = 'Legacy.Owner@Example.com';
const EXISTING_DOC = {
  email: SUBSCRIBER_EMAIL,
  consent_text: 'testo di consenso originale',
  consent_ip: '203.0.113.9',
  consent_given: true,
  name: 'Original Name',
};

describe('firestore.rules — newsletter_subscribers consent field guard', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'frontaliereticino-rules-test',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: '127.0.0.1',
        port: 8080,
      },
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'newsletter_subscribers', SUBSCRIBER_EMAIL),
        EXISTING_DOC,
      );
      await setDoc(
        doc(context.firestore(), 'job_alert_subscribers', ALERT_EMAIL),
        { ...EXISTING_DOC, email: ALERT_EMAIL },
      );
      await setDoc(
        doc(context.firestore(), 'newsletter_subscribers', MIXED_CASE_EMAIL),
        { ...EXISTING_DOC, email: MIXED_CASE_EMAIL },
      );
      await setDoc(
        doc(context.firestore(), 'job_alert_subscribers', MIXED_CASE_EMAIL),
        { ...EXISTING_DOC, email: MIXED_CASE_EMAIL },
      );
    });
  });

  it('an unauthenticated client can no longer overwrite consent_text on an existing doc', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(
        doc(unauthed.firestore(), 'newsletter_subscribers', SUBSCRIBER_EMAIL),
        { ...EXISTING_DOC, consent_text: 'forged by anonymous client' },
      ),
    );
  });

  it('regression net: an unauthenticated client can still write a non-consent field (name) without breaking', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertSucceeds(
      setDoc(
        doc(unauthed.firestore(), 'newsletter_subscribers', SUBSCRIBER_EMAIL),
        { ...EXISTING_DOC, name: 'Updated Name' },
        { merge: true },
      ),
    );
  });

  it('an authenticated client with a mismatched email can no longer overwrite consent_text', async () => {
    const mismatched = testEnv.authenticatedContext('some-uid', {
      email: 'someone-else@example.com',
      email_verified: true,
    });
    await assertFails(
      setDoc(
        doc(mismatched.firestore(), 'newsletter_subscribers', SUBSCRIBER_EMAIL),
        { ...EXISTING_DOC, consent_text: 'forged by mismatched identity' },
        { merge: true },
      ),
    );
  });

  it.each(['newsletter_subscribers', 'job_alert_subscribers'])
    ('an authenticated client without an email claim cannot overwrite consent_text on %s', async (collection) => {
      const noEmailClaim = testEnv.authenticatedContext('uid-without-email-claim');
      await assertFails(
        setDoc(
          doc(noEmailClaim.firestore(), collection, collection === 'newsletter_subscribers' ? SUBSCRIBER_EMAIL : ALERT_EMAIL),
          { consent_text: 'forged without an email claim' },
          { merge: true },
        ),
      );
    });

  it('an authenticated client whose own email matches the doc id can still update its own consent_text', async () => {
    const owner = testEnv.authenticatedContext('owner-uid', {
      email: SUBSCRIBER_EMAIL,
      email_verified: true,
    });
    await assertSucceeds(
      setDoc(
        doc(owner.firestore(), 'newsletter_subscribers', SUBSCRIBER_EMAIL),
        { ...EXISTING_DOC, consent_text: 're-consented by the subscriber themselves' },
        { merge: true },
      ),
    );
  });

  it('an unauthenticated client can no longer overwrite consent_text on a job-alert subscriber doc', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(
        doc(unauthed.firestore(), 'job_alert_subscribers', ALERT_EMAIL),
        { ...EXISTING_DOC, email: ALERT_EMAIL, consent_text: 'forged by anonymous client' },
        { merge: true },
      ),
    );
  });

  it('an unauthenticated client can still update a non-consent field on a job-alert subscriber doc', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertSucceeds(
      setDoc(
        doc(unauthed.firestore(), 'job_alert_subscribers', ALERT_EMAIL),
        { name: 'Updated Name' },
        { merge: true },
      ),
    );
  });

  it.each(['newsletter_subscribers', 'job_alert_subscribers'])
    ('an owner can update consent on a mixed-case %s doc-id', async (collection) => {
      const owner = testEnv.authenticatedContext('owner-uid', {
        email: MIXED_CASE_EMAIL.toLowerCase(),
        email_verified: true,
      });
      await assertSucceeds(
        setDoc(
          doc(owner.firestore(), collection, MIXED_CASE_EMAIL),
          { consent_text: 'updated by the legacy-id owner' },
          { merge: true },
        ),
      );
    });
});

// Sanity check kept alongside the RED cases so this file self-documents that
// `assertFails` is exercised too, not only the forged writes above: a write to
// an unrelated rules-denied path still fails, proving the emulator wiring is
// active rather than making every assertion vacuously pass.
describe('firestore.rules — sanity (assertFails wiring)', () => {
  it('a write to a rules-denied path still fails as expected', async () => {
    const testEnv = await initializeTestEnvironment({
      projectId: 'frontaliereticino-rules-test-sanity',
      firestore: {
        rules: 'rules_version = \'2\'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }',
        host: '127.0.0.1',
        port: 8080,
      },
    });
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(doc(unauthed.firestore(), 'locked_down/doc'), { anything: true }),
    );
    await testEnv.cleanup();
  });
});
