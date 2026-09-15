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
  // The fixtures model subscribed rows. A double-opt-in stamp is deliberately
  // not part of the audience contract: the sender must still match rows that
  // have no proof, provided they are not suppressed or opted out.
  //
  // `consent_text` remains useful as an audit signal, but neither its page
  // version nor the optional advertising marker is a proof gate.
  const STAMP = '2026-01-01T00:00:00.000Z';
  const CONSENTED = {
    confirmed_at: STAMP,
    consent_advertising: true,
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

  it('returns matching subscribers sorted by score, excluding blank only', () => {
    const res = matchSubscribersForAd(fisioAd, subs, { minScore: 3 });
    const emails = res.map((r: { email: string }) => r.email);
    expect(emails).toContain('a@x.ch');
    expect(emails).toContain('b@x.ch');
    expect(emails).not.toContain('c@x.ch'); // construction
    expect(emails).not.toContain('d@x.ch'); // an explicit unsubscribe stops advertising too
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

    it('keeps perfect matches regardless of confirmation stamp or status word', () => {
      const rows = [
        { email: 'stamped@example.com', ...strongMatch, ...CONSENTED },
        { email: 'never-confirmed@example.com', ...strongMatch, ...CONSENTED, confirmed_at: undefined, status: 'pending' },
        { email: 'claims-confirmed@example.com', ...strongMatch, ...CONSENTED, confirmed_at: undefined, status: 'confirmed' },
      ];
      const emails = matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);
      expect(emails).toEqual([
        'stamped@example.com',
        'never-confirmed@example.com',
        'claims-confirmed@example.com',
      ]);
    });

    it('does not use confirmation or resubscribe timestamps as a delivery gate', () => {
      const rows = [
        { email: 'toggled@example.com', ...strongMatch, ...CONSENTED, status: 'subscribed', resubscribed_at: STAMP },
        { email: 'link-only@example.com', ...strongMatch, ...CONSENTED, confirmed_at: undefined, status: 'subscribed', resubscribed_at: STAMP },
      ];
      const emails = matchSubscribersForAd(fisioAd, rows, { minScore: 3 }).map((r: { email: string }) => r.email);
      expect(emails).toEqual(['toggled@example.com', 'link-only@example.com']);
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
   * Third-party advertising is a separately manageable category. The page and
   * preference centre record it, but the absence of a marker is not a delivery
   * gate under the whole-list policy.
   *
   * The page-version comparison remains an audit signal only. Explicit
   * advertising opt-out is the only category-specific refusal.
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
      // The stored page version is audit-only. Older, missing and unparseable
      // disclosures remain eligible like every other subscribed row.
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

    it('allows an absent advertising marker and still honours the switch', () => {
      expect(emails([
        { email: 'off@example.com', ...strongMatch, ...CONSENTED, advertising_opt_out: true },
        { email: 'left-on@example.com', ...strongMatch, ...CONSENTED, advertising_opt_out: false },
        { email: 'never-asked@example.com', ...strongMatch, ...CONSENTED, consent_advertising: undefined },
      ]).sort()).toEqual(['left-on@example.com', 'never-asked@example.com']);
    });
  });

  /**
   * The explicit advertising choice is only one of the gates. The other gates
   * — the per-channel withdrawal, a global opt-out and hard suppression — must
   * continue to apply independently. Each case below
   * ships with a control identical apart from the field under test, so a green
   * test cannot be explained by the matcher rejecting everybody.
   */
  describe('the gates that must still hold with purpose-specific advertising consent', () => {
    const strongMatch = { job_search_query: 'Fisioterapista diplomato/a', sector_interest: 'health' };
    /** A proof from BEFORE advertising was named: still eligible with explicit ad consent. */
    const ANCIENT = {
      confirmed_at: '2026-01-01T00:00:00.000Z',
      consent_advertising: true,
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

    it('a global opt-out still stops it — the explicit global field is authoritative', () => {
      // The stop-all action writes a dedicated cross-channel field, which is
      // authoritative even when a category field says advertising is on.
      expect(emails([
        control,
        { email: 'canonical@example.com', ...strongMatch, ...ANCIENT, all_email_opted_out: true },
        { email: 'alias@example.com', ...strongMatch, ...ANCIENT, global_email_opted_out: true },
        { email: 'newsletter-only@example.com', ...strongMatch, ...ANCIENT, status: 'unsubscribed' },
      ])).toEqual(['control@example.com']);
    });

    it('allows only an explicit later advertising reactivation after a newsletter opt-out', () => {
      expect(emails([
        control,
        {
          email: 'still-off@example.com',
          ...strongMatch,
          ...ANCIENT,
          status: 'unsubscribed',
          unsubscribed_at: '2026-09-02T00:00:00.000Z',
          advertising_opt_out: false,
          advertising_opt_out_updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          email: 'ads-on@example.com',
          ...strongMatch,
          ...ANCIENT,
          status: 'unsubscribed',
          unsubscribed_at: '2026-09-01T00:00:00.000Z',
          advertising_opt_out: false,
          advertising_opt_out_updated_at: '2026-09-02T00:00:00.000Z',
        },
        {
          email: 'ads-on-legacy-status-only@example.com',
          ...strongMatch,
          ...ANCIENT,
          status: 'unsubscribed',
          advertising_opt_out: false,
          advertising_reactivated_at: '2026-09-02T00:00:00.000Z',
        },
      ]).sort()).toEqual([
        'ads-on-legacy-status-only@example.com',
        'ads-on@example.com',
        'control@example.com',
      ]);
    });

    it('a hard suppression still stops it — bounced, complained, suppressed', () => {
      expect(emails([
        control,
        { email: 'bounced@example.com', ...strongMatch, ...ANCIENT, status: 'bounced' },
        { email: 'complained@example.com', ...strongMatch, ...ANCIENT, status: 'complained' },
        { email: 'suppressed@example.com', ...strongMatch, ...ANCIENT, status: 'SUPPRESSED' },
      ])).toEqual(['control@example.com']);
    });

    it('does not require a double opt-in stamp for pending or confirmed rows', () => {
      expect(emails([
        control,
        { email: 'pending@example.com', ...strongMatch, ...ANCIENT, confirmed_at: undefined, status: 'pending' },
        { email: 'claims@example.com', ...strongMatch, ...ANCIENT, confirmed_at: undefined, status: 'confirmed' },
      ])).toEqual(['control@example.com', 'pending@example.com', 'claims@example.com']);
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
