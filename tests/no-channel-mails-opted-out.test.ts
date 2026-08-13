/**
 * THE INVARIANT: after an unsubscribe, no collection holds a state that
 * authorises a send to that address (#5688).
 *
 * `tests/newsletter-unsubscribe-integrity.test.ts` proves that the opt-out is
 * WRITTEN and stays written — that no upsert path resurrects it (#5672) and
 * that both writers leave a shape every reader recognises (#5673). This file is
 * the other end: given a document that records an opt-out, which senders refuse
 * to mail it.
 *
 * It exists because the answer was "the newsletter ones, and nobody else". The
 * two alert senders and the saved-jobs digest were already READING the
 * newsletter document — the read is right there in their batched getAll — and
 * asking it `isAddressSuppressed()`, which answers "is this mailbox dead or
 * hostile" and not "did this person tell us to stop". Measured 2026-08-12 on
 * the 186 addresses suppressed after an LPD art. 25/32 complaint: 127 had a
 * `job_alert_subscribers` document and 127 of those 127 were still `active`
 * after the newsletter-side suppression. One of them was mailed at 09:43:32
 * UTC, fifteen minutes after we had confirmed in writing, at 09:28:02, that
 * they were removed "from all lists".
 *
 * WHY IT IS BOTH A SOURCE SCAN AND A BEHAVIOURAL TEST. The scan is the part
 * that scales to a channel nobody has written yet: the sender population comes
 * from disk (tests/helpers/senders.ts, shared with
 * tests/no-channel-mails-unconfirmed.test.ts so the two invariants cannot end
 * up asking about different sets of files), and every sender must carry a
 * verdict here, so a fourteenth one fails this file on the day it is written.
 * The behavioural half is what stops the scan from being satisfied by a
 * mention: the predicate, the daily brief's dedup, the paid-ad matcher and both
 * lifecycle classifiers are driven with the exact document shapes production
 * holds.
 *
 * THE DIRECTION IS DELIBERATE AND IT IS ONE-WAY. A newsletter opt-out silences
 * every channel; an alert opt-out silences that alert. Asserted below, because
 * "the asymmetry is intentional" is exactly the sentence a later reader deletes
 * when it lives only in a comment.
 *
 * Every address here is on example.com (the repo is public).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  CROSS_CHANNEL_STOP_STATUSES,
  NEWSLETTER_EXCLUDED_STATUSES,
  isAddressSuppressed,
  isCrossChannelStop,
  isJobAlertExcluded,
  isNewsletterExcluded,
} from '../services/emailSuppression.mjs';
import { hasNewsletterOptOutStamp, isNewsletterOptOutBinding } from '../services/newsletterOptOut.mjs';
import { classifySunset } from '../scripts/lib/subscriberSunset.mjs';
import { classifyDormantWinback } from '../scripts/lib/dormantWinback.mjs';
import { matchSubscribersForAd } from '../services/publisherBlastMatch.mjs';
import { shouldSkipSubscriber } from '../functions/src/jobAlertBackfillCore.js';
import { dedupeRecipients } from '../scripts/send-daily-brief.mjs';
import { ROOT, read, stripComments, discoverSenders } from './helpers/senders';

const OPTED_OUT = 'optout@example.com';
const STILL_IN = 'subscribed@example.com';
const OPT_OUT_STAMP = '2026-08-01T09:28:02.000Z';
const CONFIRM_STAMP = '2026-06-01T10:00:00.000Z';

/**
 * The document the RFC 8058 one-click Cloud Function leaves behind
 * (`action: 'unsubscribe'`, functions/src/newsletterSubscriptionManagement.js).
 * `confirmed_at` survives the cycle — the unsubscribe branch does not delete it
 * — which is why "has a confirmation stamp" can never stand in for "may be
 * mailed".
 */
const CF_UNSUBSCRIBED = {
  email: OPTED_OUT,
  status: 'unsubscribed',
  isActive: false,
  active: false,
  confirmed_at: CONFIRM_STAMP,
  unsubscribed_at: OPT_OUT_STAMP,
  unsubscribedAt: OPT_OUT_STAMP,
};

