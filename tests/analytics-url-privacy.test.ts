import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sanitizeTelemetryProperties } from '../services/analyticsUrlPrivacy.js';
import { GTAG_INIT_CONTENT, POSTHOG_INIT_CONTENT } from '../build-plugins/constants';
import { buildRedirectPage } from '../build-plugins/affiliateRedirectPlugin';
import { PARTNERS, isPartnerizeUrl } from '../services/affiliateService';

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

 it('sanitizes the affiliate redirect producer before its automatic handoff', () => {
  const partner = PARTNERS.find((entry) => !isPartnerizeUrl(entry.url))!;
  const html = buildRedirectPage(partner);
  const start = html.indexOf('var u=');
  const end = html.indexOf('})();</script>', start);
  const context: Record<string, any> = {
   location: new URL(url),
   navigator: { userAgent: 'Mozilla/5.0 (iPhone) Version/18.1 Mobile Safari/604.1', language: 'it-CH', languages: ['it-CH'] },
   screen: { width: 390, height: 844 },
   document: { title: 'Redirect', referrer: url }, URL, URLSearchParams,
   setTimeout: () => {},
  };
  context.window = context;
  runInNewContext('(function(){' + html.slice(start, end) + '})();', context);
  const config = context.dataLayer.map((entry: IArguments) => Array.from(entry)).find((entry: any[]) => entry[0] === 'config')[2];
  expect(config.page_location).not.toContain('secret-code');
  expect(config.page_referrer).not.toContain('candidate');
  expect(config.page_location).toContain('utm_source=email');
 });

 it.each([
  [' \u0000https://user:password@example.test/path?ac=secret', 'https://example.test/path'],
  [' \t//user:password@example.test/path?ac=secret', '//example.test/path'],
  ['https:\n//user:password@example.test/path?ac=secret', 'https://example.test/path'],
  ['https://user:password@example.test/path', 'https://example.test/path'],
  ['//user:password@example.test/path', '//example.test/path'],
  ['https://user:p%40ss@example.test/path?utm_source=email', 'https://example.test/path?utm_source=email'],
  ['//example.test:8443/path?ac=secret&utm_source=email#anchor', '//example.test:8443/path?utm_source=email#anchor'],
  ['#route?ac=secret&utm_source=email', '#route?utm_source=email'],
  ['#/route?ac=secret&utm_source=email', '#/route?utm_source=email'],
  ['./route?ac=secret&utm_source=email', './route?utm_source=email'],
  ['https://user:password@[broken/path?ac=secret', ''],
 ])('removes credentials without changing URL form: %s', (input, expected) => {
  expect(sanitizeTelemetryProperties({ page_location: input }).page_location).toBe(expected);
 });

 it.each(['./route', '../route', ' ./route'])('sanitizes nested relative URL %s', (relative) => {
  const input = 'https://redirect.test/?url=' + encodeURIComponent(relative + '?ac=secret&utm_source=email');
  const result = sanitizeTelemetryProperties({ page_location: input }).page_location;
  const nested = new URL(result).searchParams.get('url')!;
  expect(nested).toBe(relative.trim() + '?utm_source=email');
 });

 it.each(['https:user:password@example.test/path', 'https:/user:password@example.test/path', 'http:user:password@example.test/path'])('sanitizes nested slashless absolute URL %s', (reference) => {
  const result = sanitizeTelemetryProperties({ page_location: 'https://redirect.test/?redirect=' + encodeURIComponent(reference + '?ac=secret&utm_source=email') }).page_location;
  const nested = new URL(new URL(result).searchParams.get('redirect')!);
  expect(nested.username).toBe('');
  expect(nested.password).toBe('');
  expect(nested.hostname).toBe('example.test');
  expect(nested.search).toBe('?utm_source=email');
 });

 it('removes userinfo at the nesting limit while keeping outer campaign attribution', () => {
  let nested = 'https://user:password@destination.test/path?ac=secret&utm_source=inner';
  for (let i = 0; i < 4; i++) nested = 'https://redirect.test/?url=' + encodeURIComponent(nested) + '&utm_source=email';
  let cleaned = sanitizeTelemetryProperties({ page_location: nested }).page_location;
  for (let i = 0; i < 4; i++) {
   const parsed = new URL(cleaned);
   expect(parsed.searchParams.get('utm_source')).toBe('email');
   cleaned = parsed.searchParams.get('url')!;
  }
  const destination = new URL(cleaned);
  expect(destination.username).toBe('');
  expect(destination.password).toBe('');
  expect(destination.search).toBe('');
  expect(destination.pathname).toBe('/path');
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
