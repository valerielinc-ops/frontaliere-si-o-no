/**
 * The double opt-in request of a job-gate signup names the job (L2
 * jobgate-confirm, 2026-09-24).
 *
 * Measured on the 408 `job_board_email_unlock` signups of the previous 30
 * days: request sent to 100%, delivered to 92%, opened by 67%, confirmed by
 * 33%. 148 of them opened (after >10 s, not a proxy prefetch) and never
 * clicked. The generic request thanked them for "subscribing to the
 * newsletter" — they had typed an email to see a job. These tests pin the
 * contextual variant and, just as much, everything it must NOT change: the
 * link, the frame rule, the generic email for every other surface.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveConfirmationJobContext,
  sanitizeConfirmationJobTitle,
  jobTitleFromSource,
  jobFieldsFromTitleSignup,
  parseJobSource,
  readConfirmationJobSnapshot,
  confirmationJobContextForSend,
  sanitizeConfirmationReturnPath,
  CONFIRMATION_JOB_CONTEXT_FIELD,
  CONFIRMATION_JOB_CONTEXT_KINDS,
} from '../functions/src/lib/confirmationJobContext.js';
import { buildConfirmationSentFields } from '../functions/src/lib/confirmationFollowup.js';
import {
  buildConfirmationRequestEmail,
  buildNewsletterConfirmationEmailHtml,
  confirmationEmailSubject,
  confirmationReminderBanner,
  CONFIRMATION_FRAMES,
} from '../functions/src/lib/confirmationEmailContent.js';
import { t } from '../functions/src/emailI18n.js';
import { buildFollowupRequest } from '../scripts/newsletter-confirmation-followups.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const JOB_URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/driver-kulm-hotel/?action=confirm_newsletter&email=a%40b.ch&token=x';
const ROOT_URL = 'https://frontaliereticino.ch?action=confirm_newsletter&email=a%40b.ch&token=x';

// The signup that created the document also started its cycle, in the same
// write: the two stamps are equal (see jobFieldsFromTitleSignup).
const SIGNED_UP_AT = new Date(Date.now() - 3600e3).toISOString();
const jobGateDoc = (overrides: Record<string, any> = {}) => ({
  email: 'j@example.com',
  status: 'pending',
  isActive: false,
  created_at: SIGNED_UP_AT,
  confirmation_cycle_started_at: SIGNED_UP_AT,
  source: 'job_gate:Kulm Hotel St. Moritz:Driver (m/w/d)',
  source_cta: 'job_board_email_unlock',
  source_channel: 'job_gate',
  source_page: '/cerca-lavoro-ticino/driver-kulm-hotel/',
  job_company: 'Kulm Hotel St. Moritz',
  job_location: 'Pontresina, Switzerland',
  location_interest: 'Pontresina',
  ...overrides,
});

describe('resolveConfirmationJobContext: which offer, if any', () => {
  it('reads title, company and location from a job-gate document', () => {
    expect(resolveConfirmationJobContext(jobGateDoc())).toEqual({
      kind: 'unlocked',
      title: 'Driver (m/w/d)',
      company: 'Kulm Hotel St. Moritz',
      location: 'Pontresina',
    });
  });

  it('marks the expired-offer surface as expired', () => {
    const ctx = resolveConfirmationJobContext(jobGateDoc({ source_cta: 'job_expired_email_unlock' }));
    expect(ctx?.kind).toBe('expired');
  });

  it('keeps a title that itself contains a colon, using job_company as the separator', () => {
    const ctx = resolveConfirmationJobContext(
      jobGateDoc({ source: 'job_gate:Acme SA:Tecnico edile: manutenzione (m/f/d)', job_company: 'Acme SA' }),
    );
    expect(ctx?.title).toBe('Tecnico edile: manutenzione (m/f/d)');
  });

  it('marks a title cut at 60 characters by the client with an ellipsis, never mid-word', () => {
    const cut = 'Celonis CoE - Senior Value Engineer Hitachi Energy Zurich Sw';
    expect(cut).toHaveLength(60);
    expect(sanitizeConfirmationJobTitle(cut, { truncated: true })).toBe('Celonis CoE - Senior Value Engineer Hitachi Energy Zurich…');
  });

  it('returns null — the generic email — for every surface not on the allowlist', () => {
    for (const cta of ['newsletter_popup_submit', 'company_follow_button', 'job_orphan_email_unlock', 'signup', '', undefined]) {
      expect(resolveConfirmationJobContext(jobGateDoc({ source_cta: cta })), String(cta)).toBeNull();
    }
    expect(Object.keys(CONFIRMATION_JOB_CONTEXT_KINDS)).toContain('job_board_email_unlock');
  });

  it('returns null when neither title nor company survives sanitization', () => {
    expect(resolveConfirmationJobContext(jobGateDoc({ source: 'job_gate_email', job_company: null }))).toBeNull();
    expect(
      resolveConfirmationJobContext(jobGateDoc({ source: 'job_gate:<b>x</b>:<script>', job_company: '<b>x</b>' })),
    ).toBeNull();
  });

  it('refuses titles that could inject or spoof', () => {
    for (const bad of ['<img src=x>', 'Visit https://evil.test', 'mail me@x.ch', '‮evil', '--', '42']) {
      expect(sanitizeConfirmationJobTitle(bad), bad).toBeNull();
    }
  });

  it('never throws, whatever the document', () => {
    for (const junk of [null, undefined, 42, 'x', [], { source_cta: 'job_board_email_unlock', source: 7 }]) {
      expect(() => resolveConfirmationJobContext(junk as any)).not.toThrow();
    }
    expect(jobTitleFromSource({ source: 'popup' })).toBeNull();
  });
});

describe('the contextual request, in each of the four languages', () => {
  const ctx = resolveConfirmationJobContext(jobGateDoc());

  it('names the offer in subject, intro and button, and keeps the single confirm link', () => {
    for (const locale of LOCALES) {
      const req = buildConfirmationRequestEmail({ locale, confirmUrl: JOB_URL, jobContext: ctx });
      expect(req.subject, locale).toContain('Driver (m/w/d)');
      expect(req.subject, locale).not.toBe(t(locale, 'confirmSubject'));
      expect(req.html, locale).toContain('Kulm Hotel St. Moritz');
      expect(req.html, locale).toContain('Pontresina');
      expect(req.html, locale).toContain(t(locale, 'confirmJobButton'));
      expect(req.html, locale).toContain(t(locale, 'confirmJobReturn'));
      expect(req.html, locale).not.toContain(t(locale, 'confirmIntro'));
      // Same single link as the generic request: the confirm URL, twice (button
      // + fallback text), plus the two brand links in header and footer.
      const generic = buildConfirmationRequestEmail({ locale, confirmUrl: JOB_URL });
      const hrefs = (html: string) => (html.match(/href="([^"]*)"/g) || []).sort();
      expect(hrefs(req.html), locale).toEqual(hrefs(generic.html));
      expect(req.tags).toContainEqual({ name: 'context', value: 'job' });
      expect(req.tags).toContainEqual({ name: 'campaign_id', value: 'confirmation' });
    }
  });

  it('every job key exists in every locale (no Italian fallback in a German email)', () => {
    const keys = [
      'confirmJobSubjectTitle', 'confirmJobSubjectCompany', 'confirmJobReminderPrefix',
      'confirmJobReminderLastPrefix', 'confirmJobLabelTitleCompany', 'confirmJobLabelTitle',
      'confirmJobLabelCompany', 'confirmJobIntroUnlocked', 'confirmJobIntroExpired',
      'confirmJobWhere', 'confirmJobReturn', 'confirmJobButton',
    ];
    for (const key of keys) {
      const values = LOCALES.map((l) => t(l, key));
      for (const v of values) expect(v, key).not.toBe(key);
      expect(new Set(values).size, key).toBe(LOCALES.length);
    }
  });

  it('does not promise a return to the job when the link lands on the home page', () => {
    for (const locale of LOCALES) {
      const html = buildNewsletterConfirmationEmailHtml(ROOT_URL, locale, { jobContext: ctx });
      expect(html, locale).not.toContain(t(locale, 'confirmJobReturn'));
    }
  });

  it('the expired variant says the offer is gone and makes no return promise', () => {
    const expired = resolveConfirmationJobContext(jobGateDoc({ source_cta: 'job_expired_email_unlock' }));
    for (const locale of LOCALES) {
      const html = buildNewsletterConfirmationEmailHtml(JOB_URL, locale, { jobContext: expired });
      const lead = t(locale, 'confirmJobIntroExpired').split('{job}')[0];
      expect(html, locale).toContain(lead);
      expect(html, locale).not.toContain(t(locale, 'confirmJobReturn'));
    }
  });

  it('company-only context uses the company subject and label', () => {
    const companyOnly = { kind: 'unlocked', title: null, company: 'Siegfried', location: null } as const;
    for (const locale of LOCALES) {
      expect(confirmationEmailSubject(locale, { jobContext: companyOnly }), locale).toContain('Siegfried');
      const html = buildNewsletterConfirmationEmailHtml(JOB_URL, locale, { jobContext: companyOnly });
      expect(html, locale).toContain('<strong>Siegfried</strong>');
      expect(html, locale).not.toContain('{where}');
      expect(html, locale).not.toContain('{job}');
    }
  });

  it('escapes the title in the body and the <title>, and is immune to $-patterns', () => {
    const nasty = { kind: 'unlocked', title: 'R&D "Lead" $& co', company: 'A & B', location: null } as const;
    const html = buildNewsletterConfirmationEmailHtml(JOB_URL, 'it', { jobContext: nasty });
    expect(html).toContain('R&amp;D &quot;Lead&quot; $&amp; co');
    expect(html).toContain('A &amp; B');
    expect(html).not.toContain('R&D "Lead"');
    expect(confirmationEmailSubject('it', { jobContext: nasty })).toBe('Offerte simili a «R&D "Lead" $& co»: conferma la tua email');
  });

  it('a login link ignores the job context entirely', () => {
    const req = buildConfirmationRequestEmail({ locale: 'it', confirmUrl: JOB_URL, login: true, jobContext: ctx });
    expect(req.html).not.toContain('Driver');
    expect(req.tags).not.toContainEqual({ name: 'context', value: 'job' });
  });

  it('without a job context the request is byte-identical to the generic one', () => {
    for (const locale of LOCALES) {
      const a = buildConfirmationRequestEmail({ locale, confirmUrl: JOB_URL });
      const b = buildConfirmationRequestEmail({ locale, confirmUrl: JOB_URL, jobContext: null });
      expect(b).toEqual(a);
      expect(a.subject).toBe(t(locale, 'confirmSubject'));
      expect(a.tags.map((x) => x.name)).not.toContain('context');
    }
  });
});

describe('reminders of a job-gate signup: request #1 plus a banner, nothing more', () => {
  const FIRST_SENT = Date.parse('2026-09-20T09:15:00.000Z');
  const ctx = resolveConfirmationJobContext(jobGateDoc());

  it('the contextual body below the banner is request #1, byte for byte', () => {
    for (const locale of LOCALES) {
      const first = buildNewsletterConfirmationEmailHtml(JOB_URL, locale, { jobContext: ctx });
      for (const frame of [CONFIRMATION_FRAMES.REMINDER, CONFIRMATION_FRAMES.LAST]) {
        const framed = buildNewsletterConfirmationEmailHtml(JOB_URL, locale, { frame, firstSentAt: FIRST_SENT, jobContext: ctx });
        const banner = confirmationReminderBanner(locale, { frame, firstSentAt: FIRST_SENT });
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        const subjFramed = esc(confirmationEmailSubject(locale, { frame, jobContext: ctx }));
        const subjFirst = esc(confirmationEmailSubject(locale, { jobContext: ctx }));
        expect(framed.replace(banner, '').replace(subjFramed, subjFirst), `${locale}/${frame}`).toBe(first);
      }
    }
  });

  it('the reminder subject is the first subject with the frame prefix', () => {
    for (const locale of LOCALES) {
      const first = confirmationEmailSubject(locale, { jobContext: ctx });
      expect(confirmationEmailSubject(locale, { frame: CONFIRMATION_FRAMES.REMINDER, jobContext: ctx }))
        .toBe(`${t(locale, 'confirmJobReminderPrefix')}${first}`);
      expect(confirmationEmailSubject(locale, { frame: CONFIRMATION_FRAMES.LAST, jobContext: ctx }))
        .toBe(`${t(locale, 'confirmJobReminderLastPrefix')}${first}`);
    }
  });

  it('the follow-up runner composes reminders with the same job context as request #1', () => {
    for (const [attempt, frame] of [[2, CONFIRMATION_FRAMES.REMINDER], [3, CONFIRMATION_FRAMES.LAST]] as const) {
      const req = buildFollowupRequest(
        {
          id: 'j@example.com',
          data: jobGateDoc({
            preferred_locale: 'de',
            confirmation_attempts: attempt - 1,
            confirmation_first_sent_at: new Date(FIRST_SENT).toISOString(),
          }),
          decision: { action: 'send', attempt, attempts: attempt - 1, reason: 'reminder' },
        } as any,
        { secret: 'test-secret' },
      );
      expect(req.meta.frame).toBe(frame);
      expect(req.payload.subject).toContain('Driver (m/w/d)');
      expect(req.payload.html).toContain(t('de', 'confirmJobButton'));
      expect(req.payload.html).toContain(t('de', 'confirmJobReturn'));
      expect(String(req.payload.html)).toContain('/cerca-lavoro-ticino/driver-kulm-hotel/?action=confirm_newsletter');
      expect(req.payload.tags).toContainEqual({ name: 'context', value: 'job' });
    }
  });

  it('a non-job pending document still gets the generic reminder', () => {
    const req = buildFollowupRequest(
      {
        id: 'p@example.com',
        data: {
          status: 'pending',
          created_at: new Date().toISOString(),
          source_cta: 'newsletter_popup_submit',
          preferred_locale: 'it',
          confirmation_attempts: 1,
          confirmation_first_sent_at: new Date(FIRST_SENT).toISOString(),
        },
        decision: { action: 'send', attempt: 2, attempts: 1, reason: 'reminder' },
      } as any,
      { secret: 'test-secret' },
    );
    expect(req.payload.subject).toBe(t('it', 'confirmReminderSubject'));
    expect(req.payload.tags).not.toContainEqual({ name: 'context', value: 'job' });
  });
});

// ── One offer per email, and the same offer for the whole cycle (#9716 nit) ──
//
// Measured 2026-09-25 on the 2,962 job-gate documents: `source` (the title) is
// first-touch, `job_company`/`job_location`/`source_cta`/`source_page` are
// last-touch. 18 documents held a title and a company from two different
// offers and resolved to an email naming both; in 35 cycles the offer changed
// between request #1 and the last reminder, which re-read the document.

/** Offer B, signed up for after offer A: every last-touch field moves to B. */
const secondOffer = {
  job_company: 'Siegfried AG',
  job_location: 'Zofingen, Switzerland',
  location_interest: 'Zofingen',
  source_page: '/cerca-lavoro-ticino/chemist-siegfried/',
};

