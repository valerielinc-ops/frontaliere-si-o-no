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
 THIRD_PARTY_DOCUMENT_INITIAL_GUARD,
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
   if (key === 'documentElement') return undefined;
   if (key === 'querySelectorAll') return () => { throw new Error('DOM cannot be attested'); };
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
 it('restores Ads exactly once on clean SPA mutations and disconnects its deferred retry', async () => {
  const dom = new JSDOM('<!doctype html><head></head><body><iframe></iframe></body>', { url: signed, runScripts: 'outside-only' });
  try {
   const idle: Array<() => void> = [];
   const observed: Array<{ disconnected: boolean }> = [];
   const NativeObserver = dom.window.MutationObserver;
   Object.defineProperty(dom.window, 'MutationObserver', { value: class extends NativeObserver {
    state = { disconnected: false };
    constructor(cb: MutationCallback) { super(cb); observed.push(this.state); }
    disconnect() { this.state.disconnected = true; super.disconnect(); }
   } });
   Object.defineProperty(dom.window.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1' });
   Object.defineProperty(dom.window, 'requestIdleCallback', { value: (cb: () => void) => { idle.push(cb); return 1; } });
   Object.defineProperty(dom.window, 'setTimeout', { value: () => 1 });
   dom.window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
   dom.window.document.querySelector('iframe')!.setAttribute('src', `https://ads.example.test/frame?url=${encodeURIComponent(signed)}`);
   const context = dom.getInternalVMContext();
   vm.runInContext(THIRD_PARTY_DOCUMENT_INITIAL_GUARD, context);
   dom.reconfigure({ url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/?utm_source=email' });
   vm.runInContext(ADSENSE_LOADER_CONTENT, context);
   expect(dom.window.document.querySelector('script[src*="adsbygoogle.js"]')).toBe(null);
   for (let retry = 0; retry < 3; retry++) {
    dom.window.document.body.setAttribute('data-retry', String(retry));
    await Promise.resolve();
   }
   expect(dom.window.document.querySelector('script[src*="adsbygoogle.js"]')).toBe(null);
   dom.window.document.querySelector('iframe')!.remove();
   await Promise.resolve();
   dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
   for (const cb of idle.splice(0)) cb();
   vm.runInContext(ADSENSE_LOADER_CONTENT, context);
   dom.window.dispatchEvent(new dom.window.Event('popstate'));
   await Promise.resolve();
   expect(dom.window.document.querySelectorAll('script[src*="adsbygoogle.js"]')).toHaveLength(1);
   expect(observed[0].disconnected).toBe(true);
   expect((dom.window as unknown as PrivacyWindow).__FT_SENSITIVE_DOCUMENT__).toBe(true);
  } finally { dom.window.close(); }
 });
 it('keeps sensitive referrers, residual structured URLs and unreadable DOM fail-closed after cleanup', () => {
  const dom = new JSDOM('<!doctype html><body><script type="application/ld+json"></script></body>', { url: clean });
  try {
   const win = dom.window as unknown as PrivacyWindow;
   const script = dom.window.document.querySelector('script')!;
   script.textContent = JSON.stringify({ url: `https://ads.example.test/frame?url=${encodeURIComponent(signed)}` });
   expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, dom.window.document, true)).toBe(true);
   script.textContent = '{';
   expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, dom.window.document, true)).toBe(true);
   script.remove();
   Object.defineProperty(dom.window.document, 'referrer', { value: signed });
   expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, dom.window.document, true)).toBe(true);
   expect(isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, win, { referrer: '' }, true)).toBe(true);
  } finally { dom.window.close(); }
 });
 it('keeps Partnerize vendor initialization on ordinary documents', async () => {
  const win = browser(clean) as PrivacyWindow & Record<string, unknown>;
  const appended: Array<Record<string, unknown>> = [];
  const listeners: Record<string, () => void> = {};
  const requests: Array<{ url: string; body: string }> = [];
  Object.assign(win, { crypto: { subtle: { digest: async () => new ArrayBuffer(20) } } });
  const doc = {
   referrer: '', readyState: 'loading', createElement: () => ({}),
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
 it('starts deferred Partnerize once after DOMContentLoaded and a clean mutation, then disconnects', async () => {
  const dom = new JSDOM('<!doctype html><body><iframe></iframe></body>', { url: signed, runScripts: 'outside-only' });
  try {
   let disconnected = 0;
   const requests: Array<{ body: string }> = [];
   const NativeObserver = dom.window.MutationObserver;
   Object.defineProperty(dom.window, 'MutationObserver', { value: class extends NativeObserver {
    disconnect() { disconnected++; super.disconnect(); }
   } });
   Object.defineProperty(dom.window, 'crypto', { value: { subtle: { digest: async () => new ArrayBuffer(20) } } });
   Object.assign(dom.window, { TextEncoder, fetch: async (_url: string, options: { body: string }) => { requests.push(options); } });
   const frame = dom.window.document.querySelector('iframe')!;
   frame.src = `https://ads.example.test/frame?url=${encodeURIComponent(signed)}`;
   const context = dom.getInternalVMContext();
   vm.runInContext(THIRD_PARTY_DOCUMENT_INITIAL_GUARD, context);
   vm.runInContext(PARTNERIZE_TAG_CONTENT, context);
   await Promise.resolve(); await Promise.resolve();
   expect(dom.window.document.readyState).toBe('complete');
   dom.reconfigure({ url: clean });
   dom.window.document.body.setAttribute('data-retry', 'still-unsafe');
   await Promise.resolve();
   expect(dom.window.document.querySelectorAll('script')).toHaveLength(0);
   frame.remove();
   for (let i = 0; i < 8; i++) await Promise.resolve();
   vm.runInContext(PARTNERIZE_TAG_CONTENT, context);
   dom.window.dispatchEvent(new dom.window.Event('popstate'));
   expect(dom.window.document.querySelectorAll('script')).toHaveLength(1);
   expect(disconnected).toBe(1);
   dom.window.document.querySelector('script')!.dispatchEvent(new dom.window.Event('load'));
   expect(requests).toHaveLength(1);
   expect(JSON.parse(requests[0].body).url).toBe(clean);
  } finally { dom.window.close(); }
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
  expect(PARTNERIZE_TAG_SNIPPET).toBe(`<script>${THIRD_PARTY_DOCUMENT_INITIAL_GUARD}</script><script defer src="/assets/${PARTNERIZE_TAG_VERSIONED_FILENAME}"></script>`);
  expect(THIRD_PARTY_DOCUMENT_INITIAL_GUARD).not.toContain('</script');
 });
 it('invalidates the transported fingerprint when either producer or helper changes', () => {
  const snapshot = thirdPartyShellAssetSnapshot();
  const fingerprint = { ...snapshot, initialDocumentGuard: { sha256: snapshot.initialDocumentGuard.sha256 }, assets: snapshot.assets.map(({ content: _content, ...asset }) => asset) };
  expect(fingerprint).toEqual(JSON.parse(readFileSync(new NodeURL('./third-party-shell-assets-fingerprint.json', import.meta.url), 'utf8')));
 });
 it('captures the signed context inline before cleanup without a blocking CDN request', () => {
  const win = browser();
  const doc = { referrer: '' };
  const context = vm.createContext({ window: win, document: doc, URL, URLSearchParams });
  vm.runInContext(THIRD_PARTY_DOCUMENT_INITIAL_GUARD, context);
  win.location.href = clean;
  // The deferred producer arrives after React has redeemed and cleaned the URL.
  vm.runInContext(PARTNERIZE_TAG_CONTENT, context);
  expect(win.__FT_SENSITIVE_DOCUMENT__).toBe(true);
  expect(win.location.href).toBe(clean);
 });
 it('transforms root HTML to the same inline guard and deferred producer before React', () => {
  const source = readFileSync(new NodeURL('../index.html', import.meta.url), 'utf8');
  const hook = staticScriptsPlugin('.').transformIndexHtml as { handler: (html: string) => string };
  const html = hook.handler(source);
  expect(html).toContain(PARTNERIZE_TAG_SNIPPET);
  expect(html).not.toContain('<script src="/assets/partnerize-tag.js"></script>');
  expect(html.indexOf(PARTNERIZE_TAG_SNIPPET)).toBeLessThan(html.indexOf('type="module"'));
 });
});
