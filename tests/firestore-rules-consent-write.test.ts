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

  it('an unauthenticated client cannot forge the server-owned DOI provenance', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(
        doc(unauthed.firestore(), 'newsletter_subscribers', SUBSCRIBER_EMAIL),
        { confirmed_via: 'confirmation_link' },
        { merge: true },
      ),
    );
  });

  it('an unauthenticated client cannot forge a DOI confirmation event', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(
        doc(unauthed.firestore(), 'newsletter_subscribers', SUBSCRIBER_EMAIL, 'events', 'forged-confirm'),
        { event_type: 'confirm', source_channel: 'confirmation_link' },
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

  it('an unauthenticated client can create only a visibly-consented pending record', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertSucceeds(
      setDoc(doc(unauthed.firestore(), 'newsletter_subscribers', 'pending-create@example.com'), {
        email: 'pending-create@example.com',
        status: 'pending',
        isActive: false,
        active: false,
        consent_text: 'comunicazioni newsletter',
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_method: 'email_submit',
      }),
    );
  });

  it('an unauthenticated client cannot create pending consent with an empty proof', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(doc(unauthed.firestore(), 'newsletter_subscribers', 'empty-proof@example.com'), {
        email: 'empty-proof@example.com',
        status: 'pending',
        isActive: false,
        active: false,
        consent_text: '',
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_method: 'email_submit',
      }),
    );
  });

  it('an unauthenticated client cannot create a confirmed record', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(doc(unauthed.firestore(), 'newsletter_subscribers', 'confirmed-create@example.com'), {
        email: 'confirmed-create@example.com',
        status: 'confirmed',
        isActive: true,
        active: true,
        confirmed_at: '2026-09-12T00:00:00.000Z',
        consent_text: 'comunicazioni newsletter',
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_method: 'email_submit',
      }),
    );
  });

  // Every create carries a consent basis. A verified owner used to be able to
  // create the record with auth-profile fields only (the authentication-only
  // write of #8341); since #8754 the sign-in runs the terms-based upsert first
  // and the profile merge is an update, so that branch only admitted records
  // with no basis.
  it('a verified owner cannot create a record holding profile fields only', async () => {
    const owner = testEnv.authenticatedContext('profile-only-uid', {
      email: 'profile-only@example.com',
      email_verified: true,
    });
    await assertFails(setDoc(doc(owner.firestore(), 'newsletter_subscribers', 'profile-only@example.com'), {
      auth_uid: 'profile-only-uid',
      auth_provider: 'google',
      name: 'Nome Cognome',
      lastLoginAt: '2026-09-25T00:00:00.000Z',
    }, { merge: true }));
  });

  it('the sign-in order still works: terms-based create, then the profile merge', async () => {
    const owner = testEnv.authenticatedContext('sign-in-uid', {
      email: 'sign-in@example.com',
      email_verified: true,
    });
    const ref = doc(owner.firestore(), 'newsletter_subscribers', 'sign-in@example.com');
    await assertSucceeds(setDoc(ref, {
      email: 'sign-in@example.com',
      status: 'confirmed',
      isActive: true,
      active: true,
      confirmed_at: '2026-09-25T00:00:00.000Z',
      registration_terms_accepted: true,
      consent_basis: 'registration_terms',
      consent_text: 'termini e condizioni',
      consent_text_displayed: true,
      consent_act: 'registration_terms_acceptance',
      consent_method: 'terms_and_conditions',
    }, { merge: true }));
    await assertSucceeds(setDoc(ref, {
      auth_uid: 'sign-in-uid',
      auth_provider: 'google',
      name: 'Nome Cognome',
      lastLoginAt: '2026-09-25T00:00:01.000Z',
    }, { merge: true }));
  });

  it('a verified owner may reactivate an opted-out address after a visible terms action', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'explicit-reactivation@example.com'), {
        email: 'explicit-reactivation@example.com',
        status: 'unsubscribed',
        isActive: false,
        active: false,
        unsubscribed_at: '2026-09-12T00:00:00.000Z',
        unsubscribedAt: '2026-09-12T00:00:00.000Z',
      });
    });
    const owner = testEnv.authenticatedContext('owner-uid', {
      email: 'explicit-reactivation@example.com',
      email_verified: true,
    });
    await assertSucceeds(setDoc(
      doc(owner.firestore(), 'newsletter_subscribers', 'explicit-reactivation@example.com'),
      {
        status: 'subscribed',
        isActive: true,
        active: true,
        registration_terms_accepted: true,
        consent_basis: 'registration_terms',
        consent_text: 'comunicazioni newsletter e avvisi di lavoro',
        consent_text_displayed: true,
        consent_act: 'registration_terms_acceptance',
        consent_method: 'terms_and_conditions',
        all_email_opted_out: false,
        all_emails_opted_out: false,
        global_email_opt_out: false,
        global_email_opted_out: false,
        resubscribed_at: '2026-09-12T00:00:01.000Z',
      },
      { merge: true },
    ));
  });

  it('the terms reactivation rule does not lift a provider suppression', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'hard-suppressed@example.com'), {
        email: 'hard-suppressed@example.com',
        status: 'suppressed',
        isActive: false,
        active: false,
      });
    });
    const owner = testEnv.authenticatedContext('owner-uid', {
      email: 'hard-suppressed@example.com',
      email_verified: true,
    });
    await assertFails(setDoc(
      doc(owner.firestore(), 'newsletter_subscribers', 'hard-suppressed@example.com'),
      {
        status: 'subscribed',
        isActive: true,
        active: true,
        registration_terms_accepted: true,
        consent_basis: 'registration_terms',
        consent_text: 'comunicazioni newsletter e avvisi di lavoro',
        consent_text_displayed: true,
        consent_act: 'registration_terms_acceptance',
        consent_method: 'terms_and_conditions',
        all_email_opted_out: false,
        all_emails_opted_out: false,
        global_email_opt_out: false,
        global_email_opted_out: false,
        resubscribed_at: '2026-09-12T00:00:01.000Z',
      },
      { merge: true },
    ));
  });

  it('an unauthenticated client can record an opt-out but cannot promote it back', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'optout@example.com'), {
        email: 'optout@example.com',
        status: 'confirmed',
        isActive: true,
        active: true,
        confirmed_at: '2026-09-10T00:00:00.000Z',
      });
    });
    const unauthed = testEnv.unauthenticatedContext();
    const ref = doc(unauthed.firestore(), 'newsletter_subscribers', 'optout@example.com');
    await assertSucceeds(setDoc(ref, {
      status: 'unsubscribed',
      isActive: false,
      active: false,
      unsubscribed_at: '2026-09-12T00:00:00.000Z',
    }, { merge: true }));
    await assertFails(setDoc(ref, {
      status: 'confirmed',
      isActive: true,
      active: true,
    }, { merge: true }));
  });

  it('a visible re-consent starts pending from a silent-auth row, not confirmed', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'silent-auth@example.com'), {
        email: 'silent-auth@example.com',
        status: 'confirmed',
        isActive: true,
        active: true,
        confirmed_at: '2026-09-10T00:00:00.000Z',
        source_channel: 'auth_google',
        consent_text_displayed: false,
      });
    });
    const unauthed = testEnv.unauthenticatedContext();
    await assertSucceeds(setDoc(
      doc(unauthed.firestore(), 'newsletter_subscribers', 'silent-auth@example.com'),
      {
        status: 'pending',
        isActive: false,
        active: false,
        consent_text: 'comunicazioni newsletter',
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_method: 'email_submit',
      },
      { merge: true },
    ));
  });

  // The confirmation job-context snapshot (functions/src/lib/confirmationJobContext.js)
  // is the job title a consent request prints; only the Admin-SDK senders
  // write it. Refused on every browser write — including the pending-renewal
  // clause, which otherwise lets state fields change.
  describe('confirmation_job_context is server-owned', () => {
    const SNAPSHOT = {
      kind: 'unlocked', title: 'Titolo scelto da chi scrive', company: null, location: null, return_path: null,
    };
    const PENDING_PROOF = {
      status: 'pending',
      isActive: false,
      active: false,
      consent_text: 'comunicazioni newsletter',
      consent_text_displayed: true,
      consent_act: 'typed_email_submit',
      consent_method: 'email_submit',
    };

    it('a browser cannot create a record that already carries a snapshot', async () => {
      const unauthed = testEnv.unauthenticatedContext();
      await assertFails(setDoc(doc(unauthed.firestore(), 'newsletter_subscribers', 'forged-create@example.com'), {
        email: 'forged-create@example.com', ...PENDING_PROOF, confirmation_job_context: SNAPSHOT,
      }));
    });

    it('a browser cannot add or rewrite it, not even through the pending renewal', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'renewal@example.com'), {
          email: 'renewal@example.com', ...PENDING_PROOF, status: 'expired',
          confirmation_job_context: { ...SNAPSHOT, title: 'Autista' },
        });
      });
      const unauthed = testEnv.unauthenticatedContext();
      const ref = doc(unauthed.firestore(), 'newsletter_subscribers', 'renewal@example.com');
      await assertFails(setDoc(ref, { ...PENDING_PROOF, confirmation_job_context: SNAPSHOT }, { merge: true }));
      await assertFails(setDoc(ref, { name: 'x', confirmation_job_context: null }, { merge: true }));
      // Control: the same renewal without the field is still allowed, and so is
      // a profile write that leaves the stored snapshot alone.
      await assertSucceeds(setDoc(ref, { ...PENDING_PROOF }, { merge: true }));
      await assertSucceeds(setDoc(ref, { name: 'Nome' }, { merge: true }));
    });

    it('the verified owner cannot write it either', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'owner-snap@example.com'), {
          email: 'owner-snap@example.com', ...PENDING_PROOF,
        });
      });
      const owner = testEnv.authenticatedContext('owner-snap-uid', { email: 'owner-snap@example.com', email_verified: true });
      await assertFails(setDoc(
        doc(owner.firestore(), 'newsletter_subscribers', 'owner-snap@example.com'),
        { confirmation_job_context: SNAPSHOT },
        { merge: true },
      ));
    });
  });

  it('a verified owner may promote a pending record only with visible consent', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'owner@example.com'), {
        email: 'owner@example.com',
        status: 'pending',
        isActive: false,
        active: false,
      });
    });
    const owner = testEnv.authenticatedContext('owner-uid', {
      email: 'owner@example.com',
      email_verified: true,
    });
    await assertSucceeds(setDoc(
      doc(owner.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      {
        status: 'confirmed',
        isActive: true,
        active: true,
        confirmed_at: '2026-09-12T00:00:00.000Z',
        consent_text: 'comunicazioni newsletter',
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_method: 'email_submit',
      },
      { merge: true },
    ));
  });

  // The sign-in writer (services/newsletterSubscribers.ts, PR #9837) records
  // the surface (`consent_origin`, a guarded consent key) and the origin of
  // the confirmation (`confirmation_method`, `confirmed_via_surface`, guarded
  // as subscription state) beside the terms record; a displayed registration
  // by the verified owner is accepted with them.
  const termsRegistration = (displayed: boolean) => ({
    email: 'owner@example.com',
    status: 'confirmed',
    isActive: true,
    active: true,
    confirmed_at: '2026-09-25T10:00:00.000Z',
    registration_terms_accepted: true,
    consent_basis: 'registration_terms',
    consent_text: 'Registrandomi accetto le condizioni e mi iscrivo alle comunicazioni di Frontaliere Ticino. Condizioni (v. 2026-09-25.2).',
    consent_text_version: '2026-09-25.2',
    consent_text_displayed: displayed,
    consent_act: 'registration_terms_acceptance',
    consent_method: 'terms_and_conditions',
    consent_origin: displayed ? 'job_gate' : 'auth_one_tap',
    confirmation_method: 'provider_verified_email',
    confirmed_via_surface: displayed ? 'job_gate' : 'auth_one_tap',
  });

  it('a verified owner registers under the terms with the surface and the confirmation origin', async () => {
    const owner = testEnv.authenticatedContext('owner-uid', {
      email: 'owner@example.com',
      email_verified: true,
    });
    await assertSucceeds(setDoc(
      doc(owner.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      termsRegistration(true),
    ));
  });

  it('an anonymous client cannot rewrite the confirmation origin of an existing record', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'owner@example.com'), termsRegistration(true));
    });
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(setDoc(
      doc(unauthed.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      { confirmation_method: 'doi_click', confirmed_via_surface: 'confirmation_email' },
      { merge: true },
    ));
  });

  // Owner decision of 2026-09-25: the login keeps registering in silence, and
  // the record says truthfully that no notice was on screen (One Tap over a
  // plain page, the assistant, the profile page). The displayed flag is a
  // recorded fact, not a condition; the verified owner is.
  it('a verified owner registers under the terms with the notice NOT displayed, recorded as such', async () => {
    const owner = testEnv.authenticatedContext('owner-uid', {
      email: 'owner@example.com',
      email_verified: true,
    });
    await assertSucceeds(setDoc(
      doc(owner.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      termsRegistration(false),
    ));
  });

  it('a verified owner\'s login confirms an existing pending record with the notice not displayed', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'newsletter_subscribers', 'owner@example.com'), {
        email: 'owner@example.com',
        status: 'pending',
        isActive: false,
        active: false,
        source_channel: 'job_gate',
      });
    });
    const owner = testEnv.authenticatedContext('owner-uid', {
      email: 'owner@example.com',
      email_verified: true,
    });
    await assertSucceeds(setDoc(
      doc(owner.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      termsRegistration(false),
      { merge: true },
    ));
  });

  it('the same undisplayed registration stays refused without a verified owner', async () => {
    const unauthed = testEnv.unauthenticatedContext();
    await assertFails(setDoc(
      doc(unauthed.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      termsRegistration(false),
    ));
    const unverified = testEnv.authenticatedContext('shell-uid', {
      email: 'owner@example.com',
      email_verified: false,
    });
    await assertFails(setDoc(
      doc(unverified.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      termsRegistration(false),
    ));
    const otherOwner = testEnv.authenticatedContext('other-uid', {
      email: 'someone-else@example.com',
      email_verified: true,
    });
    await assertFails(setDoc(
      doc(otherOwner.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      termsRegistration(false),
    ));
  });

  it('the displayed flag must still be a boolean, and the terms record complete', async () => {
    const owner = testEnv.authenticatedContext('owner-uid', {
      email: 'owner@example.com',
      email_verified: true,
    });
    await assertFails(setDoc(
      doc(owner.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      { ...termsRegistration(false), consent_text_displayed: 'no' },
    ));
    const { consent_text: _text, ...withoutText } = termsRegistration(false);
    await assertFails(setDoc(
      doc(owner.firestore(), 'newsletter_subscribers', 'owner@example.com'),
      withoutText,
    ));
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
