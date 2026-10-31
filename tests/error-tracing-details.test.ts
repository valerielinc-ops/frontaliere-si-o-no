import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
 describeAssistedPaymentResponse,
 getAssistedPaymentResponseShape,
 withAssistedPaymentResponseShape,
} from '../services/assistedApplicationResponseShape';
import { GA4_PARAM_MAX_CHARS, buildResourceErrorDetails } from '../services/resourceErrorLabel';
import { AD_BLOCKER_TRIGGER_PATTERN_SOURCE, isAdBlockerTriggerUrl } from '../services/resilientImport';

describe('buildResourceErrorDetails', () => {
 it('describes a failed preload on a hidden page', () => {
  expect(buildResourceErrorDetails({ rel: 'modulepreload', vis: 'hidden', online: true, triggeredReload: true, adBlockSeen: true }))
   .toBe('rel=modulepreload;vis=hidden;online=1;reload=1;adb=1');
 });

 it('keeps events queued by a page without the new fields readable', () => {
  expect(buildResourceErrorDetails({ triggeredReload: 'blocked' }))
   .toBe('rel=none;vis=unknown;online=unknown;reload=blocked;adb=0');
 });

 it('stays inside the GA4 parameter limit', () => {
  expect(buildResourceErrorDetails({ rel: 'x'.repeat(200) }).length).toBeLessThanOrEqual(GA4_PARAM_MAX_CHARS);
 });
});

describe('describeAssistedPaymentResponse', () => {
 it('names why a 200 was refused', () => {
  expect(describeAssistedPaymentResponse(200, { ok: true, status: 'open', paymentProvider: 'sumup', orderId: 'o1' }))
   .toBe('http=200;ok=1;status=open;provider=sumup;order=1;url=0;checkout=0');
 });

 it('never copies identifiers or free text', () => {
  const shape = describeAssistedPaymentResponse(200, {
   status: 'mail@example.com',
   orderId: 'order-secret',
   url: 'https://pay.example.com/session-secret',
   checkoutId: 'checkout-secret',
  });
  expect(shape).toContain('status=other');
  expect(shape).not.toMatch(/secret|example/);
 });

 it('survives a body that was not JSON', () => {
  expect(describeAssistedPaymentResponse(200, {})).toBe('http=200;ok=0;status=none;provider=none;order=0;url=0;checkout=0');
 });

 it('travels on the thrown error', () => {
  const error = withAssistedPaymentResponseShape(new Error('x'), 200, { ok: true });
  expect(getAssistedPaymentResponseShape(error)).toContain('ok=1');
  expect(getAssistedPaymentResponseShape(new Error('x'))).toBeUndefined();
 });
});

describe('ad blocker classification', () => {
 const urls = [
  'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
  'https://pagead2.googlesyndication.com/pagead/js/lidar.js',
  'https://0151fcp.0151fcb58337f2a80544687514938279fa3f84bc.com/tag/c98741ed-da90-49d5-a83f-d66821a170e5',
 ];

 it('recognises the third-party hosts seen in GA4', () => {
  for (const url of urls) expect(isAdBlockerTriggerUrl(url)).toBe(true);
 });

 it('leaves first-party chunks alone, so their reload recovery still runs', () => {
  for (const url of [
   'https://cdn.frontaliereticino.ch/assets/App.js',
   'https://cdn.frontaliereticino.ch/assets/releases/1793390164535/GptAdSlot.js',
  ]) expect(isAdBlockerTriggerUrl(url)).toBe(false);
 });

 it('keeps both inline index.html copies in sync with the shared list', () => {
  const html = readFileSync('index.html', 'utf8');
  const copies = [...html.matchAll(/var isAdBlocked = \/(.+?)\/i\.test/g)].map((m) => m[1]);
  expect(copies).toEqual([AD_BLOCKER_TRIGGER_PATTERN_SOURCE, AD_BLOCKER_TRIGGER_PATTERN_SOURCE]);
 });
});

describe('newsletter confirmation refusal', () => {
 const source = readFileSync('services/newsletterSubscribers.ts', 'utf8');

 it('treats the cooldown as an email already sent', () => {
  expect(source).toContain("if (!confirmation.success && confirmation.error !== 'cooldown_active') {");
 });

 it('reports which refusal it was', () => {
  expect(source).toContain('`newsletter/confirmation-email-failed:${refusal}`');
 });
});
