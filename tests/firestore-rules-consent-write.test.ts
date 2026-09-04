import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

// #6378 (phase 4 of #5928): `newsletter_subscribers/{email}` now splits
// `create` (unchanged, still anonymous) from `update`, which is gated by
// `consentFieldsTouched()` — a write may only change `consent_*` on an
// existing document if it comes from a session whose email matches the
// document id. These tests exercise that guard against an emulator, not an
// assumption: the two cases below document that forging consent is now
// rejected, and the regression-net case proves the still-legitimate
// non-consent write path (name, preferences, engagement counters) keeps
// working unauthenticated.
const SUBSCRIBER_EMAIL = 'existing-subscriber@example.com';
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
});

// Sanity check kept alongside the RED cases so this file self-documents that
// `assertFails` is exercised too, not only the (currently succeeding) forged
// writes above: a delete from an unauthenticated client on a collection with
// `allow write: if true` also succeeds today, matching the same gap.
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
