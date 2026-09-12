/**
 * THE INVARIANT: no channel mails an address that never opted in (#5686).
 *
 * `tests/newsletter-confirmed-implies-stamp.test.ts` proves the WRITE side —
 * nothing fabricates `status: 'confirmed'` without the click that earns it.
 * This file is the READ side: given a corpus where `status` cannot be trusted,
 * which senders consult the proof before choosing a recipient.
 *
 * It exists because the same defect was found twice in five days, in two
 * different channels, by two different people:
 *   - #5677: the daily brief let an unconfirmed newsletter row in through the
 *     job-alert side of its union;
 *   - #5686: the weekly newsletter took every non-excluded row on purpose,
 *     `pending` included, on the strength of a comment claiming that "clicking
 *     a link auto-confirms them" — which nothing implements. 1.488 addresses
 *     that never confirmed had been receiving it indefinitely; the person who
 *     reported it had signed up on 2026-06-10, never confirmed, and was in the
 *     `weekly_2026-06-08` campaign two days later.
 * Both were fixed one channel at a time, and neither fix could see the other
 * coming, because nothing enumerated the channels. This does.
 *
 * WHY IT IS A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. Of the thirteen senders
 * below, exactly one can be imported and driven: `send-daily-brief.mjs`, which
 * has a Firestore seam and pure exports (and IS driven, in
 * tests/daily-brief-recipients.test.ts). `send-newsletter.mjs` exports nothing
 * at all; `blast-publisher-ads.mjs`, `newsletter-sunset.mjs`,
 * `newsletter-winback-campaign.mjs` and `send-onboarding-drip.mjs` call
 * `main()` unconditionally at module scope, so importing them would RUN them.
 * A scan is what can be written today; the alternative was nothing, which is
 * what there was.
 *
 * WHAT IT DOES NOT PROVE, said plainly so nobody reads a wider promise into
 * it: that a file mentions the gate is not proof that the gate covers every
 * path through the file. It is proof that the author of a new channel had to
 * answer the question — which is the failure mode that produced both issues.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { hasConfirmationProof } from '../services/subscriberConsent.mjs';
import { NEWSLETTER_EXCLUDED_STATUSES } from '../services/emailSuppression.mjs';
import { classifySunset } from '../scripts/lib/subscriberSunset.mjs';
import { classifyDormantWinback } from '../scripts/lib/dormantWinback.mjs';
import { hasConsentEvidence, recoveredStatus } from '../scripts/lib/suppressionDecay.mjs';
import { planConfirmationFollowups } from '../scripts/newsletter-confirmation-followups.mjs';
import { DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH } from '../functions/src/lib/confirmationFollowup.js';
// The sender population is shared with tests/no-channel-mails-opted-out.test.ts
// — see tests/helpers/senders.ts for why it must not be discovered twice.
import { ROOT, read, stripComments, discoverSenders } from './helpers/senders';

const CALLS_GATE = /hasConfirmationProof\s*\(/;
const CALLS_JOB_ALERT_GATE = /evaluateJobAlertConsent\s*\(/;

type Verdict =
  /** Consults the proof before choosing a recipient. */
  | { verdict: 'gated'; why: string; gateIn?: string }
  /**
   * Its purpose is reaching people the ordinary campaigns no longer may, so
   * the gate would make it inert. Declared, not ignored — and each one's real
   * audience rule is asserted below, so "re-permission" cannot become a label
   * somebody pins on an ordinary campaign to get past this file.
   */
  | { verdict: 're-permission'; why: string }
  /** Does not choose recipients from the subscriber collections at all. */
  | { verdict: 'not-a-broadcast'; why: string }
  /**
   * IS the request for the proof. There is exactly one such channel and there
   * can only ever be one: the double opt-in confirmation, and the two reminders
   * that are the same email again (#5692).
   *
   * It cannot be `gated` — gating it on `hasConfirmationProof` returning true
   * would make it inert, since the whole population it exists for is the people
   * for whom it returns false. It is not `re-permission` either: those two
   * channels write to somebody who DID consent once and has gone quiet. And it
   * is not a broadcast — no content, no offer, one link, sent only to an address
   * that submitted the form itself.
   *
   * What it owes this file is the OTHER direction of the same gate: it must
   * consult the proof in order to EXCLUDE the 842 `pending` documents that
   * already carry `confirmed_at`, because asking somebody to confirm what they
   * confirmed in June is its own kind of unsolicited mail. That is asserted
   * below both as a scan and by driving the planner, because a scan alone would
   * pass on a file that reads the gate and ignores the answer.
   */
  | { verdict: 'consent-request'; why: string; gateIn?: string }
  /**
   * Channel-aware gate: explicit job alerts keep their own consent basis, but
   * inferred newsletter→job-alert backfills need a job-alert proof before the
   * sender can use their `active` flag. This is deliberately not the generic
   * newsletter `hasConfirmationProof` gate.
   */
  | { verdict: 'channel-aware-gated'; why: string };