describe('title and company always come from the same offer', () => {
  it('a document mixing two offers produces no context — never «A presso B»', () => {
    const mixed = jobGateDoc(secondOffer);
    expect(parseJobSource(mixed)).toEqual({ title: null, mixed: true });
    expect(resolveConfirmationJobContext(mixed)).toBeNull();
    // What the email then is: the generic request, byte for byte.
    const req = buildConfirmationRequestEmail({ locale: 'it', confirmUrl: JOB_URL, jobContext: resolveConfirmationJobContext(mixed) });
    expect(req).toEqual(buildConfirmationRequestEmail({ locale: 'it', confirmUrl: JOB_URL }));
    expect(req.html).not.toContain('Driver');
    expect(req.html).not.toContain('Siegfried');
  });

  it('the positional reading no longer pairs a stale title with another company', () => {
    // Exactly two parts after the prefix used to be trusted even when
    // `job_company` named a different offer.
    expect(jobTitleFromSource({ source: 'job_gate:Acme SA:Muratore', job_company: 'Beta SA' })).toBeNull();
    // With no company at all, the unambiguous split still stands alone.
    expect(jobTitleFromSource({ source: 'job_gate:Acme SA:Muratore' })).toBe('Muratore');
  });

  it('whitespace the client did not trim still corroborates the company', () => {
    const doc = jobGateDoc({ source: 'job_gate:Kulm Hotel  St. Moritz :Driver (m/w/d)' });
    expect(parseJobSource(doc)).toEqual({ title: 'Driver (m/w/d)', mixed: false });
    expect(resolveConfirmationJobContext(doc)?.title).toBe('Driver (m/w/d)');
  });

  it('a company containing a colon is still found', () => {
    const doc = jobGateDoc({ source: 'job_gate:Studio A:B Sagl:Contabile', job_company: 'Studio A:B Sagl' });
    expect(parseJobSource(doc)).toEqual({ title: 'Contabile', mixed: false });
  });

  it('a surface whose source carries no title keeps its company-only context', () => {
    // JobExpiredView stamps `source: 'job_expired'`: the company is the only
    // slot, and nothing contradicts it.
    const ctx = resolveConfirmationJobContext(jobGateDoc({ source: 'job_expired', source_cta: 'job_expired_email_unlock' }));
    expect(ctx).toEqual({ kind: 'expired', title: null, company: 'Kulm Hotel St. Moritz', location: 'Pontresina' });
  });
});

