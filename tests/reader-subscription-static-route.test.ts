import { describe, expect, it } from 'vitest';
import { READER_SUBSCRIPTION_LOCALES, READER_SUBSCRIPTION_PATHS } from '../services/readerSubscriptionPath';
import { renderReaderSubscriptionStaticPage } from '../build-plugins/shared/readerSubscriptionStaticPage';

describe('reader subscription static routes', () => {
  it.each(READER_SUBSCRIPTION_LOCALES)('emits a direct-load noindex SPA shell for %s', (locale) => {
    const route = READER_SUBSCRIPTION_PATHS[locale];
    const html = renderReaderSubscriptionStaticPage({
      locale,
      canonicalUrl: `https://frontaliereticino.ch${route}`,
      headPrefix: '<meta charset="utf-8">',
      cssHead: '<link rel="stylesheet" href="/assets/app.css">',
      rootShell: '<div id="root"></div>',
      entryJs: 'app-entry.js',
    });

    expect(html).toContain(`<html lang="${locale}">`);
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(html).toContain(`<link rel="canonical" href="https://frontaliereticino.ch${route}">`);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" crossorigin src="/assets/app-entry.js"></script>');
    expect(html).toContain('data-no-auto-ads');
    expect(html).not.toMatch(/adsbygoogle|fundingchoices|site-support/i);
  });

  it('keeps the paid route URLs aligned with the canonical localized router slugs', () => {
    expect(READER_SUBSCRIPTION_PATHS).toEqual({
      it: '/abbonamento/',
      en: '/en/subscribe/',
      de: '/de/abonnement/',
      fr: '/fr/abonnement/',
    });
  });
});
