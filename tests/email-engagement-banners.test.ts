import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SOCIAL_LINKS,
  PREFERRED_SOURCE_URL,
  emailEngagementBannersText,
  emailEngagementCopy,
  renderEmailEngagementBanners,
  resolveSocialLinks,
} from '@/functions/src/lib/emailEngagementBanners.js';

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath: string) => readFileSync(path.join(ROOT, relativePath), 'utf8');
const locales = ['it', 'en', 'de', 'fr'] as const;

describe('email engagement banners', () => {
  it('renders the three cards in the selected order with email-safe brand images', () => {
    const html = renderEmailEngagementBanners({ locale: 'it', telegramUrl: 'https://t.me/frontaliereticino' });
    const copy = emailEngagementCopy('it');

    expect(html.indexOf(copy.automationTitle)).toBeLessThan(html.indexOf(copy.preferredSourceTitle));
    expect(html.indexOf(copy.preferredSourceTitle)).toBeLessThan(html.indexOf(copy.socialTitle));
    expect(html).toContain('https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera');
    expect(html).toContain(PREFERRED_SOURCE_URL);
    expect(html).toContain('https://t.me/frontaliereticino');
    expect(html).not.toContain('<svg');
    expect(html).toContain('data-email-logo="google"');
    expect(html).toContain('https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png');
    expect(html).toContain('data-email-logo="linkedin"');
    expect(html).toContain('https://www.linkedin.com/favicon.ico');
    expect(html).toContain('data-email-logo="instagram"');
    expect(html).toContain('https://www.instagram.com/static/images/ico/favicon-192.png/68d99ba29cc8.png');
    expect(html).toContain('data-email-logo="tiktok"');
    expect(html).toContain('https://www.tiktok.com/favicon.ico');
    expect(html).toContain('data-email-logo="telegram"');
    expect(html).toContain('https://telegram.org/img/t_logo.png');
    expect(html).toContain('data-email-logo="facebook"');
    expect(html).toContain('https://www.facebook.com/favicon.ico');
    expect(html).toContain('LinkedIn');
    expect(html).toContain('Instagram');
    expect(html).toContain('TikTok');
    expect(html).toContain('Telegram');
    expect(html).toContain('Facebook');
    expect(html).not.toMatch(/display\s*:\s*(?:flex|grid)/i);
    expect(html).not.toContain('undefined');
  });

  it('can preserve slash-terminated internal links for the welcome template', () => {
    const html = renderEmailEngagementBanners({ locale: 'it', trailingSlash: true });

    expect(html).toContain('https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/');
  });

  it('shows the four confirmed profiles by default and only adds Telegram when valid', () => {
    expect(resolveSocialLinks().map(({ key }) => key)).toEqual(['linkedin', 'instagram', 'tiktok', 'facebook']);
    expect(resolveSocialLinks({ telegram: 'https://t.me/frontaliereticino' }).map(({ key }) => key))
      .toEqual(['linkedin', 'instagram', 'tiktok', 'telegram', 'facebook']);
    expect(resolveSocialLinks({ telegram: 'https://example.com/channel' }).map(({ key }) => key))
      .toEqual(['linkedin', 'instagram', 'tiktok', 'facebook']);
    expect(DEFAULT_SOCIAL_LINKS.telegram).toBe('');
  });

  it('localizes copy and the assisted-search destination in every supported locale', () => {
    const paths = {
      it: '/automatizza-ricerca-lavoro-svizzera',
      en: '/en/automate-job-search-switzerland',
      de: '/de/arbeitssuche-schweiz-automatisieren',
      fr: '/fr/automatiser-recherche-emploi-suisse',
    } as const;

    for (const locale of locales) {
      const html = renderEmailEngagementBanners({ locale });
      const text = emailEngagementBannersText({ locale, socialLinks: { telegram: '' } });
      const copy = emailEngagementCopy(locale);

      expect(html).toContain(copy.automationTitle);
      expect(html).toContain(copy.preferredSourceTitle);
      expect(html).toContain(copy.socialTitle);
      expect(html).toContain(`https://frontaliereticino.ch${paths[locale]}`);
      expect(text).toContain(`${copy.preferredSourceCta}: ${PREFERRED_SOURCE_URL}`);
      expect(text).toContain('LinkedIn: https://www.linkedin.com/company/frontaliere-ticino');
      expect(text).not.toContain('Telegram:');
    }
  });
});

describe('email engagement banner mounting', () => {
  const templates = [
    'functions/src/lib/welcomeEmailTemplate.js',
    'services/newsletter-template.mjs',
    'services/daily-brief-template.mjs',
    'scripts/send-job-alerts.mjs',
    'scripts/send-saved-jobs-digest.mjs',
    'services/companyAlertEmail.mjs',
    'services/publisherBlastEmail.mjs',
    'services/newsletter/onboardingDrip.mjs',
    'services/dormantWinbackStage1Email.mjs',
    'services/winbackEmail.mjs',
    'scripts/lib/applicationIntentReminderEmail.mjs',
  ];

  it.each(templates)('mounts in %s', (template) => {
    expect(read(template)).toContain('renderEmailEngagementBanners');
  });
});