describe('a title is printed with a location only when one signup wrote both', () => {
  const HOUR = 3600e3;
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it('two offers of the same company: title A never meets location B (review of #9832)', () => {
    // The reviewer's acceptance case, verbatim: nothing on the document proves
    // that the title and the location belong to one offer.
    const doc = {
      source_cta: 'job_board_email_unlock',
      source: 'job_gate_email:Acme:Offerta A',
      job_company: 'Acme',
      job_location: 'Località B',
    };
    const ctx = resolveConfirmationJobContext(doc);
    expect(ctx?.location ?? null).toBeNull();
    expect(ctx).toEqual({ kind: 'unlocked', title: null, company: 'Acme', location: null });
  });

  it('the signup that created the document, composed within a day: title, company and location', () => {
    const doc = jobGateDoc({ created_at: at(10 * 60e3), confirmation_cycle_started_at: at(10 * 60e3) });
    expect(jobFieldsFromTitleSignup(doc, Date.now())).toBe(true);
    expect(resolveConfirmationJobContext(doc)).toEqual({
      kind: 'unlocked', title: 'Driver (m/w/d)', company: 'Kulm Hotel St. Moritz', location: 'Pontresina',
    });
  });

  it('a re-subscription: the title is an older signup\'s, so only the company is named', () => {
    // Cycle 1 on offer A expired; months later the same person signs up for
    // offer B of the same company. `source` still carries A's title.
    const doc = jobGateDoc({ created_at: at(90 * 24 * HOUR), confirmation_cycle_started_at: at(5 * 60e3) });
    expect(jobFieldsFromTitleSignup(doc, Date.now())).toBe(false);
    expect(resolveConfirmationJobContext(doc)).toEqual({
      kind: 'unlocked', title: null, company: 'Kulm Hotel St. Moritz', location: null,
    });
  });

  it('composed more than a day after the signup: a later signup may have rewritten the job fields', () => {
    const doc = jobGateDoc({ created_at: at(30 * HOUR), confirmation_cycle_started_at: at(30 * HOUR) });
    expect(resolveConfirmationJobContext(doc)?.title).toBeNull();
    expect(resolveConfirmationJobContext(doc)?.location).toBeNull();
  });

  it('a surface that stamps no title keeps company and location, written by one signup', () => {
    const doc = jobGateDoc({ source: 'job_expired', source_cta: 'job_expired_email_unlock', created_at: at(90 * 24 * HOUR) });
    expect(resolveConfirmationJobContext(doc)).toEqual({
      kind: 'expired', title: null, company: 'Kulm Hotel St. Moritz', location: 'Pontresina',
    });
  });

  it('request #1 and its reminders use the same sanitized return path', () => {
    const first = confirmationJobContextForSend(jobGateDoc(), { attemptsBefore: 0, returnPath: '/it/offerte/?utm_source=mail#x' });
    expect(first.returnPath).toBe('/it/offerte/');
    expect(first.snapshot?.return_path).toBe('/it/offerte/');
    const reminder = confirmationJobContextForSend(
      jobGateDoc({ confirmation_attempts: 1, [CONFIRMATION_JOB_CONTEXT_FIELD]: first.snapshot }),
      { attemptsBefore: 1, returnPath: '/somewhere/else/' },
    );
    expect(reminder.returnPath).toBe('/it/offerte/');
    // A generic request is sanitized the same way.
    expect(confirmationJobContextForSend({ source_cta: 'newsletter_popup_submit' }, { attemptsBefore: 0, returnPath: '/a/?b=1' }).returnPath).toBe('/a/');
  });
});