/**
 * Every top-level sender, with the verdict that lets it past this file.
 *
 * The KEYS are checked for exhaustiveness against the filesystem below, so a
 * fourteenth sender fails this test on the day it is written rather than on
 * the day somebody notices it mailing the wrong people.
 */
const VERDICTS: Record<string, Verdict> = {
  'scripts/send-newsletter.mjs': {
    verdict: 'gated',
    why: '#5686 — the weekly campaign, the channel this file was written for',
  },
  'scripts/send-daily-brief.mjs': {
    verdict: 'gated',
    why: '#5677 — gated on both sides of its union, and driven behaviourally in tests/daily-brief-recipients.test.ts',
  },
  'scripts/blast-publisher-ads.mjs': {
    verdict: 'gated',
    why: 'paid-ad blast over the whole collection — same class as #5686, fixed in the same PR',
    gateIn: 'services/publisherBlastMatch.mjs',
  },
  'scripts/newsletter-sunset.mjs': {
    verdict: 're-permission',
    why: 'the sunset mail is the last thing a lapsed address gets; a consent gate here would only mean it lapses in silence',
  },
  'scripts/newsletter-winback-campaign.mjs': {
    verdict: 're-permission',
    why: 'two-stage win-back at the dormant end of the engagement score — same reason as the sunset above',
  },
  'scripts/send-onboarding-drip.mjs': {
    verdict: 'gated',
    why: '#5700 — was the known-gap entry this file recorded (admitted `pending` on isActive, and anchored enrollment on created_at when no stamp existed); both are gone, and the enrollment fallback with them',
  },
  'scripts/newsletter-confirmation-followups.mjs': {
    verdict: 'consent-request',
    why: '#5692 — reminders #2 and #3 of the double opt-in, the same email and the same link as #1. Its recipients are unconfirmed BY DEFINITION; what it consults the gate for is the opposite exclusion, the 842 `pending` re-probes that already carry `confirmed_at`',
    gateIn: 'functions/src/lib/confirmationFollowup.js',
  },
  /**
   * The two alert channels use a channel-aware gate. An alert somebody really
   * created has a consent basis of its OWN and remains sendable; a historical
   * newsletter backfill is not allowed to borrow `active` as consent and must
   * carry either an alert-specific proof or an affirmative job-alert consent
   * on the newsletter record. The newsletter opt-out remains a separate,
   * cross-channel stop asserted in tests/no-channel-mails-opted-out.test.ts.
   */
  'scripts/send-job-alerts.mjs': {
    verdict: 'channel-aware-gated',
    why: 'explicit alerts keep their own consent; historical newsletter backfills require evaluateJobAlertConsent before delivery',
  },
  'scripts/send-company-alerts.mjs': {
    verdict: 'channel-aware-gated',
    why: 'the immediate sender shares the same explicit-vs-backfilled consent boundary as the daily digest',
  },
  'scripts/send-saved-jobs-digest.mjs': {
    verdict: 'not-a-broadcast',
    why: 'audience is collectionGroup(savedJobs) + users/{uid} with its own opt-out; newsletter_subscribers is read per-address as a suppression cross-check only',
  },
  'scripts/send-cold-emails.mjs': {
    verdict: 'not-a-broadcast',
    why: 'employer outreach over employer_contacts — never touches the subscriber collections',
  },
  'scripts/preview-welcome-email.mjs': {
    verdict: 'not-a-broadcast',
    why: 'single --target-email preview tool, no collection scan',
  },
  'scripts/monitor-gsc-job-indexation.mjs': {
    verdict: 'not-a-broadcast',
    why: 'ops alert to the owner',
  },
  'scripts/notify-journalist-article-live.mjs': {
    verdict: 'not-a-broadcast',
    why: 'internal notification',
  },
};

