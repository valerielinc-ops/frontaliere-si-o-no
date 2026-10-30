import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { URL as NodeURL } from 'node:url';
import { TextEncoder } from 'node:util';
import { sanitizeTelemetryProperties } from '../services/analyticsUrlPrivacy.js';
import { isSensitiveThirdPartyDocument } from '../services/thirdPartyDocumentPrivacy.js';
import {
 ADSENSE_LOADER_CONTENT, ADSENSE_LOADER_VERSIONED_FILENAME, ADSENSE_LAZY_LOADER,
 PARTNERIZE_TAG_CONTENT, PARTNERIZE_TAG_VERSIONED_FILENAME, PARTNERIZE_TAG_SNIPPET,
} from '../build-plugins/constants';
import { thirdPartyShellAssetSnapshot } from '../scripts/ci/export-third-party-shell-assets';
import { listStaticScriptFiles, staticScriptsPlugin } from '../build-plugins/staticScriptsPlugin';

const clean = 'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/?application_concierge_service_id=service-test&utm_source=email';
const signed = `${clean}&ac=synthetic-code&ne=candidate%40example.test`;
type PrivacyWindow = Parameters<typeof isSensitiveThirdPartyDocument>[1];
const browser = (href = signed) => ({ location: { href } }) as PrivacyWindow;

describe('signed-origin autonomous SDK startup', () => {
 it.each([signed, `${clean}&authToken=synthetic-token`, `${clean}#ac=synthetic-code&bad=%ZZ`])('latches a sensitive href before cleanup', (href) => {
  const win = browser(href);
  expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, { referrer: '' })).toBe(true);
  expect(win.location.href).toBe(href);
  win.location.href = clean;
  expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, { referrer: '' })).toBe(true);
  expect(win.location.href).toBe(clean);
 });
 it('latches a sensitive referrer even with a clean current URL', () => {
  const win = browser(clean);
  expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, { referrer: signed })).toBe(true);
  expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, { referrer: '' })).toBe(true);
 });
 it('uses the immutable attempted signal when a SPA chunk loads after cleanup', () => {
  const win = browser(clean);
  expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, { referrer: '' }, true)).toBe(true);
  expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, { referrer: '' }, false)).toBe(true);
 });
 it('preserves ordinary unsigned visits and campaign/service context', () => {
  const win = browser(clean);
  expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, { referrer: '' })).toBe(false);
  expect(win.location.href).toBe(clean);
 });
 it.each([['Ads', ADSENSE_LOADER_CONTENT], ['Partnerize', PARTNERIZE_TAG_CONTENT]])('%s real bootstrap performs no work on a signed document, including retries', (_name, source) => {
  const win = browser();
  let touched = 0;
  const doc = new Proxy({ referrer: '' }, { get(target, key) {
   if (key === 'referrer') return target.referrer;
   touched += 1;
   throw new Error('SDK touched DOM before the privacy guard');
  } });
  const context = vm.createContext({ window: win, document: doc, URL, URLSearchParams });
  vm.runInContext(source, context);
  win.location.href = clean;
  // Models success/failure cleanup, later consent/idle/interaction/retry entry.
  for (let i = 0; i < 4; i++) vm.runInContext(source, context);
  expect(touched).toBe(0);
  expect(win.location.href).toBe(clean);
 });
 it('keeps Partnerize vendor initialization on ordinary documents', async () => {
  const win = browser(clean) as PrivacyWindow & Record<string, unknown>;
  const appended: Array<Record<string, unknown>> = [];
  const listeners: Record<string, () => void> = {};
  const requests: Array<{ url: string; body: string }> = [];
  Object.assign(win, { crypto: { subtle: { digest: async () => new ArrayBuffer(20) } } });
  const doc = {
   referrer: '', createElement: () => ({}),
   body: { appendChild: (script: Record<string, unknown>) => appended.push(script) },
   addEventListener: (event: string, cb: () => void) => { listeners[event] = cb; },
  };
  const context = vm.createContext({ window: win, document: doc, URL, URLSearchParams, TextEncoder,
   fetch: async (url: string, options: { body: string }) => { requests.push({ url, body: options.body }); },
  });
  vm.runInContext(PARTNERIZE_TAG_CONTENT, context);
  expect(appended).toHaveLength(0);
  listeners.DOMContentLoaded();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(appended).toHaveLength(1);
  (appended[0].onload as () => void)();
  expect(JSON.parse(requests[0].body).url).toBe(clean);
 });
 it('publishes hash-bound protected assets plus stable aliases', () => {
  const files = new Map(listStaticScriptFiles());
  for (const [name, source, stable] of [
   [ADSENSE_LOADER_VERSIONED_FILENAME, ADSENSE_LOADER_CONTENT, 'adsense-loader.js'],
   [PARTNERIZE_TAG_VERSIONED_FILENAME, PARTNERIZE_TAG_CONTENT, 'partnerize-tag.js'],
  ]) {
   expect(name).toContain(createHash('sha256').update(source).digest('hex').slice(0, 12));
   expect(files.get(name)).toBe(source);
   expect(files.get(stable)).toBe(source);
  }
  expect(ADSENSE_LAZY_LOADER).toContain(ADSENSE_LOADER_VERSIONED_FILENAME);
  expect(PARTNERIZE_TAG_SNIPPET).toBe(`<script src="/assets/${PARTNERIZE_TAG_VERSIONED_FILENAME}"></script>`);
 });
 it('invalidates the transported fingerprint when either producer or helper changes', () => {
  const snapshot = thirdPartyShellAssetSnapshot();
  const fingerprint = { ...snapshot, assets: snapshot.assets.map(({ content: _content, ...asset }) => asset) };
  expect(fingerprint).toEqual(JSON.parse(readFileSync(new NodeURL('./third-party-shell-assets-fingerprint.json', import.meta.url), 'utf8')));
 });
 it('transforms root HTML to the same synchronous producer before React', () => {
  const source = readFileSync(new NodeURL('../index.html', import.meta.url), 'utf8');
  const hook = staticScriptsPlugin('.').transformIndexHtml as { handler: (html: string) => string };
  const html = hook.handler(source);
  expect(html).toContain(PARTNERIZE_TAG_SNIPPET);
  expect(html).not.toContain('<script src="/assets/partnerize-tag.js"></script>');
  expect(html.indexOf(PARTNERIZE_TAG_SNIPPET)).toBeLessThan(html.indexOf('type="module"'));
 });
});
