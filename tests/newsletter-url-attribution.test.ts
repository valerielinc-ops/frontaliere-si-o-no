import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeAuthenticatedUrl } from '../functions/src/lib/newsletterUrls.js';

const BASE = 'https://frontaliereticino.ch';
const EMAIL = 'recipient@example.com';
const SECRET = 'newsletter-url-attribution-test-secret';
const NEWSLETTER_UTM = {
  utmSource: 'newsletter',
  utmMedium: 'email',
  utmCampaign: 'weekly_fixture',
  preserveExistingUtmMedium: true,
};
const JOB_ALERT_UTM = {
  utmSource: 'job_alert',
  utmMedium: 'email',
  utmCampaign: 'alert_42',
  preserveExistingUtmMedium: true,
};

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

describe('new email link attribution', () => {
  it('adds a deterministic source/medium/campaign triple to newsletter links', () => {
    const target = `${BASE}/calcola-stipendio/`;
    const first = makeAuthenticatedUrl(target, EMAIL, { secret: SECRET, ...NEWSLETTER_UTM });
    const second = makeAuthenticatedUrl(target, EMAIL, { secret: SECRET, ...NEWSLETTER_UTM });
    const params = new URL(first).searchParams;

    expect(first).toBe(second);
    expect(params.get('utm_source')).toBe('newsletter');
    expect(params.get('utm_medium')).toBe('email');
    expect(params.get('utm_campaign')).toBe('weekly_fixture');
  });

  it('keeps the existing JobAlert taxonomy and does not duplicate UTM keys', () => {
    const target = `${BASE}/cerca-lavoro-ticino/job-42/?utm_source=job_alert&utm_medium=email&utm_campaign=alert_42`;
    const params = new URL(
      makeAuthenticatedUrl(target, EMAIL, { secret: SECRET, ...JOB_ALERT_UTM }),
    ).searchParams;

    expect(params.getAll('utm_source')).toEqual(['job_alert']);
    expect(params.getAll('utm_medium')).toEqual(['email']);
    expect(params.getAll('utm_campaign')).toEqual(['alert_42']);
  });

  it('preserves pre-existing UTM parameters while completing missing ones', () => {
    const target = `${BASE}/preferenze-newsletter/?email=stored%40example.com&utm_medium=email&utm_campaign=alert_42&utm_content=preferences`;
    const params = new URL(
      makeAuthenticatedUrl(target, EMAIL, {
        secret: SECRET,
        ...NEWSLETTER_UTM,
      }),
    ).searchParams;

    expect(params.get('utm_source')).toBe('newsletter');
    expect(params.get('utm_medium')).toBe('email');
    expect(params.get('utm_campaign')).toBe('alert_42');
    expect(params.get('utm_content')).toBe('preferences');
    expect(params.has('ac')).toBe(true);
  });

  it('keeps relative and absolute URLs compatible with authentication and tracking', () => {
    const relative = new URL(
      makeAuthenticatedUrl('/preferenze-newsletter/?utm_medium=email', EMAIL, {
        secret: SECRET,
        ...NEWSLETTER_UTM,
      }),
    );
    const absolute = new URL(
      makeAuthenticatedUrl(`${BASE}/preferenze-newsletter/?utm_medium=email`, EMAIL, {
        secret: SECRET,
        ...NEWSLETTER_UTM,
      }),
    );

    expect(relative.origin).toBe(BASE);
    expect(relative.pathname).toBe(absolute.pathname);
    expect(relative.searchParams.get('ac')).toBeTruthy();
    expect(relative.searchParams.get('utm_source')).toBe('newsletter');
    expect(relative.searchParams.get('utm_medium')).toBe('email');
    expect(relative.searchParams.get('utm_campaign')).toBe('weekly_fixture');
  });

  it('keeps recipient and authentication code out of UTM values', () => {
    const params = new URL(
      makeAuthenticatedUrl(`${BASE}/preferenze-newsletter/`, EMAIL, {
        secret: SECRET,
        ...NEWSLETTER_UTM,
      }),
    ).searchParams;

    for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
      const value = params.get(key) || '';
      expect(value).not.toContain('@');
      expect(value).not.toBe(params.get('ne'));
      expect(value).not.toBe(params.get('ac'));
    }
  });
});

describe('sender call-sites', () => {
  it('passes the complete weekly newsletter taxonomy to both personalization paths', () => {
    const source = read('scripts/send-newsletter.mjs');

    expect(source).toContain("const NEWSLETTER_UTM_SOURCE = 'newsletter';");
    expect(source).toContain("const NEWSLETTER_UTM_MEDIUM = 'email';");
    expect(source).toMatch(/utmSource: NEWSLETTER_UTM_SOURCE/);
    expect(source).toMatch(/utmMedium: NEWSLETTER_UTM_MEDIUM/);
    expect(source).toMatch(/utmCampaign,/);
    expect(source).toMatch(/preserveExistingUtmMedium: true/);
  });

  it('passes the existing JobAlert taxonomy even for fallback URLs', () => {
    const source = read('scripts/send-job-alerts.mjs');

    expect(source).toMatch(/const alertUtm = \{[\s\S]*utmSource: 'job_alert'/);
    expect(source).toMatch(/utmMedium: 'email'/);
    expect(source).toMatch(/utmCampaign: `alert_\$\{alert\.id\}`/);
    expect(source).toContain('makeAuthenticatedUrl(rawUrl, alert.email, autologinCode, alertUtm)');
    expect(source).toContain('...alertUtm');
  });

  it('keeps the welcome sender and preview on the newsletter taxonomy', () => {
    for (const relativePath of ['functions/src/newsletterWelcomeEmail.js', 'scripts/preview-welcome-email.mjs']) {
      const source = read(relativePath);
      expect(source).toContain("utmSource: 'newsletter'");
      expect(source).toContain("utmMedium: 'email'");
      expect(source).toContain('preserveExistingUtmMedium: true');
    }
  });

  it('tracks company-alert links with their own source and campaign', () => {
    const source = read('scripts/send-company-alerts.mjs');

    expect(source).toMatch(/const companyAlertUtm = \{[\s\S]*utmSource: COMPANY_ALERT_TEMPLATE_ID/);
    expect(source).toMatch(/utmMedium: 'email'/);
    expect(source).toMatch(/utmCampaign: `alert_\$\{headline\.alert\.id\}`/);
    expect(source).toContain('...companyAlertUtm');
  });
});
