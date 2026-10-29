import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sanitizeTelemetryProperties } from '../services/analyticsUrlPrivacy.js';
import { GTAG_INIT_CONTENT, POSTHOG_INIT_CONTENT } from '../build-plugins/constants';

const url = 'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/?application_concierge_service_id=service-test&ne=candidate%40example.test&ac=secret-code&utm_source=email&utm_medium=payment_reminder#offer';

describe('email-link telemetry URL privacy', () => {
 it('strips supported credential aliases, duplicates and mixed case while preserving attribution', () => {
  const aliases = ['ac', 'at', 'authToken', 'ne', 'newsletter_email', 'email', 'newsletter_autologin', 'subscriber_key', 'token', 'access_token', 'id_token', 'refresh_token', 'oobCode'];
  const value = new URL(url);
  for (const key of aliases) { value.searchParams.append(key, 'sensitive'); value.searchParams.append(key.toUpperCase(), 'sensitive'); }
  const original = value.toString();
  const properties = { page_location: original, page_path: value.pathname + value.search + value.hash, action: 'checkout_resumed', amount: 3999 };
  const result = sanitizeTelemetryProperties(properties);
  expect(properties.page_location).toBe(original);
  const cleaned = new URL(result.page_location);
  for (const key of aliases) { expect(cleaned.searchParams.has(key)).toBe(false); expect(cleaned.searchParams.has(key.toUpperCase())).toBe(false); }
  expect(cleaned.searchParams.get('application_concierge_service_id')).toBe('service-test');
  expect(cleaned.searchParams.get('utm_medium')).toBe('payment_reminder');
  expect(cleaned.hash).toBe('#offer');
  expect(result.page_path).not.toContain('sensitive');
  expect(result.amount).toBe(3999);
 });

 it('covers SDK-added URLs, encoded destinations, query-only and hash routes', () => {
  const result = sanitizeTelemetryProperties({
   $current_url: url, $initial_current_url: url, $referrer: url,
   nested: [{ href: '/cerca-lavoro-ticino/?assisted_application_order_id=order-test&ac=code&utm_campaign=recovery' }],
   target_url: 'https://frontaliereticino.ch/?redirect=' + encodeURIComponent(url),
   page_path: '#/checkout/?ac=code&ne=email&utm_source=email', query: '?ac=code&utm_source=email',
   relative: '/?next=' + encodeURIComponent('/checkout/?ac=secret-code&utm_source=email'),
   hash_url: '#redirect=' + encodeURIComponent(url),
  });
  expect(JSON.stringify(result)).not.toContain('secret-code');
  expect(result.nested[0].href).toBe('/cerca-lavoro-ticino/?assisted_application_order_id=order-test&utm_campaign=recovery');
  expect(new URL(new URL(result.target_url).searchParams.get('redirect')!).searchParams.get('ac')).toBeNull();
  expect(result.page_path).toBe('#/checkout/?utm_source=email');
  expect(result.query).toBe('?utm_source=email');
 });

 it('sanitizes static GA4 config and the pre-hydration pageview without changing the login URL', () => {
  const context: Record<string, any> = {
   location: new URL(url),
   navigator: { userAgent: 'Mozilla/5.0 (iPhone) Version/18.1 Mobile Safari/604.1', language: 'it-CH', languages: ['it-CH'] },
   screen: { width: 390, height: 844 },
   document: { title: 'Checkout', referrer: url }, URL, URLSearchParams,
  };
  context.window = context;
  runInNewContext(GTAG_INIT_CONTENT, context);
  const commands = context.dataLayer.map((entry: IArguments) => Array.from(entry));
  const config = commands.find((entry: any[]) => entry[0] === 'config')[2];
  const pageView = commands.find((entry: any[]) => entry[0] === 'event' && entry[1] === 'page_view')[2];
  expect(config.page_location).not.toContain('secret-code');
  expect(config.page_referrer).not.toContain('secret-code');
  expect(pageView.page_location).toContain('utm_medium=payment_reminder');
  expect(pageView.page_location).not.toContain('candidate');
  expect(context.location.href).toBe(url);
 });

 it('keeps ordinary URLs byte-identical and embeds canonical code in static producers', () => {
  const ordinary = '/cerca-lavoro-ticino/?utm_campaign=a%20b&action=continue#details';
  expect(sanitizeTelemetryProperties({ page_path: ordinary }).page_path).toBe(ordinary);
  const source = readFileSync(new URL('../services/analyticsUrlPrivacy.js', import.meta.url), 'utf8').replace(/^export /m, '');
  const staticSanitize = new Function('return (' + source + ')')() as typeof sanitizeTelemetryProperties;
  expect(staticSanitize({ page_location: url })).toEqual(sanitizeTelemetryProperties({ page_location: url }));
  expect(GTAG_INIT_CONTENT).toContain(source);
  expect(POSTHOG_INIT_CONTENT).toContain(source);
 });
});
