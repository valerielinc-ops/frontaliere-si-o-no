/**
 * Welcome email — behaviours added after the first live run.
 *
 * Guards:
 *  - job alerts are auto-created at signup by the backfillJobAlertOnNewsletterSignup
 *    trigger, so the `job` segment must CONFIRM them rather than ask the reader to
 *    create what already exists — and must fall back to the create wording when
 *    there is no preferences URL to send them to;
 *  - the paid consulting block renders, localized, for consumers and never for
 *    the publisher (employer) audience;
 *  - every internal link carries autologin credentials so the recipient lands
 *    signed in, without breaking the signed unsubscribe token or exceeding
 *    Mailgun's 1000-character click-tracking limit.
 */
import { describe, expect, it } from 'vitest';
import { buildWelcomeEmail } from '../functions/src/lib/welcomeEmailTemplate.js';
import {
  makeOneClickUnsubscribeUrl,
  makePreferencesUrl,
  wrapAuthenticatedHrefs,
  shouldWrapAuthenticatedHref,
} from '../functions/src/lib/newsletterUrls.js';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const SECRET = 'test-secret-for-welcome-followups';
const EMAIL = 'mario.rossi@example.com';

function jobEmail(locale: string, jobAlertActive: boolean, preferencesUrl: string | null = 'https://frontaliereticino.ch/preferenze-newsletter?email=x&token=y') {
  return buildWelcomeEmail({
    segment: 'job',
    locale,
    firstName: 'Marco',
    company: 'EOC – Ente Ospedaliero Cantonale',
    sectorKey: 'health',
    locationLabel: 'Lugano',
    jobBackPath: '/cerca-lavoro-ticino/infermiere-eoc/',
    jobAlertActive,
    unsubscribeUrl: 'https://frontaliereticino.ch/disiscrivi-newsletter/?action=unsubscribe&email=x&token=y',
    preferencesUrl,
  });
}

function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#847;|&zwnj;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('welcome email — job alert already active', () => {
  it.each(LOCALES)('[%s] confirms existing alerts instead of asking to create them', (locale) => {
    const active = jobEmail(locale, true);
    const inactive = jobEmail(locale, false);

    // The two variants must genuinely differ — subject, heading and CTA all move.
    expect(active.subject).not.toBe(inactive.subject);
    expect(active.preheader).not.toBe(inactive.preheader);
    expect(visibleText(active.html)).not.toBe(visibleText(inactive.html));

    // The create-an-alert imperative must be gone from the active variant.
    const activeText = visibleText(active.html).toLowerCase();
    for (const imperative of ['crea un job alert', 'set up a job alert', 'richte einen job-alert', 'crée une alerte']) {
      expect(activeText).not.toContain(imperative);
    }
  });

  it.each(LOCALES)('[%s] active-variant CTA points at the preferences page, not the job board', (locale) => {
    const prefs = makePreferencesUrl(EMAIL, locale, { secret: SECRET });
    const active = buildWelcomeEmail({
      segment: 'job', locale, jobAlertActive: true,
      sectorKey: 'health', locationLabel: 'Lugano',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe',
      preferencesUrl: prefs,
    });
    expect(active.html).toContain(prefs.replace(/&/g, '&amp;'));
  });

  it.each(LOCALES)('[%s] falls back to the create wording when there is no preferences URL', (locale) => {
    // No signing secret → no preferences URL → the "refine your alerts" button
    // would be dead, so the copy must revert rather than emit a broken CTA.
    // Compare against the inactive variant built under the SAME conditions, so
    // the only thing that could differ is the alert wording itself.
    const degraded = jobEmail(locale, true, null);
    const inactive = jobEmail(locale, false, null);
    expect(degraded.subject).toBe(inactive.subject);
    expect(degraded.preheader).toBe(inactive.preheader);
    expect(visibleText(degraded.html)).toBe(visibleText(inactive.html));
  });

  it('subjects stay within the 60-character budget in every locale', () => {
    for (const locale of LOCALES) {
      expect(jobEmail(locale, true).subject.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('welcome email — consulting block', () => {
  const CONSULTING_PATH: Record<string, string> = {
    it: '/consulenza/',
    en: '/en/consulting/',
    de: '/de/beratung/',
    fr: '/fr/consultation/',
  };

  it.each(LOCALES)('[%s] renders with the locale-correct, trailing-slashed consulting link', (locale) => {
    const { html } = jobEmail(locale, true);
    expect(html).toContain(`https://frontaliereticino.ch${CONSULTING_PATH[locale]}`);
  });

  it.each(LOCALES)('[%s] carries real localized copy, not the Italian fallback', (locale) => {
    const text = visibleText(jobEmail(locale, true).html);
    const marker: Record<string, string> = {
      it: 'Doppia imposizione',
      en: 'Double taxation',
      de: 'Doppelbesteuerung',
      fr: 'Double imposition',
    };
    expect(text).toContain(marker[locale]);
    if (locale !== 'it') expect(text).not.toContain(marker.it);
  });

  it.each(LOCALES)('[%s] is absent for the publisher audience', (locale) => {
    const { html } = buildWelcomeEmail({
      segment: 'publisher', locale,
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe',
    });
    expect(html).not.toContain(CONSULTING_PATH[locale]);
  });

  it.each(['salary', 'utility', 'general'])('is present for consumer segment "%s"', (segment) => {
    const { html } = buildWelcomeEmail({
      segment, locale: 'it',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe',
    });
    expect(html).toContain('https://frontaliereticino.ch/consulenza/');
  });
});

describe('welcome email — autologin links', () => {
  it('wraps every internal href with ne/ac and leaves external hosts alone', () => {
    const { html } = jobEmail('it', true, makePreferencesUrl(EMAIL, 'it', { secret: SECRET }));
    const wrapped = wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET, utmCampaign: 'welcome_job' });
    const hrefs = [...wrapped.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      if (!shouldWrapAuthenticatedHref(href)) continue;
      expect(href).toContain('ne=');
      expect(href).toContain('ac=');
      expect(href).toContain('utm_campaign=welcome_job');
    }
  });

  it('keeps every link under Mailgun\'s 1000-character click-tracking limit', () => {
    const { html } = jobEmail('it', true, makePreferencesUrl(EMAIL, 'it', { secret: SECRET }));
    const wrapped = wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET, utmCampaign: 'welcome_job' });
    for (const [, href] of wrapped.matchAll(/href="([^"]+)"/g)) {
      expect(href.replace(/&amp;/g, '&').length).toBeLessThan(1000);
    }
  });

  it('preserves the signed unsubscribe token through wrapping', () => {
    const unsubscribeUrl = makeOneClickUnsubscribeUrl(EMAIL, { secret: SECRET });
    const tokenMatch = unsubscribeUrl.match(/token=([a-f0-9]{64})/);
    expect(tokenMatch).not.toBeNull();

    const { html } = buildWelcomeEmail({
      segment: 'job', locale: 'it', jobAlertActive: false, unsubscribeUrl,
    });
    const wrapped = wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET });
    expect(wrapped).toContain(tokenMatch![1]);
  });

  it('never rewrites a third-party href', () => {
    const html = '<a href="https://wise.com/invite/abc">Wise</a><a href="mailto:x@y.it">mail</a>';
    expect(wrapAuthenticatedHrefs(html, EMAIL, { secret: SECRET })).toBe(html);
  });

  it('is a no-op without an email, rather than emitting half-formed links', () => {
    const html = '<a href="https://frontaliereticino.ch/calcola-stipendio/">x</a>';
    expect(wrapAuthenticatedHrefs(html, '', { secret: SECRET })).toBe(html);
  });
});