describe('every sender is classified', () => {
  const senders = discoverSenders();

  it('the discovery found the senders at all', () => {
    // Guards the scan itself: a broken filter would otherwise make every
    // assertion below pass vacuously.
    expect(senders.length).toBeGreaterThan(8);
    expect(senders).toContain('scripts/send-newsletter.mjs');
    expect(senders).toContain('scripts/send-daily-brief.mjs');
  });

  it('no sender is missing a verdict — a new channel must declare one here', () => {
    const undeclared = senders.filter((s) => !(s in VERDICTS));
    expect(
      undeclared,
      'a new sender must say whether it consults the consent gate, and why',
    ).toEqual([]);
  });

  it('no verdict is stale — every entry still names a file that sends', () => {
    const orphaned = Object.keys(VERDICTS).filter((s) => !senders.includes(s));
    expect(orphaned, 'this entry no longer sends mail — delete it').toEqual([]);
  });
});

describe('the verdicts hold', () => {
  const entries = Object.entries(VERDICTS);
  const gated = entries.filter(([, v]) => v.verdict === 'gated') as Array<[string, Extract<Verdict, { verdict: 'gated' }>]>;
  const channelAware = entries.filter(([, v]) => v.verdict === 'channel-aware-gated') as Array<
    [string, Extract<Verdict, { verdict: 'channel-aware-gated' }>]
  >;
  const consentRequests = entries.filter(([, v]) => v.verdict === 'consent-request') as Array<
    [string, Extract<Verdict, { verdict: 'consent-request' }>]
  >;
  const notBroadcast = entries.filter(([, v]) => v.verdict === 'not-a-broadcast');

  it('there is exactly one consent-request channel', () => {
    // The label is the one that says "this channel may mail an address with no
    // proof of consent". If a second file ever earns it, that is a review, not
    // a line in a table: there is only one double opt-in on this site.
    expect(consentRequests.map(([f]) => f)).toEqual(['scripts/newsletter-confirmation-followups.mjs']);
  });

  it.each(consentRequests)('%s consults the gate to EXCLUDE the already-confirmed', (file, v) => {
    const where = v.gateIn || file;
    expect(stripComments(read(where)), `${where} must call hasConfirmationProof()`).toMatch(CALLS_GATE);
    expect(read(where)).toMatch(/from '[^']*subscriberConsent\.(mjs|js)'/);
    expect(stripComments(read(where))).not.toMatch(/function hasConfirmationProof/);
  });

  it.each(gated)('%s consults the shared gate', (file, v) => {
    const where = v.gateIn || file;
    expect(stripComments(read(where)), `${where} must call hasConfirmationProof()`).toMatch(CALLS_GATE);
    // From the shared module, never a local copy: a second definition is how
    // two channels end up disagreeing about who consented.
    expect(read(where)).toMatch(/from '[^']*subscriberConsent\.mjs'/);
    expect(stripComments(read(where))).not.toMatch(/function hasConfirmationProof/);
  });

  it.each(channelAware)('%s consults the channel-aware job-alert gate', (file) => {
    const src = stripComments(read(file));
    expect(src, `${file} must call evaluateJobAlertConsent()`).toMatch(CALLS_JOB_ALERT_GATE);
    expect(read(file)).toMatch(/from '[^']*jobAlertBackfillCore\.js'/);
    expect(
      stripComments(read('functions/src/jobAlertBackfillCore.js')),
      'the channel-aware gate must have one canonical implementation',
    ).toMatch(/export function evaluateJobAlertConsent\s*\(/);
  });

  it.each(notBroadcast)('%s does not scan a subscriber collection', (file) => {
    const src = stripComments(read(file));
    expect(src).not.toMatch(/collection\('newsletter_subscribers'\)\s*\.\s*get\(\)/);
    expect(src).not.toMatch(/collection\('job_alert_subscribers'\)\s*\.\s*get\(\)/);
  });

  it('the re-permission channels are exactly the ones whose audience rule says so', () => {
    // The label has to be earned by the code, or it becomes the sentence any
    // ordinary campaign writes to get past this file. Both channels admit only
    // an explicit mailable allowlist, and neither can be pointed at a fresh
    // unconfirmed signup: `pending` is not in it.
    const lapsed = { status: 'pending', sends: 99, last_sent_at: '2020-01-01T00:00:00.000Z', created_at: '2020-01-01T00:00:00.000Z' };
    expect(classifySunset(lapsed, Date.now()).action).toBe('none');
    expect(classifyDormantWinback({ ...lapsed, engagement_level: 'dormant' }, Date.now()).action).toBe('none');
  });
});

describe('the consent-request channel, driven — the label is earned, not claimed', () => {
  // The scan above proves the gate is reached. This proves the answer is
  // obeyed, on the one population that would be harmed if it were not: the 842
  // `pending` documents that already carry `confirmed_at`, which
  // scripts/mailtrap-suppression-retry.mjs put back to `pending` as a
  // deliverability re-probe. A reminder to them is a request to re-consent to
  // something they consented to months ago.
  const NOW = Date.parse('2026-09-01T12:00:00.000Z');
  const ctx = { now: NOW, epochMs: Date.parse(DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH) };
  const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

  it.each(['confirmed_at', 'confirmedAt'])('a `pending` document carrying %s is never mailed', (stamp) => {
    const reProbe = {
      id: 'reprobe@example.com',
      data: { status: 'pending', isActive: true, created_at: daysAgo(1), [stamp]: daysAgo(200) },
    };
    const plan = planConfirmationFollowups([reProbe], ctx);
    expect(plan.send).toEqual([]);
    // …and it is not closed either. The proof gate runs before anything counts
    // attempts, so a re-probe is neither asked nor expired.
    expect(plan.expire).toEqual([]);
    expect(plan.skipped).toEqual({ 'already-confirmed': 1 });
  });

  it('the same document without the stamp IS mailed — so the assertion above is not vacuous', () => {
    const fresh = { id: 'fresh@example.com', data: { status: 'pending', isActive: false, created_at: daysAgo(1) } };
    expect(planConfirmationFollowups([fresh], ctx).send).toHaveLength(1);
  });

  it('the gate is asked before the counter, so three old sends cannot expire a confirmed address', () => {
    const reProbe = {
      id: 'reprobe@example.com',
      data: {
        status: 'pending',
        created_at: daysAgo(1),
        confirmed_at: daysAgo(200),
        confirmation_attempts: 3,
        confirmation_sent_at: daysAgo(9),
      },
    };
    expect(planConfirmationFollowups([reProbe], ctx)).toMatchObject({ send: [], expire: [] });
  });
});

describe('send-newsletter.mjs: both recipient paths, not just the bulk one', () => {
  const src = read('scripts/send-newsletter.mjs');

  /**
   * Slice a top-level function out of the file by name.
   *
   * Enumerated per-path rather than asserted once over the whole file on
   * purpose: `fetchTargetSubscriber` is the --test/--dry-run path, it is
   * twenty lines long and nowhere near the bulk query, and a file-wide
   * `toMatch` would have read as covered while it stayed open.
   */
  function functionBody(source: string, name: string): string {
    const start = source.indexOf(`async function ${name}(`);
    if (start < 0) return '';
    const rest = source.slice(start + 1);
    const nextTop = rest.search(/\n(?:async )?function \w+\(/);
    return nextTop < 0 ? rest : rest.slice(0, nextTop);
  }

  it('finds both paths — this test is re-pointed, not deleted, if they are renamed', () => {
    expect(functionBody(src, 'fetchSubscribers').length).toBeGreaterThan(200);
    expect(functionBody(src, 'fetchTargetSubscriber').length).toBeGreaterThan(200);
  });

  it.each(['fetchSubscribers', 'fetchTargetSubscriber'])('%s consults the gate', (name) => {
    expect(stripComments(functionBody(src, name))).toMatch(CALLS_GATE);
  });

  it('the --test fallback profile cannot stand in for a refused document', () => {
    // The synthetic profile exists for an address with NO document. Before
    // #5686 a refusal and an absence were the same `null`, so the fallback
    // would have mailed exactly the address the gate had just turned away.
    const body = stripComments(src.slice(src.indexOf("if (mode === 'test')")));
    expect(body).toMatch(/refusal/);
  });

  it('the auto-confirm claim survives only where it is being refuted', () => {
    // The comment was the whole authorisation for the behaviour: it described
    // a guarantee no code provides, and a reader had every reason to trust it.
    // Deleting the words is not enough and keeping them is not forbidden —
    // what must not exist is the claim standing as a claim. So: the exact
    // sentence that authorised the send is gone, and any surviving mention has
    // to sit next to the fact that it was never true.
    expect(src).not.toMatch(/Fetch ALL subscribers \(including pending\) — clicking a link auto-confirms them\./);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/auto-confirm/i.test(line)) return;
      const window = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
      expect(window, `line ${i + 1} repeats the auto-confirm claim without refuting it`)
        .toMatch(/Nothing implements that|#5686/);
    });
  });
});