/**
 * The shape the SPA "Disiscriviti" link left for years: the camelCase stamp and
 * NOTHING else — no status change, no event (#5673). 458 production documents
 * carry only this. A guard that reads `status` alone calls this address
 * mailable, and the status it reads here is the strongest word in the
 * vocabulary.
 */
const SPA_STAMP_ONLY = {
  email: OPTED_OUT,
  status: 'confirmed',
  isActive: true,
  active: true,
  confirmed_at: CONFIRM_STAMP,
  unsubscribedAt: OPT_OUT_STAMP,
};

/** Same person, seen from the other collection — untouched by the opt-out. */
const THEIR_JOB_ALERT_DOC = { status: 'active' };
/** …and their saved search, the one the backfill created for them. */
const THEIR_ALERT = { id: 'backfill-newsletter', active: true, keywords: [], locations: [] };

/**
 * A subscriber who never opted out, used as the control in every drive below.
 *
 * `consent_text` is here for the paid-ad matcher and for no other reader in
 * this file. Since #5759 that matcher also asks whether the stored disclosure
 * named third-party advertising, so a control document without one would be
 * dropped for a reason that has nothing to do with the opt-out — and the blast
 * assertion below would pass while asserting nothing at all about opting out.
 * The version is the one that first named advertising.
 */
const STILL_SUBSCRIBED = {
  email: STILL_IN,
  status: 'confirmed',
  isActive: true,
  active: true,
  confirmed_at: CONFIRM_STAMP,
  consent_text:
    'Iscrivo il mio indirizzo alle comunicazioni di Frontaliere Ticino. Cosa ricevo, con che frequenza, come disdire e chi tratta i dati: frontaliereticino.ch/comunicazioni (versione 2026-08-13.2).',
};

const OPTED_OUT_SHAPES: Array<[string, Record<string, unknown>]> = [
  ['the one-click Cloud Function document', CF_UNSUBSCRIBED],
  ['the SPA camelCase-stamp-only document (458 in production)', SPA_STAMP_ONLY],
];

describe('the predicate: what the newsletter document says to every other channel', () => {
  it.each(OPTED_OUT_SHAPES)('%s is a cross-channel stop', (_label, doc) => {
    expect(isCrossChannelStop(doc)).toBe(true);
  });

  it('the SPA shape is exactly the one the old predicate called mailable', () => {
    // Not a hypothetical: this is the regression under test. `status` says
    // `confirmed`, so every status-only reader admits it.
    expect(isAddressSuppressed(SPA_STAMP_ONLY.status)).toBe(false);
    expect(isNewsletterExcluded(SPA_STAMP_ONLY.status)).toBe(false);
    expect(hasNewsletterOptOutStamp(SPA_STAMP_ONLY)).toBe(true);
  });

  it('the status half is what isAddressSuppressed was missing', () => {
    // The single-line defect of #5688, stated as an assertion: the alert
    // senders held the right document and asked it the wrong question.
    expect(isAddressSuppressed('unsubscribed')).toBe(false);
    expect(isCrossChannelStop({ status: 'unsubscribed' })).toBe(true);
  });

  it('reads the stamp in both spellings, on the row or on a projection\'s .doc', () => {
    expect(isCrossChannelStop({ unsubscribed_at: OPT_OUT_STAMP })).toBe(true);
    expect(isCrossChannelStop({ unsubscribedAt: OPT_OUT_STAMP })).toBe(true);
    expect(isCrossChannelStop({ doc: { unsubscribed_at: OPT_OUT_STAMP } })).toBe(true);
    expect(isCrossChannelStop({ doc: { unsubscribedAt: OPT_OUT_STAMP } })).toBe(true);
    expect(isCrossChannelStop({ doc: { status: 'unsubscribed' } })).toBe(true);
    // A projection may carry the status without the raw document repeating it.
    expect(isCrossChannelStop({ status: 'unsubscribed', doc: {} })).toBe(true);
  });

  it('keeps an ordinary subscriber, and tolerates absence', () => {
    expect(isCrossChannelStop(STILL_SUBSCRIBED)).toBe(false);
    expect(isCrossChannelStop({})).toBe(false);
    expect(isCrossChannelStop(null)).toBe(false);
  });

  it('an explicit re-opt-in lifts it — the predicate is not a stamp presence check', () => {
    // The premise this fix was first written on ("every re-opt-in DELETES the
    // stamp") stopped being true while it was in review: #5711 made the stamp
    // append-only precisely so a 1,5-second unsubscribe→resubscribe pair leaves
    // evidence. So the cross-channel reader delegates to the one module that
    // owns the supersession rule instead of asking "is a stamp present" — which
    // would now mean "nobody who ever left may be mailed again, on any channel".
    const returned = {
      email: STILL_IN,
      status: 'confirmed',
      confirmed_at: CONFIRM_STAMP,
      unsubscribed_at: OPT_OUT_STAMP,
      resubscribed_at: '2026-08-02T09:00:00.000Z',
    };
    expect(hasNewsletterOptOutStamp(returned)).toBe(true);
    expect(isCrossChannelStop(returned)).toBe(false);
    // …and only STRICTLY later, and never against an explicit `unsubscribed`.
    expect(isCrossChannelStop({ ...returned, resubscribed_at: OPT_OUT_STAMP })).toBe(true);
    expect(isCrossChannelStop({ ...returned, status: 'unsubscribed' })).toBe(true);
  });

  it('the cross-channel reader and the opt-out module agree on the opt-out half', () => {
    // Two predicates, one record. isCrossChannelStop is deliberately WIDER —
    // it also stops on bounced/complained/suppressed, which are not opt-outs —
    // so the agreement asserted is over the opt-out shapes, in both directions.
    for (const [, doc] of OPTED_OUT_SHAPES) {
      expect(isNewsletterOptOutBinding(doc)).toBe(true);
      expect(isCrossChannelStop(doc)).toBe(true);
    }
    expect(isNewsletterOptOutBinding(STILL_SUBSCRIBED)).toBe(false);
    for (const status of ['bounced', 'complained', 'suppressed']) {
      expect(isCrossChannelStop({ status })).toBe(true);
      expect(isNewsletterOptOutBinding({ status })).toBe(false);
    }
  });

  it('normalises case and whitespace, like every other predicate in the module', () => {
    expect(isCrossChannelStop({ status: '  UNSUBSCRIBED ' })).toBe(true);
  });
});

