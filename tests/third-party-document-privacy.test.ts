import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { URL as NodeURL, fileURLToPath, pathToFileURL } from 'node:url';
import { TextEncoder } from 'node:util';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { serializeStaticFunction } from '../build-plugins/shared/serializeStaticFunction';
import { ADS_CONSENT_STORAGE_KEY } from '../services/adsConsent';
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
 it('compiles the same self-contained controllers in Node and Vite SSR', async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, hmr: false } });
  try {
   const ssr = await server.ssrLoadModule('/build-plugins/shared/serializeStaticFunction.ts');
   for (const [file, name] of [['manualAdLifecycle', 'observeManualAd'], ['adSlotKinds', 'isManualSlot'], ['staticAdSlotEligibility', 'createStaticAdSlotEligibility']]) {
    const url = new NodeURL(`../services/${file}.ts`, import.meta.url);
    const source = serializeStaticFunction(url, name);
    expect(ssr.serializeStaticFunction(url, name)).toBe(source);
    expect(source).not.toContain('__name(');
    expect(source).not.toContain('require(');
    expect(source).not.toContain('import(');
    expect(typeof new Function(`return ${source}`)()).toBe('function');
   }
   const constants = await server.ssrLoadModule('/build-plugins/constants.ts');
   expect(constants.ADSENSE_LOADER_CONTENT).toBe(ADSENSE_LOADER_CONTENT);
   expect(constants.PARTNERIZE_TAG_CONTENT).toBe(PARTNERIZE_TAG_CONTENT);
  } finally { await server.close(); }
 });
 it('imports and compiles in a mixed DOM/Node realm without loading esbuild JS', () => {
  const helperUrl = new NodeURL('../build-plugins/shared/serializeStaticFunction.ts', import.meta.url);
  const require = createRequire(helperUrl);
  const esbuildUrl = pathToFileURL(require.resolve('esbuild'));
  const mixedContext = (url: NodeURL) => {
   const exports = {};
   return vm.createContext({ exports, module: { exports }, require: createRequire(url),
    __filename: fileURLToPath(url), __dirname: dirname(fileURLToPath(url)),
    TextEncoder, Buffer, process,
   });
  };
  const broken = mixedContext(esbuildUrl);
  expect(vm.runInContext('new TextEncoder().encode("") instanceof Uint8Array', broken)).toBe(false);
  expect(() => vm.runInContext(readFileSync(esbuildUrl, 'utf8'), broken)).toThrow(/Invariant violation/);
  const context = mixedContext(helperUrl);
  const source = ts.transpileModule(readFileSync(helperUrl, 'utf8'), {
   compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/import\.meta\.url/g, JSON.stringify(helperUrl.href));
  vm.runInContext(source, context);
  for (const [file, name] of [['manualAdLifecycle', 'observeManualAd'], ['adSlotKinds', 'isManualSlot'], ['staticAdSlotEligibility', 'createStaticAdSlotEligibility']]) {
   const url = new NodeURL(`../services/${file}.ts`, import.meta.url);
   expect(context.module.exports.serializeStaticFunction(url, name)).toBe(serializeStaticFunction(url, name));
  }
  expect(vm.runInContext('new TextEncoder().encode("") instanceof Uint8Array', context)).toBe(false);
 });
 it('runs the full clean Ads bootstrap through eligibility and requests the SDK', () => {
  const dom = new JSDOM('<!doctype html><head></head><body></body>', { url: clean, runScripts: 'outside-only' });
  try {
   const idle: Array<() => void> = [];
   Object.defineProperty(dom.window.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1' });
   Object.defineProperty(dom.window, 'requestIdleCallback', { value: (cb: () => void) => { idle.push(cb); return 1; } });
   Object.defineProperty(dom.window, 'setTimeout', { value: () => 1 });
   dom.window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
   vm.runInContext(ADSENSE_LOADER_CONTENT, dom.getInternalVMContext());
   dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
   for (const cb of idle) cb();
   expect(dom.window.document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]') !== null).toBe(true);
  } finally { dom.window.close(); }
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