describe('the fix that was NOT made, and why it must stay unmade', () => {
  const STAMP = '2026-01-01T00:00:00.000Z';
  it('`pending` is not in NEWSLETTER_EXCLUDED_STATUSES', () => {
    // The obvious fix, and the wrong one. That Set is shared with
    // newsletter-sunset, the dormant win-back, the onboarding drip and the
    // transactional guard; `pending` in it would make the two re-permission
    // channels inert — they exist to reach exactly these people. It would also
    // drop the 847 production rows sitting at `pending` WITH a stamp, which
    // scripts/mailtrap-suppression-retry.mjs writes as a deliverability
    // re-probe on addresses that DID confirm (measured 2026-08-12).
    expect(NEWSLETTER_EXCLUDED_STATUSES.has('pending')).toBe(false);
    expect([...NEWSLETTER_EXCLUDED_STATUSES].sort()).toEqual(
      ['bounced', 'complained', 'expired', 'inactive', 'suppressed', 'unsubscribed'],
    );
  });

  it('`expired` IS in the set — and it is not the fix above wearing a different word', () => {
    // #5692 closes an unanswered double opt-in after three requests, one per
    // day. The distinction from the paragraph above is the whole point and is
    // worth stating where somebody will read it:
    //   - `pending` describes a document we have not finished asking. The two
    //     re-permission channels must still reach those people, and 848 of
    //     them (2026-08-13) have in fact already confirmed;
    //   - `expired` describes one we HAVE finished asking. The record exists
    //     to say we asked three times and stopped, so a win-back or a sunset
    //     mail to that address contradicts the record itself.
    // A document can only be moved from one to the other by the runner, never
    // by a browser, and only when it carries no confirmation stamp.
    expect(NEWSLETTER_EXCLUDED_STATUSES.has('expired')).toBe(true);
    expect(hasConfirmationProof({ status: 'expired' })).toBe(false);
  });

  it('the gate reads the stamp and never the word, in both directions', () => {
    // OUT: the shape the 1.488 unconfirmed rows have.
    expect(hasConfirmationProof({ status: 'pending' })).toBe(false);
    // OUT: fabricated consent — 392 rows claim `confirmed` with nothing behind it.
    expect(hasConfirmationProof({ status: 'confirmed' })).toBe(false);
    // IN: the deliverability re-probe — `pending` means "retry me", not "never consented".
    expect(hasConfirmationProof({ status: 'pending', confirmed_at: STAMP })).toBe(true);
    expect(hasConfirmationProof({ status: 'pending', confirmedAt: STAMP })).toBe(true);
    // Both spellings, on the row or on the raw doc a projection carries.
    expect(hasConfirmationProof({ doc: { confirmed_at: STAMP } })).toBe(true);
    expect(hasConfirmationProof(null)).toBe(false);
  });

  it('does not treat a silent authentication timestamp as newsletter consent', () => {
    const authOnly = {
      status: 'confirmed',
      isActive: true,
      confirmed_at: STAMP,
      source: 'signup',
      source_channel: 'auth_google',
      consent_act: 'authentication',
      consent_text_displayed: false,
    };
    expect(hasConfirmationProof(authOnly)).toBe(false);
    expect(hasConfirmationProof({ ...authOnly, consent_text_displayed: true })).toBe(true);
    expect(hasConfirmationProof({
      doc: { ...authOnly, consent_text_displayed: false },
    })).toBe(false);
  });

  /**
   * THE REVIEW FINDING ON #5686, and the fork it opened.
   *
   * The reviewer was right: the "riattiva newsletter" toggle writes
   * `status: 'subscribed'` + `resubscribed_at` and NO stamp, so after this gate
   * those people are held back although they had just opted in explicitly. The
   * two remedies offered were not equivalent, and only one of them is safe.
   *
   * REJECTED — accept `resubscribed_at` as proof. The same field is written by
   * the resubscribe LINK (`action=resubscribe`, and the
   * `source_channel: 'resubscribe_link'` upsert), which is a bare GET carrying
   * a never-expiring HMAC(email) that rides in every email ever sent to that
   * address. Anti-phishing scanners follow it — measured on this system:
   * `unsubscribe` at 12:40:53, `subscribe_completed` at 12:40:55. Promoting
   * that field to proof would let a scanner's timestamp count as consent,
   * which is the exact defect #5711/#5720 is open to close.
   *
   * TAKEN — neither preference toggle mints DOI proof. A signed-in session
   * proves who is operating the profile, but it does not prove that the
   * newsletter confirmation link was completed. A prior confirmed stamp may
   * still support an explicit profile re-opt-in; a row without one remains
   * unmarketable until the real confirmation path runs.
   */
  describe('who may write the proof', () => {
    it('the authenticated in-app toggle does not mint a confirmation stamp', () => {
      const src = stripComments(read('components/preferences/SubscriptionPreferencesController.tsx'));
      const fn = src.slice(src.indexOf('async function authToggleNewsletter'));
      const subscribeBranch = fn.slice(0, fn.indexOf('} else {'));
      expect(subscribeBranch).not.toMatch(/confirmed_at:\s*serverTimestamp\(\)/);
      expect(subscribeBranch).not.toMatch(/confirmedAt:\s*serverTimestamp\(\)/);
      // The gate agrees with the write: a row that toggle produces without
      // prior proof does not pass.
      expect(hasConfirmationProof({
        status: 'subscribed',
        resubscribed_at: STAMP,
      })).toBe(false);
    });

    it('a `subscribed` row with only resubscribed_at does NOT pass', () => {
      // The shape the Cloud Function toggle and the resubscribe link both
      // leave. Indistinguishable from a scanner's fetch, so it is not proof.
      expect(hasConfirmationProof({ status: 'subscribed', resubscribed_at: STAMP })).toBe(false);
      expect(hasConfirmationProof({ status: 'subscribed', resubscribedAt: STAMP })).toBe(false);
    });

    it('the gate reads neither resubscribed_at nor reactivated_at, in any spelling', () => {
      // `reactivated_at` is the more dangerous of the two aliases: it is
      // written PURELY automatically by six scripts (subscriberReactivation on
      // a delivered/open/click webhook, the sunset passes, the mailtrap
      // re-probe, the suppression decay, the restore pass). Nothing a person
      // did is recorded in it. scripts/lib/subscriberSunset.mjs already treats
      // it as interchangeable with `resubscribed_at` for ITS purposes, which
      // is fine there and would be fatal here — so the coupling is refused in
      // the source, not just in the docblock.
      const gateSrc = stripComments(read('services/subscriberConsent.mjs'));
      expect(gateSrc).not.toMatch(/resubscribed_?[Aa]t/);
      expect(gateSrc).not.toMatch(/reactivated_?[Aa]t/);
      expect(hasConfirmationProof({ reactivated_at: STAMP })).toBe(false);
      expect(hasConfirmationProof({ doc: { resubscribed_at: STAMP } })).toBe(false);
    });

    it('the Cloud Function toggle still writes no stamp — recorded, not overlooked', () => {
      // Asserted as a FACT so the decision is visible where it was made. If
      // this fires, somebody added the stamp there: that is a consent-policy
      // change, not a cleanup — the credential is the eternal email HMAC over
      // GET, so read #5720 before keeping it.
      const src = read('functions/src/newsletterSubscriptionManagement.js');
      const start = src.indexOf("if (action === 'toggle_newsletter_subscription')");
      expect(
        start,
        'the toggle branch moved — re-point this test (that file is being rewritten by #5720)',
      ).toBeGreaterThan(-1);
      const branch = stripComments(src.slice(start, start + 2000));
      expect(branch).toMatch(/status:\s*'subscribed'/);
      expect(
        branch,
        'the CF toggle now writes the consent stamp — see #5720 before accepting this',
      ).not.toMatch(/confirmed_?[Aa]t\s*:/);
    });
  });

  /**
   * THE THREE SHAPES, taken from production rather than invented (#5700).
   *
   * Re-measured 2026-08-13 over 8.673 `newsletter_subscribers` docs: 550 were
   * not excluded, carried no `confirmed_at`/`confirmedAt`, and still passed the
   * OR that `send-onboarding-drip.mjs` and `newsletterWelcomeEmail.js` used to
   * call `isConfirmedActive` —
   *
   *   status=confirmed, no stamp        405   the 2026-07 recovery pass DEDUCED it
   *   status=pending  + isActive:true   143   mailtrap-suppression-retry.mjs:176
   *   status empty    + isActive:true     2
   *
   * They are asserted here, in the file that enumerates the channels, because
   * the defect was never one channel's: the same OR was written four times, and
   * #5677/#5694 closed two of them without the other two being visible from
   * where the fix was made. A fixture with the same three shapes in it is what
   * makes the fifth copy fail on the day it is written.
   *
   * THE OTHER DIRECTION, measured in the same run so the narrowing is not taken
   * on faith: the strict gate newly REFUSES 550 and newly ADMITS 0.
   */
  describe('the three shapes that passed, and no longer do', () => {
    const CONFIRMED_NO_STAMP = { status: 'confirmed', restored_reason: 'mailtrap_suspension_mismapped', source: 'signup', isActive: true, active: true };
    const PENDING_REPROBE = { status: 'pending', isActive: true, suppressed_at: STAMP, reactivated_at: STAMP };
    const EMPTY_WITH_FLAG = { status: '', isActive: true };

    /** The OR every one of the four senders used to carry. */
    const legacyOr = (d: Record<string, unknown>) =>
      d.status === 'confirmed' || d.isActive === true || d.active === true;

    it.each([
      ['confirmed without the stamp (405 docs)', CONFIRMED_NO_STAMP],
      ['pending carrying the re-probe flag (143 docs)', PENDING_REPROBE],
      ['empty status carrying the flag (2 docs)', EMPTY_WITH_FLAG],
    ])('%s passed the old OR and is refused by the gate', (_label, doc) => {
      expect(legacyOr(doc), 'the fixture no longer reproduces the defect — re-measure before editing it').toBe(true);
      expect(hasConfirmationProof(doc)).toBe(false);
    });

    it('the weekly --apply path refuses them too — it is a WRITER of the word (#5717)', () => {
      // scripts/suppression-decay.mjs runs weekly with --apply from
      // suppression-hygiene.yml and writes `status: restoredStatus`. Until
      // #5717 `hasConsentEvidence()` accepted `subscribe_completed` (which the
      // SIGNUP writes) and a signup-origin regex, so this path could mint the
      // word `confirmed` for a document that had never confirmed — refilling
      // the very cohort the send gates had just learned to refuse.
      for (const doc of [CONFIRMED_NO_STAMP, PENDING_REPROBE, EMPTY_WITH_FLAG]) {
        expect(hasConsentEvidence(doc, [{ event_type: 'subscribe_completed' }])).toBe(false);
        expect(recoveredStatus('newsletter_subscribers', doc, [{ event_type: 'subscribe_completed' }])).toBe('pending');
      }
      // `source: 'signup'` matches AUTO_CONFIRMED_ORIGIN_RE. That used to be
      // enough on its own; it is an inference from the form, not a click.
      expect(hasConsentEvidence({ source: 'signup' })).toBe(false);
      expect(hasConsentEvidence({ source_channel: 'auth_google' })).toBe(false);
    });

    /**
     * THE PERIOD EVIDENCE, and why it is one branch and not three.
     *
     * The risk in tightening this is the mirror of #5694's: refuse the stamp's
     * absence and you cut off anyone who confirmed BEFORE the stamp existed.
     * Measured over the same 550 (2026-08-13), that cohort is EMPTY, and the
     * absence is informative rather than an artifact of the era:
     *
     *   `confirm` event                                    0 / 550
     *   `confirmation_email_sent` event (we ASKED)       456 / 550
     *   `subscribe_completed` event                      495 / 550
     *   `consent_given` + `consent_text_displayed`         0 / 550
     *   created before the earliest `confirmed_at` seen    22 / 550
     *   ...and, in a 296-doc sample of STAMPED subscribers, 283 carry a
     *      `confirm` event — so the event is how a real confirmation is
     *      ordinarily recorded, not a modern invention these people predate.
     *
     * So the strict gate keeps exactly one alternative — the `confirm` event —
     * and it is kept although it saves nobody today, because it is the branch
     * that WOULD save a genuine pre-stamp confirmer, and because it is a record
     * of a click rather than a deduction from a form.
     */
    it('an explicit confirm event is period evidence, on the path that can read events', () => {
      expect(hasConsentEvidence(CONFIRMED_NO_STAMP, [{ event_type: 'confirm' }])).toBe(true);
      expect(recoveredStatus('newsletter_subscribers', CONFIRMED_NO_STAMP, [{ event_type: 'confirm' }])).toBe('confirmed');
    });

    it('the senders do NOT read events, and that is a decision with a number behind it', () => {
      // `hasConfirmationProof` takes a row, never an event log: the drip scans
      // 8.6k docs on a cron, so reading a subcollection per doc would be 8.6k
      // extra reads per run. It is affordable only where the population is the
      // few hundred docs a restore pass is about to WRITE — which is exactly
      // where `hasConsentEvidence` is called from.
      //
      // The number that makes the trade safe: 0 of the 550 carry a `confirm`
      // event, so no sender loses a single genuine subscriber by not looking.
      expect(hasConfirmationProof(CONFIRMED_NO_STAMP)).toBe(false);
      // And the one thing that always passes, on every path: the stamp.
      expect(hasConfirmationProof({ ...CONFIRMED_NO_STAMP, confirmed_at: STAMP })).toBe(true);
      expect(hasConsentEvidence({ ...CONFIRMED_NO_STAMP, confirmed_at: STAMP })).toBe(true);
    });
  });

  it('the gate has exactly one definition', () => {
    // The definition moved to `functions/src/lib/` in #5692, exactly as the
    // old `services/subscriberConsent.mjs` docblock instructed: a Cloud
    // Function now needs it (the confirmation email must not count a
    // passwordless login link, or a re-probe of an already-confirmed address,
    // against the three-request cap) and Cloud Functions have no bundler.
    // `services/subscriberConsent.mjs` is a re-export, so every existing
    // importer is unchanged — which is why `functions/src/lib` joins the
    // scanned directories rather than replacing them: the invariant is ONE
    // definition anywhere, not one definition in a particular folder.
    const dirs = ['services', 'scripts', 'scripts/lib', 'functions/src/lib'];
    const definers = dirs.flatMap((dir) =>
      readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(mjs|js|ts)$/.test(e.name))
        .map((e) => `${dir}/${e.name}`)
        .filter((rel) => /(export )?function hasConfirmationProof/.test(stripComments(read(rel)))),
    );
    expect(definers).toEqual(['functions/src/lib/subscriberConsent.js']);
  });
});