describe('the boundary: `inactive` is NOT an opt-out and must not cross', () => {
  /**
   * The one distinction this fix had to get right. `unsubscribed` is a person
   * telling us to stop; `inactive` is list hygiene WE applied — the never-
   * engager sunset, on the newsletter document (scripts/lib/subscriberSunset
   * .mjs) or on the job-alert one (scripts/lib/jobAlertSunset.mjs), soft and
   * reversible in both. Crossing it would silence a job alert the recipient
   * created and still opens, on the strength of their ignoring a different
   * channel's weekly email.
   */
  it('newsletter `inactive` excludes the newsletter and nothing else', () => {
    expect(isNewsletterExcluded('inactive')).toBe(true);
    expect(isCrossChannelStop({ status: 'inactive' })).toBe(false);
  });

  it('the set is the address-level signals plus `unsubscribed`, and stops there', () => {
    expect([...CROSS_CHANNEL_STOP_STATUSES].sort()).toEqual(
      ['bounced', 'complained', 'suppressed', 'unsubscribed'],
    );
    expect(CROSS_CHANNEL_STOP_STATUSES.has('inactive')).toBe(false);
    // …and it is strictly narrower than the newsletter's own set, by exactly
    // the members that are OURS rather than the recipient's — the shape that
    // makes the difference reviewable.
    //
    // `inactive` is the never-engager sunset; `expired` (#5692) is an
    // unanswered double opt-in, closed after three requests one day apart.
    // Both are states we wrote about our own channel, neither is an
    // instruction the human gave, and neither may cross to the alert channel,
    // whose consent basis is a separate act the person performed themselves.
    const nlOnly = [...NEWSLETTER_EXCLUDED_STATUSES].filter((s) => !CROSS_CHANNEL_STOP_STATUSES.has(s)).sort();
    expect(nlOnly).toEqual(['expired', 'inactive']);
    expect(isCrossChannelStop({ status: 'expired' })).toBe(false);
  });

  it('a job-alert doc at `inactive` still stops its own channel', () => {
    // Unchanged by this PR, asserted so the narrowing above cannot be read as
    // a licence to stop honouring the alert channel's own sunset.
    expect(isJobAlertExcluded('inactive')).toBe(true);
  });
});