describe('the snapshot: request #1 decides, the reminders repeat', () => {
  const FIRST_SENT = Date.parse('2026-09-20T09:15:00.000Z');
  const A_PATH = '/cerca-lavoro-ticino/driver-kulm-hotel/';

  it('request #1 resolves the offer and freezes it with its return path', () => {
    const send = confirmationJobContextForSend(jobGateDoc(), { attemptsBefore: 0, returnPath: A_PATH });
    expect(send.jobContext).toEqual({ kind: 'unlocked', title: 'Driver (m/w/d)', company: 'Kulm Hotel St. Moritz', location: 'Pontresina' });
    expect(send.returnPath).toBe(A_PATH);
    expect(send.snapshot).toEqual({ ...send.jobContext, return_path: A_PATH });

    // The ledger write carries it, in the same object as the counter.
    const fields = buildConfirmationSentFields({
      attemptsBefore: 0, isCycleSend: true, messageId: 'm1', locale: 'it', stamp: 'STAMP', jobSnapshot: send.snapshot,
    });
    expect(fields).toMatchObject({ confirmation_attempts: 1, [CONFIRMATION_JOB_CONTEXT_FIELD]: send.snapshot });
  });

  it('a generic request #1 is frozen too, as null', () => {
    const popup = { status: 'pending', source_cta: 'newsletter_popup_submit', source_page: '/' };
    const send = confirmationJobContextForSend(popup, { attemptsBefore: 0, returnPath: '/' });
    expect(send).toEqual({ jobContext: null, returnPath: '/', snapshot: null });
    const fields = buildConfirmationSentFields({
      attemptsBefore: 0, isCycleSend: true, messageId: null, locale: 'it', stamp: 'S', jobSnapshot: send.snapshot,
    });
    expect(fields).toHaveProperty(CONFIRMATION_JOB_CONTEXT_FIELD, null);
  });

  it('a login link or a re-probe never writes the snapshot, and an omitted one is not written', () => {
    const snapshot = { kind: 'unlocked', title: 'X', company: null, location: null, return_path: null };
    expect(buildConfirmationSentFields({
      attemptsBefore: 1, isCycleSend: false, messageId: 'm', locale: 'it', stamp: 'S', jobSnapshot: snapshot,
    })).not.toHaveProperty(CONFIRMATION_JOB_CONTEXT_FIELD);
    expect(buildConfirmationSentFields({
      attemptsBefore: 1, isCycleSend: true, messageId: 'm', locale: 'it', stamp: 'S',
    })).not.toHaveProperty(CONFIRMATION_JOB_CONTEXT_FIELD);
  });

  it('a reminder repeats the snapshot even after a signup on another offer rewrote the document', () => {
    const first = confirmationJobContextForSend(jobGateDoc(), { attemptsBefore: 0, returnPath: A_PATH });
    const later = jobGateDoc({
      ...secondOffer,
      source_cta: 'job_expired_email_unlock',
      confirmation_attempts: 1,
      confirmation_first_sent_at: new Date(FIRST_SENT).toISOString(),
      [CONFIRMATION_JOB_CONTEXT_FIELD]: first.snapshot,
    });
    const reminder = confirmationJobContextForSend(later, { attemptsBefore: 1, returnPath: secondOffer.source_page });
    expect(reminder.jobContext).toEqual(first.jobContext);
    expect(reminder.returnPath).toBe(A_PATH);

    // Through the runner: the email names A and its link returns to A's page.
    const req = buildFollowupRequest(
      { id: 'j@example.com', data: later, decision: { action: 'send', attempt: 2, attempts: 1, reason: 'reminder' } } as any,
      { secret: 'test-secret' },
    );
    expect(req.payload.subject).toContain('Driver (m/w/d)');
    expect(String(req.payload.html)).toContain('Kulm Hotel St. Moritz');
    expect(String(req.payload.html)).not.toContain('Siegfried');
    expect(String(req.payload.html)).toContain(`${A_PATH}?action=confirm_newsletter`);
    expect(String(req.payload.html)).not.toContain('chemist-siegfried');
    expect(req.meta.jobSnapshot).toEqual(first.snapshot);
  });

  it('a generic request #1 keeps its reminders generic when a job signup arrives in between', () => {
    const later = jobGateDoc({ confirmation_attempts: 1, [CONFIRMATION_JOB_CONTEXT_FIELD]: null });
    const req = buildFollowupRequest(
      { id: 'j@example.com', data: later, decision: { action: 'send', attempt: 2, attempts: 1, reason: 'reminder' } } as any,
      { secret: 'test-secret' },
    );
    expect(req.payload.subject).toBe(t('it', 'confirmReminderSubject'));
    expect(req.payload.tags).not.toContainEqual({ name: 'context', value: 'job' });
    expect(req.meta.jobSnapshot).toBeNull();
  });

  it('a legacy document (asked before the snapshot) is resolved once, then frozen by the ledger', () => {
    const legacy = jobGateDoc({ confirmation_attempts: 1, confirmation_first_sent_at: new Date(FIRST_SENT).toISOString() });
    expect(readConfirmationJobSnapshot(legacy)).toBeUndefined();
    const req = buildFollowupRequest(
      { id: 'j@example.com', data: legacy, decision: { action: 'send', attempt: 2, attempts: 1, reason: 'reminder' } } as any,
      { secret: 'test-secret' },
    );
    expect(req.payload.subject).toContain('Driver (m/w/d)');
    expect(req.meta.jobSnapshot).toEqual({
      kind: 'unlocked', title: 'Driver (m/w/d)', company: 'Kulm Hotel St. Moritz', location: 'Pontresina', return_path: A_PATH,
    });
  });

  it('a legacy document that mixes two offers gets the generic reminder, not a mixed one', () => {
    const legacyMixed = jobGateDoc({ ...secondOffer, confirmation_attempts: 2 });
    const req = buildFollowupRequest(
      { id: 'j@example.com', data: legacyMixed, decision: { action: 'send', attempt: 3, attempts: 2, reason: 'reminder' } } as any,
      { secret: 'test-secret' },
    );
    expect(req.payload.subject).toBe(t('it', 'confirmReminderLastSubject'));
    expect(String(req.payload.html)).not.toContain('Driver');
    expect(String(req.payload.html)).not.toContain('Siegfried');
    expect(req.meta.jobSnapshot).toBeNull();
  });

  it('a snapshot left by a previous cycle is replaced on the new cycle\'s request #1', () => {
    const stale = { kind: 'unlocked', title: 'Old offer', company: 'Old SA', location: null, return_path: '/old/' };
    const send = confirmationJobContextForSend(
      jobGateDoc({ [CONFIRMATION_JOB_CONTEXT_FIELD]: stale }),
      { attemptsBefore: 0, returnPath: A_PATH },
    );
    expect(send.jobContext?.title).toBe('Driver (m/w/d)');
    expect(send.snapshot?.return_path).toBe(A_PATH);
  });

  it('a stored snapshot is re-sanitized on the way out, and a forged one reads as generic', () => {
    const doc = (snap: unknown) => ({ [CONFIRMATION_JOB_CONTEXT_FIELD]: snap });
    expect(readConfirmationJobSnapshot(doc({ kind: 'unlocked', title: '<img src=x>', company: 'Acme', location: null, return_path: null }))).toBeNull();
    expect(readConfirmationJobSnapshot(doc({ kind: 'bait', title: 'Muratore', company: null, location: null, return_path: null }))).toBeNull();
    expect(readConfirmationJobSnapshot(doc({ kind: 'unlocked', title: 'Muratore', company: null, location: null, return_path: '//evil.test/x' }))).toBeNull();
    expect(readConfirmationJobSnapshot(doc({ kind: 'unlocked', title: null, company: null, location: 'Lugano', return_path: null }))).toBeNull();
    expect(readConfirmationJobSnapshot(doc('Muratore'))).toBeNull();
    expect(readConfirmationJobSnapshot(doc(null))).toBeNull();
    expect(readConfirmationJobSnapshot({})).toBeUndefined();
    expect(readConfirmationJobSnapshot(doc({ kind: 'expired', title: 'Muratore', company: null, location: 'ti', return_path: '/x/' })))
      .toEqual({ kind: 'expired', title: 'Muratore', company: null, location: 'Ticino', return_path: '/x/' });
  });

  it('the return path sanitizer is the one the runner already used', () => {
    expect(sanitizeConfirmationReturnPath('/it/lavoro?x=1#y')).toBe('/it/lavoro');
    for (const bad of ['//evil.com', 'https://evil.com', '/a\\b', '', null, 42]) {
      expect(sanitizeConfirmationReturnPath(bad as any), String(bad)).toBeNull();
    }
  });
});
