import { describe, expect, it } from 'vitest';

import { facebookUrl } from '../scripts/lib/facebook-links.mjs';
import { linkedinUrl } from '../scripts/lib/linkedin-links.mjs';
import { socialRedirectUrl } from '../scripts/lib/social-redirect-links.mjs';
import { telegramUrl } from '../scripts/lib/telegram-links.mjs';

describe('first-party social redirect links', () => {
  it('keeps a stable key for the same post destination and separates copy arms', () => {
    const url = 'https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/?utm_source=old&utm_medium=email';
    const first = facebookUrl(url, 'facebook_job', 'job-one--arm-a');
    const repeat = facebookUrl(url, 'facebook_job', 'job-one--arm-a');
    const otherArm = facebookUrl(url, 'facebook_job', 'job-one--arm-b');
    const parsed = new URL(first);

    expect(parsed.pathname).toMatch(/^\/social\/r\/[a-f0-9]{20}\/$/u);
    expect(parsed.pathname).toBe(new URL(repeat).pathname);
    expect(parsed.pathname).not.toBe(new URL(otherArm).pathname);
    expect(parsed.searchParams.get('to')).toBe('/cerca-lavoro-ticino/job-one/');
    expect(parsed.searchParams.get('utm_source')).toBe('facebook');
    expect(parsed.searchParams.get('utm_medium')).toBe('social');
    expect(parsed.searchParams.get('utm_campaign')).toBe('facebook_job');
    expect(parsed.searchParams.get('utm_content')).toBe('job-one--arm-a');
    expect(parsed.searchParams.has('utm_term')).toBe(false);
  });

  it('uses the shared redirect contract for LinkedIn and Telegram clickable post links', () => {
    const linkedin = new URL(linkedinUrl(
      'https://frontaliereticino.ch/articolo/',
      'linkedin_member_daily_article',
      'article--arm-a',
    ));
    const telegram = new URL(telegramUrl(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/',
      'jobs_digest',
      'hub--arm-b',
    ));

    expect(linkedin.pathname).toMatch(/^\/social\/r\//u);
    expect(linkedin.searchParams.get('utm_source')).toBe('linkedin');
    expect(telegram.pathname).toMatch(/^\/social\/r\//u);
    expect(telegram.searchParams.get('utm_source')).toBe('telegram');
  });

  it('leaves external and non-canonical destinations untouched for caller-side handling', () => {
    expect(socialRedirectUrl('https://example.com/path/', {
      source: 'facebook', medium: 'social', campaign: 'facebook_job', content: 'job-one',
    })).toBe('https://example.com/path/');
    expect(socialRedirectUrl('https://frontaliereticino.ch/cerca-lavoro-ticino', {
      source: 'facebook', medium: 'social', campaign: 'facebook_job', content: 'job-one',
    })).toBe('https://frontaliereticino.ch/cerca-lavoro-ticino');
  });
});