describe('nothing in the other collections authorises the send', () => {
  /**
   * The invariant the issue asks for, stated as the thing it actually is: an
   * opted-out address is reachable through the job-alert collection unless a
   * sender asks the newsletter document. Both other collections say "active",
   * truthfully — a newsletter opt-out is not supposed to write there, and the
   * one-directional propagation is the whole design.
   */
  it('the job-alert document and the saved search both say "send"', () => {
    expect(isJobAlertExcluded(THEIR_JOB_ALERT_DOC.status)).toBe(false);
    expect(THEIR_ALERT.active).toBe(true);
  });

  it('so the newsletter document is the only thing that can stop the send', () => {
    expect(isCrossChannelStop(CF_UNSUBSCRIBED)).toBe(true);
    expect(isCrossChannelStop(SPA_STAMP_ONLY)).toBe(true);
  });

  it('the alert channels write their opt-out on their OWN document, never here', () => {
    // Why the propagation cannot loop back: the reverse direction is out of
    // scope BY CONSTRUCTION, not by policy. jobAlertUnsubscribe stamps
    // `job_alert_subscribers/{email}/alerts/{id}` and savedJobsDigestUnsubscribe
    // stamps `users/{uid}` — so `unsubscribed_at` on a newsletter_subscribers
    // root document means the newsletter opt-out and nothing else, which is
    // what makes it safe to read cross-channel.
    for (const f of ['functions/src/jobAlertUnsubscribe.js', 'functions/src/savedJobsDigestUnsubscribe.js']) {
      expect(stripComments(read(f)), `${f} must not write newsletter_subscribers`)
        .not.toMatch(/newsletter_subscribers/);
    }
  });
});

describe('the senders, driven', () => {
  it('send-daily-brief: an opt-out beats job-alert membership, by status OR by stamp', () => {
    const nlRow = (doc: { email: string; status: string }) => ({
      email: doc.email, status: doc.status, locale: 'it', doc,
    });
    const { recipients, stats } = dedupeRecipients(
      [nlRow(CF_UNSUBSCRIBED), nlRow(SPA_STAMP_ONLY), nlRow(STILL_SUBSCRIBED)],
      [
        { email: OPTED_OUT, status: 'active', doc: { status: 'active' } },
        { email: STILL_IN, status: 'active', doc: { status: 'active' } },
      ],
    );
    expect(recipients.map((r: { email: string }) => r.email)).toEqual([STILL_IN]);
    expect(stats.optOutWins).toBe(1);
  });

  it('blast-publisher-ads: the paid-ad matcher drops the stamped document', () => {
    // minScore 0 so only the exclusion can decide — the control proves the
    // matcher would otherwise have taken both.
    const ad = { title: 'Test', locations: [], keywords: [] };
    const audience = matchSubscribersForAd(ad, [SPA_STAMP_ONLY, CF_UNSUBSCRIBED, STILL_SUBSCRIBED], { minScore: 0 });
    expect(audience.map((a: { email: string }) => a.email)).toEqual([STILL_IN]);
  });

  it('the backfill that MANUFACTURES alerts refuses an opted-out document', () => {
    // Not a sender, so it is outside the population scanned below — and the
    // aggravating half of #5688: 7.167 of 7.745 alerts were created from the
    // newsletter list rather than requested, so the path that creates them is
    // where an opt-out has to be honoured FIRST, before there is anything for
    // the sender to suppress.
    expect(shouldSkipSubscriber(OPTED_OUT, CF_UNSUBSCRIBED)).toBe('suppressed');
    expect(shouldSkipSubscriber(OPTED_OUT, SPA_STAMP_ONLY)).toBe('suppressed');
  });

  it('the lifecycle classifiers refuse to act on an opted-out document', () => {
    // Both tracks send real mail (sunset notice, win-back stage 1/2) and both
    // can flip a document back to mailable — `reactivate`, `reprobe`. The
    // opt-out is checked before either branch, so no lifecycle action can step
    // over it.
    const now = Date.parse('2026-08-12T00:00:00.000Z');
    const zombie = { ...SPA_STAMP_ONLY, send_count: 99, open_count: 0, click_count: 0, created_at: '2020-01-01T00:00:00.000Z' };
    expect(classifySunset(zombie, now).action).toBe('none');
    expect(classifyDormantWinback({ ...zombie, engagement_level: 'dormant' }, now).action).toBe('none');
    // And on an already-sunset document, where the `inactive` branch would
    // otherwise be free to resurrect it.
    expect(classifySunset({ ...zombie, status: 'inactive' }, now).action).toBe('none');
  });
});

