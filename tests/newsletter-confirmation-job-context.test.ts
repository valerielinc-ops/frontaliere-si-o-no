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
  CONFIRMATION_JOB_CONTEXT_KINDS,
} from '../functions/src/lib/confirmationJobContext.js';
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

const jobGateDoc = (overrides: Record<string, any> = {}) => ({
  email: 'j@example.com',
  status: 'pending',
  isActive: false,
  created_at: new Date(Date.now() - 3600e3).toISOString(),
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
