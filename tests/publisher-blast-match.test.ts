import { describe, it, expect } from 'vitest';
import {
  scoreSubscriberForAd,
  matchSubscribersForAd,
} from '../services/publisherBlastMatch.mjs';

const fisioAd = {
  title: 'Fisioterapista diplomato/a',
  category: 'health',
  sector: 'sanità',
  locations: [{ label: 'Lugano' }],
};

describe('scoreSubscriberForAd', () => {
  it('scores high for a matching job_search_query', () => {
    const s = scoreSubscriberForAd(fisioAd, { job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health' });
    expect(s).toBeGreaterThanOrEqual(8);
  });

  it('scores category/sector alignment', () => {
    const s = scoreSubscriberForAd(fisioAd, { sector_interest: 'health' });
    expect(s).toBeGreaterThanOrEqual(3);
  });

  it('returns 0 for an unrelated subscriber', () => {
    expect(scoreSubscriberForAd(fisioAd, { job_search_query: 'muratore edile', sector_interest: 'construction' })).toBe(0);
  });

  it('handles malformed input', () => {
    expect(scoreSubscriberForAd(null, {})).toBe(0);
    expect(scoreSubscriberForAd(fisioAd, null)).toBe(0);
    expect(scoreSubscriberForAd({ title: '' }, { job_search_query: 'x' })).toBe(0);
  });
});

describe('matchSubscribersForAd', () => {
  // Every fixture below carries the double-opt-in stamp, because since #5686 a
  // row without one is not a recipient at all — see the consent-gate block at
  // the bottom of this file.
  //
  // …and since #5759 it also carries a `consent_text` naming a page version at
  // or after the one that named third-party advertising. Same reasoning, one
  // gate later: a row whose stored disclosure never mentioned advertising is
  // not a recipient of an ad blast either. Spreading `CONSENTED` into the
  // fixtures rather than leaving them bare is what keeps the tests below about
  // what they say they are about — without it every expectation here would be
  // satisfied by the new gate and would assert nothing about scoring,
  // suppression or the cap.
  const STAMP = '2026-01-01T00:00:00.000Z';
  const CONSENTED = {
    confirmed_at: STAMP,
    consent_text:
      'Iscrivo il mio indirizzo alle comunicazioni di Frontaliere Ticino. Cosa ricevo, con che frequenza, come disdire e chi tratta i dati: frontaliereticino.ch/comunicazioni (versione 2026-08-13.2).',
  };
  const subs = [
    { email: 'a@x.ch', job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health', locale: 'it', ...CONSENTED },
    { email: 'b@x.ch', sector_interest: 'health', locale: 'de', ...CONSENTED },
    { email: 'c@x.ch', job_search_query: 'muratore', sector_interest: 'construction', ...CONSENTED },
    { email: 'd@x.ch', job_search_query: 'Fisioterapista', status: 'unsubscribed', ...CONSENTED },
    { email: '', job_search_query: 'Fisioterapista', ...CONSENTED },
  ];

  it('returns matching subscribers sorted by score, excluding unsubscribed/blank', () => {
    const res = matchSubscribersForAd(fisioAd, subs, { minScore: 3 });
    const emails = res.map((r: { email: string }) => r.email);
    expect(emails).toContain('a@x.ch');
    expect(emails).toContain('b@x.ch');
    expect(emails).not.toContain('c@x.ch'); // construction
    expect(emails).not.toContain('d@x.ch'); // unsubscribed
    expect(emails).not.toContain(''); // blank
    // a (direct query) ranks above b (sector only)
    expect(res[0].email).toBe('a@x.ch');
  });

  it('respects the max cap', () => {
    expect(matchSubscribersForAd(fisioAd, subs, { minScore: 3, max: 1 })).toHaveLength(1);
  });

  it('minScore filters weak matches', () => {
    expect(matchSubscribersForAd(fisioAd, subs, { minScore: 9 }).every((r: { score: number }) => r.score >= 9)).toBe(true);
  });

  // Regression: the old filter checked the literal 'complaint' (an event-type
  // name, never a subscriber status value) and omitted 'suppressed', so
  // complained/suppressed recipients were still blasted. They must be excluded.
  it('excludes hard-suppressed statuses (bounced/complained/suppressed)', () => {
    const hard = [
      { email: 'match@x.ch', job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health', ...CONSENTED },
      { email: 'bounced@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'bounced', ...CONSENTED },
      { email: 'complained@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'complained', ...CONSENTED },
      { email: 'suppressed@x.ch', job_search_query: 'Fisioterapista diplomato/a', status: 'SUPPRESSED', ...CONSENTED },
    ];
    const emails = matchSubscribersForAd(fisioAd, hard, { minScore: 3 }).map((r: { email: string }) => r.email);
    expect(emails).toEqual(['match@x.ch']);
  });

  /**
   * The consent half (#5686). A paid-ad blast is ordinary marketing whose
   * audience is the whole newsletter_subscribers collection, so it was reached
   * by exactly the defect the weekly newsletter had: the suppression Set above
   * says who opted OUT and says nothing about who ever opted IN.
   */
  describe('the consent gate', () => {
    const strongMatch = { job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health' };

    it('drops a perfect match that carries no confirmation stamp', () => {
      const rows = [
        { email: 'stamped@example.com', ...strongMatch, ...CONSENTED },
        { email: 'never-confirmed@example.com', ...strongMatch, ...CONSENTED, confirmed_at: undefined, status: 'pending' },
        { email: 'claims-confirmed@example.com', ...strongMatch, ...CONSENTED, confirmed_at: undefined, status: 'confirmed' },
      ];
      const emails = matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);
      expect(emails).toEqual(['stamped@example.com']);
    });

    it('follows the toggle: `subscribed` passes with the stamp, not with resubscribed_at alone', () => {
      // The #5686 review finding, checked on THIS channel rather than assumed:
      // the blast shares the gate, so the authenticated preferences toggle had
      // to start writing `confirmed_at` for these people to keep matching. The
      // resubscribe LINK writes only `resubscribed_at` — a bare GET a scanner
      // follows — and must stay out.
      const rows = [
        { email: 'toggled@example.com', ...strongMatch, ...CONSENTED, status: 'subscribed', resubscribed_at: STAMP },
        { email: 'link-only@example.com', ...strongMatch, ...CONSENTED, confirmed_at: undefined, status: 'subscribed', resubscribed_at: STAMP },
      ];
      const emails = matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);
      expect(emails).toEqual(['toggled@example.com']);
    });

    it('keeps a `pending` row that DOES carry the stamp — the deliverability re-probe', () => {
      // scripts/mailtrap-suppression-retry.mjs writes status:'pending' on a
      // previously-confirmed address to make the cascade retry the mailbox.
      // Keying on the word instead of the stamp would drop those people.
      const rows = [{ email: 'reprobe@example.com', ...strongMatch, ...CONSENTED, confirmed_at: undefined, status: 'pending', confirmedAt: STAMP }];
      const emails = matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);
      expect(emails).toEqual(['reprobe@example.com']);
    });
  });

  /**
   * The advertising half (#5759), at unit level.
   *
   * The owner's decision of 2026-08-13 makes third-party advertising a consent
   * category collected as an OPT-OUT: nobody ticks a box for it, so what stands
   * in for the tick is a formula that names it and a switch that stops it. This
   * function is where both become a fact about who receives mail.
   *
   * AND THE HALF THAT WAS TAKEN AWAY ON 2026-08-14. #5759 also refused anyone
   * whose stored proof predated the page version that named advertising. The
   * owner was told what that meant — effectively the whole list — and decided
   * the disclosure reaches back over all of it. The first test below is the
   * former one turned around, and it is written as an assertion rather than
   * deleted precisely so that tomorrow the reach reads as a decision somebody
   * took and not as a filter somebody lost.
   *
   * The contract-level version of the same claim — that the naming and the
   * switch cannot ship without each other — lives in
   * tests/consent-shown-at-signup.test.tsx, which is where the guard that used
   * to FORBID the naming was turned around.
   */
  describe('the advertising gate', () => {
    const strongMatch = { job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health' };
    const emails = (rows: Array<Record<string, unknown>>) =>
      matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);

    it('reaches a match whose stored disclosure predates the page that named advertising', () => {
      // THE DECISION, PINNED. Each of these three shapes was excluded until
      // 2026-08-14: an older page version, no `consent_text` at all (8.505 of
      // 8.605 documents, measured 2026-08-12), a text with no version in it.
      // They are now recipients like anybody else, and this expectation exists
      // so that a future reader finds the choice recorded instead of inferring
      // a regression from a missing check.
      const older = CONSENTED.consent_text.replace('2026-08-13.2', '2026-08-13.1');
      expect(emails([
        { email: 'old@example.com', ...strongMatch, ...CONSENTED, consent_text: older },
        { email: 'none@example.com', ...strongMatch, ...CONSENTED, consent_text: undefined },
        { email: 'no-version@example.com', ...strongMatch, ...CONSENTED, consent_text: 'Accetto le comunicazioni.' },
        { email: 'told@example.com', ...strongMatch, ...CONSENTED },
      ]).sort()).toEqual(['no-version@example.com', 'none@example.com', 'old@example.com', 'told@example.com']);
    });

    it('reports, per recipient, whether their own proof named advertising', () => {
      // The cost of the decision above, made countable. Reporting is not
      // enforcing, and the difference is the whole point: `consentCoversAdvertising`
      // no longer looks at this, `scripts/blast-publisher-ads.mjs` logs it.
      const older = CONSENTED.consent_text.replace('2026-08-13.2', '2026-08-13.1');
      const rows = matchSubscribersForAd(
        fisioAd,
        [
          { email: 'told@example.com', ...strongMatch, ...CONSENTED },
          { email: 'untold@example.com', ...strongMatch, ...CONSENTED, consent_text: older },
          { email: 'no-proof@example.com', ...strongMatch, ...CONSENTED, consent_text: undefined },
        ],
        { minScore: 3 },
      ) as Array<{ email: string; toldAboutAdvertising: boolean }>;
      expect(Object.fromEntries(rows.map((r) => [r.email, r.toldAboutAdvertising]))).toEqual({
        'told@example.com': true,
        'untold@example.com': false,
        'no-proof@example.com': false,
      });
    });

    it('drops the reader who used the switch, and only on an explicit true', () => {
      // `false` is not absence: the preference centre writes it when somebody
      // looked at the switch and left it on. That is evidence, and evidence
      // must not change who gets the mail.
      expect(emails([
        { email: 'off@example.com', ...strongMatch, ...CONSENTED, advertising_opt_out: true },
        { email: 'left-on@example.com', ...strongMatch, ...CONSENTED, advertising_opt_out: false },
        { email: 'never-asked@example.com', ...strongMatch, ...CONSENTED },
      ]).sort()).toEqual(['left-on@example.com', 'never-asked@example.com']);
    });
  });

  /**
   * WHAT MUST STILL HOLD NOW THAT THE VERSION FILTER IS GONE.
   *
   * "Advertising may reach the whole list" was a decision about ONE gate. The
   * others — the per-channel switch, a global opt-out, a hard suppression, the
   * double-opt-in stamp — are not that decision, and the way a relaxation goes
   * wrong is by taking more than it was given: each of those is checked in the
   * same loop, one `continue` away from the line that was changed.
   *
   * Every case below therefore ships with a CONTROL that is identical except
   * for the one field under test, and the control's `consent_text` is a version
   * OLDER than the naming — so a control that is admitted proves the relaxation
   * really is in force, and a case that is dropped proves the drop is the field
   * and not a leftover of the removed filter. Without the control both halves
   * would pass on a matcher that rejected everybody.
   */
  describe('the gates that must still hold after the relaxation (owner decision 2026-08-14)', () => {
    const strongMatch = { job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health' };
    /** A proof from BEFORE advertising was named: admitted since 2026-08-14. */
    const ANCIENT = {
      confirmed_at: '2026-01-01T00:00:00.000Z',
      consent_text:
        'Inserendo il mio indirizzo email nel modulo della newsletter, chiedo di ricevere la newsletter per frontalieri. (versione 2026-08-12.1)',
    };
    const emails = (rows: Array<Record<string, unknown>>) =>
      matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);
    /** The control, restated in every case so no test can pass by dropping both rows. */
    const control = { email: 'control@example.com', ...strongMatch, ...ANCIENT };

    it('the per-channel switch still stops it, on a document old enough to have been excluded before', () => {
      expect(emails([
        control,
        { email: 'switched-off@example.com', ...strongMatch, ...ANCIENT, advertising_opt_out: true },
      ])).toEqual(['control@example.com']);
    });

    it('a global opt-out still stops it — in both spellings of the stamp, and on status alone', () => {
      // The three shapes `isNewsletterOptOutBinding` exists for (#5673, #5688):
      // the Cloud Function status, the SPA camelCase stamp, the snake_case one.
      // A person who asked us to stop is not an advertising audience whatever
      // the owner decided about the disclosure.
      expect(emails([
        control,
        { email: 'status@example.com', ...strongMatch, ...ANCIENT, status: 'unsubscribed' },
        { email: 'camel@example.com', ...strongMatch, ...ANCIENT, unsubscribedAt: '2026-02-01T00:00:00.000Z' },
        { email: 'snake@example.com', ...strongMatch, ...ANCIENT, unsubscribed_at: '2026-02-01T00:00:00.000Z' },
      ])).toEqual(['control@example.com']);
    });

    it('a hard suppression still stops it — bounced, complained, suppressed', () => {
      expect(emails([
        control,
        { email: 'bounced@example.com', ...strongMatch, ...ANCIENT, status: 'bounced' },
        { email: 'complained@example.com', ...strongMatch, ...ANCIENT, status: 'complained' },
        { email: 'suppressed@example.com', ...strongMatch, ...ANCIENT, status: 'SUPPRESSED' },
      ])).toEqual(['control@example.com']);
    });

    it('the double opt-in stamp is still required — an unconfirmed address is not reached', () => {
      // #5686. The relaxed gate is about WHAT they were told, not about whether
      // they ever completed a subscription: a `confirmed` word with no stamp
      // behind it is the shape that mailed 1.488 addresses.
      expect(emails([
        control,
        { email: 'pending@example.com', ...strongMatch, ...ANCIENT, confirmed_at: undefined, status: 'pending' },
        { email: 'claims@example.com', ...strongMatch, ...ANCIENT, confirmed_at: undefined, status: 'confirmed' },
      ])).toEqual(['control@example.com']);
    });

    it('an opt-out and an ancient proof together are still one drop, not a cancellation', () => {
      // The combination is the one a "send to everybody" change is most likely
      // to get wrong: the relaxation admits the proof, and the switch must
      // still be read afterwards rather than treated as satisfied by it.
      expect(emails([
        control,
        { email: 'both@example.com', ...strongMatch, ...ANCIENT, advertising_opt_out: true, status: 'unsubscribed' },
      ])).toEqual(['control@example.com']);
    });
  });
});