/**
 * How each sender honours the record, or why it does not have to.
 *
 * Two gates, because two questions. A sender reading the newsletter document
 * for ITS OWN channel uses the channel set (which contains `unsubscribed` and
 * `inactive`) plus the stamp; a sender reading it for ANOTHER channel uses
 * isCrossChannelStop, which is the same rule minus `inactive`. Naming the gate
 * per file is what keeps the narrowing visible: swapping one for the other is
 * a policy change, and it changes which line of this table a file satisfies.
 */
type Verdict =
  | { verdict: 'cross-channel'; why: string; gateIn?: string }
  | { verdict: 'newsletter-channel'; why: string; gateIn?: string }
  /** Does not choose recipients from `newsletter_subscribers` at all. */
  | { verdict: 'not-a-broadcast'; why: string };

const VERDICTS: Record<string, Verdict> = {
  'scripts/send-job-alerts.mjs': {
    verdict: 'cross-channel',
    why: '#5688 — the channel this file was written for: 127 of 127 alerts survived the newsletter opt-out',
  },
  'scripts/send-company-alerts.mjs': {
    verdict: 'cross-channel',
    why: '#5688 — same defect, same batched two-collection lookup, found by the sibling grep rather than by a report',
  },
  'scripts/send-saved-jobs-digest.mjs': {
    verdict: 'cross-channel',
    why: '#5688 — the channel\'s own opt-out is users/{uid}.savedJobsDigest.optedOut; the newsletter document contributes the cross-channel stop and only that',
  },
  'scripts/send-newsletter.mjs': {
    verdict: 'newsletter-channel',
    why: 'the weekly campaign — its own channel, so the full NEWSLETTER_EXCLUDED_STATUSES, plus the stamp on both recipient paths (#5673)',
  },
  'scripts/send-daily-brief.mjs': {
    verdict: 'newsletter-channel',
    why: 'a broadcast of the same kind, and the channel where #5672 was measured: 49 of the 186 resurrected addresses received that day\'s edition',
  },
  'scripts/send-onboarding-drip.mjs': {
    verdict: 'newsletter-channel',
    why: 'post-signup drip over the newsletter collection (#4679)',
  },
  'scripts/blast-publisher-ads.mjs': {
    verdict: 'newsletter-channel',
    why: 'paid-ad blast over the whole collection — ordinary marketing on the newsletter channel',
    gateIn: 'services/publisherBlastMatch.mjs',
  },
  'scripts/newsletter-sunset.mjs': {
    verdict: 'newsletter-channel',
    why: 'the sunset notice is still mail, and the classifier can flip a document back to mailable — the opt-out is checked before either',
    gateIn: 'scripts/lib/subscriberSunset.mjs',
  },
  'scripts/newsletter-winback-campaign.mjs': {
    verdict: 'newsletter-channel',
    why: 'two-stage win-back at the dormant end of the engagement score — same reasoning as the sunset above',
    gateIn: 'scripts/lib/dormantWinback.mjs',
  },
  'scripts/send-cold-emails.mjs': {
    verdict: 'not-a-broadcast',
    why: 'employer outreach over employer_contacts — never touches the subscriber collections',
  },
  'scripts/preview-welcome-email.mjs': {
    verdict: 'not-a-broadcast',
    why: 'single --email preview tool: reads one doc by id to render it, and sends only to the address passed on the command line',
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

/** The recorded opt-out — every honouring file must reach it, through one of
 *  the two shared predicates and never through a field name of its own. */
const READS_OPT_OUT = /isNewsletterOptOutBinding\s*\(|isCrossChannelStop\s*\(/;
/** …and the status half, from the set appropriate to the channel. */
const GATE_BY_VERDICT: Record<string, RegExp> = {
  'cross-channel': /isCrossChannelStop\s*\(/,
  'newsletter-channel': /isNewsletterExcluded\s*\(|NEWSLETTER_EXCLUDED_STATUSES|MAILABLE_STATUSES/,
};

describe('every sender is classified', () => {
  const senders = discoverSenders();

  it('the discovery found the senders at all', () => {
    // Guards the scan itself: a broken filter would make every assertion below
    // pass vacuously.
    expect(senders.length).toBeGreaterThan(8);
    expect(senders).toContain('scripts/send-job-alerts.mjs');
    expect(senders).toContain('scripts/send-newsletter.mjs');
  });

  it('no sender is missing a verdict — a new channel must declare one here', () => {
    const undeclared = senders.filter((s) => !(s in VERDICTS));
    expect(
      undeclared,
      'a new sender must say whether a newsletter opt-out stops it, and by which gate',
    ).toEqual([]);
  });

  it('no verdict is stale — every entry still names a file that sends', () => {
    const orphaned = Object.keys(VERDICTS).filter((s) => !senders.includes(s));
    expect(orphaned, 'this entry no longer sends mail — delete it').toEqual([]);
  });
});

describe('the verdicts hold', () => {
  const entries = Object.entries(VERDICTS);
  const honouring = entries.filter(([, v]) => v.verdict !== 'not-a-broadcast');
  const notBroadcast = entries.filter(([, v]) => v.verdict === 'not-a-broadcast');

  it.each(honouring)('%s consults the recorded opt-out', (file, v) => {
    const where = ('gateIn' in v && v.gateIn) || file;
    const src = stripComments(read(where));
    expect(src, `${where} must read the recorded opt-out`).toMatch(READS_OPT_OUT);
    expect(src, `${where} must read the status half with the ${v.verdict} set`).toMatch(GATE_BY_VERDICT[v.verdict]);
    // From a shared module, never a local copy: a second definition is how two
    // channels come to disagree about who opted out.
    expect(read(where)).toMatch(/from '[^']*(emailSuppression|newsletterOptOut)\.(mjs|js)'/);
  });

  it.each(notBroadcast)('%s does not scan a subscriber collection', (file) => {
    const src = stripComments(read(file));
    expect(src).not.toMatch(/collection\('newsletter_subscribers'\)\s*\.\s*get\(\)/);
    expect(src).not.toMatch(/collection\('job_alert_subscribers'\)\s*\.\s*get\(\)/);
  });

  it('no sender hand-rolls the two spellings of the stamp', () => {
    // The construct that produced the drift: the check was copy-pasted into
    // send-newsletter (twice) and the onboarding drip, and the three senders
    // that needed it most never got a copy. One definition, or none.
    const offenders = discoverSenders().filter((s) => /unsubscribed_?[Aa]t/.test(stripComments(read(s))));
    expect(
      offenders,
      'read the opt-out through isNewsletterOptOutBinding()/isCrossChannelStop() instead of naming the fields',
    ).toEqual([]);
  });

  it('the opt-out rule has exactly one definition and one pinned mirror', () => {
    const dirs = ['services', 'scripts', 'scripts/lib', 'functions/src/lib'];
    const definers = dirs.flatMap((dir) =>
      readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(mjs|js|ts)$/.test(e.name))
        .map((e) => `${dir}/${e.name}`)
        .filter((rel) => /function isNewsletterOptOutBinding/.test(stripComments(read(rel)))),
    );
    // The mirror is deliberate — the Cloud Functions bundle cannot import
    // outside `functions/` — and its parity is asserted by
    // tests/newsletter-optout-supersession.test.ts. A THIRD copy is not.
    expect(definers.sort()).toEqual([
      'functions/src/lib/newsletterOptOut.js',
      'services/newsletterOptOut.mjs',
    ]);
    // And isCrossChannelStop must not grow its own: it delegates.
    expect(stripComments(read('functions/src/lib/emailSuppression.js')))
      .toMatch(/from '\.\/newsletterOptOut\.js'/);
  });
});
