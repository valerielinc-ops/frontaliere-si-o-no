import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ consent: true, referrer: '', getConfigValue: vi.fn() }));
vi.mock('@/services/consentService', () => ({ isAnalyticsGranted: () => config.consent }));
vi.mock('@/services/firebase', () => ({ getConfigValue: config.getConfigValue }));
vi.mock('@/services/errorReporter', () => ({ reportCaughtError: vi.fn() }));
vi.mock('@/services/resilientImport', () => ({ resilientImport: (load: () => Promise<unknown>) => load() }));

const cleanUrl = 'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/?application_concierge_service_id=service-test&utm_source=email&utm_medium=payment_reminder';
const signedUrl = cleanUrl + '&ne=candidate%40example.test&ac=synthetic-code';
const scripts = () => document.querySelectorAll('script[src^="https://www.clarity.ms/tag/"]');

function setUrl(url: string) {
 vi.stubGlobal('window', { location: new URL(url), setTimeout });
}

async function loadClarity() {
 const clarity = await import('@/services/clarity');
 const signal = await import('@/services/newsletterAutologinSignal');
 return { ...clarity, ...signal };
}

beforeEach(() => {
 vi.resetModules();
 vi.useFakeTimers();
 config.consent = true;
 config.referrer = '';
 config.getConfigValue.mockReset().mockResolvedValue('test-project');
 setUrl(cleanUrl);
 vi.spyOn(document, 'referrer', 'get').mockImplementation(() => config.referrer);
});

afterEach(() => {
 scripts().forEach(script => script.remove());
 vi.useRealTimers();
 vi.unstubAllGlobals();
 vi.restoreAllMocks();
});

describe('Clarity initialization on signed payment links', () => {
 it('loads normally once on a clean campaign URL and leaves it unchanged', async () => {
 const { initClarity } = await loadClarity();
 await initClarity();
 await initClarity();
 expect(scripts()).toHaveLength(1);
 expect(window.location.href).toBe(cleanUrl);
 });

 it.each(['success', 'failure', 'expired'])('keeps the signed-origin document excluded after auth %s', async () => {
 setUrl(signedUrl);
 const { initClarity, settleNewsletterAutologin } = await loadClarity();
 await initClarity();
 expect(scripts()).toHaveLength(0);
 expect(config.getConfigValue).not.toHaveBeenCalled();
 expect(window.location.href).toBe(signedUrl);
 // App's finally removes credentials before settling, on both outcomes.
 setUrl(cleanUrl);
 settleNewsletterAutologin();
 await initClarity();
 expect(scripts()).toHaveLength(0);
 expect(window.location.href).toBe(cleanUrl);
 });

 it('does not let the auth safety timeout or a clean retry reopen the document', async () => {
 setUrl(signedUrl);
 const { initClarity, isNewsletterAutologinInFlight } = await loadClarity();
 const pending = initClarity();
 await vi.advanceTimersByTimeAsync(8000);
 await pending;
 expect(isNewsletterAutologinInFlight()).toBe(false);
 expect(scripts()).toHaveLength(0);
 expect(window.location.href).toBe(signedUrl);
 setUrl(cleanUrl);
 await initClarity();
 expect(scripts()).toHaveLength(0);
 });

 it('does not let a later consent grant reopen the signed-origin document', async () => {
 setUrl(signedUrl);
 const { initClarity, settleNewsletterAutologin } = await loadClarity();
 const pending = initClarity();
 config.consent = false;
 setUrl(cleanUrl);
 settleNewsletterAutologin();
 await pending;
 expect(scripts()).toHaveLength(0);
 config.consent = true;
 await initClarity();
 expect(scripts()).toHaveLength(0);
 });

 it('excludes a late-loaded recorder when an iframe retains the signed URL after cleanup', async () => {
 setUrl(signedUrl);
 // App imports this before redeem, but the Clarity chunk may load afterward.
 const signal = await import('@/services/newsletterAutologinSignal');
 setUrl(cleanUrl);
 signal.settleNewsletterAutologin();
 const iframe = document.createElement('iframe');
 const retainedSrc = 'https://googleads.g.doubleclick.net/pagead/ads?url=' + encodeURIComponent(signedUrl);
 // A detached fixture cannot issue an ad request; it can be attached later.
 iframe.setAttribute('src', retainedSrc);
 const serializedDomAttribute = 'src=' + iframe.getAttribute('src');
 expect(decodeURIComponent(serializedDomAttribute)).toContain('ac=synthetic-code');
 expect(signal.isNewsletterAutologinInFlight()).toBe(false);
 expect(signal.wasNewsletterAutologinAttempted()).toBe(true);
 const { initClarity } = await import('@/services/clarity');
 await initClarity();
 await initClarity();
 expect(scripts()).toHaveLength(0);
 expect(config.getConfigValue).not.toHaveBeenCalled();
 expect(window.location.href).toBe(cleanUrl);
 expect(iframe.getAttribute('src')).toBe(retainedSrc);
 });

 it('rechecks consent after the asynchronous configuration fetch', async () => {
 let finishConfig!: (value: string) => void;
 config.getConfigValue.mockImplementationOnce(() => new Promise<string>(resolve => { finishConfig = resolve; }));
 const { initClarity } = await loadClarity();
 const pending = initClarity();
 await vi.dynamicImportSettled();
 expect(config.getConfigValue).toHaveBeenCalledOnce();
 config.consent = false;
 finishConfig('test-project');
 await pending;
 expect(scripts()).toHaveLength(0);
 });

 it('rechecks the current URL after configuration resolves', async () => {
 let finishConfig!: (value: string) => void;
 config.getConfigValue.mockImplementationOnce(() => new Promise<string>(resolve => { finishConfig = resolve; }));
 const { initClarity } = await loadClarity();
 const pending = initClarity();
 await vi.dynamicImportSettled();
 expect(config.getConfigValue).toHaveBeenCalledOnce();
 setUrl(signedUrl);
 finishConfig('test-project');
 await pending;
 expect(scripts()).toHaveLength(0);
 expect(window.location.href).toBe(signedUrl);
 setUrl(cleanUrl);
 await initClarity();
 expect(scripts()).toHaveLength(0);
 });

 it.each([
 'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/?ne=candidate%40example.test&ac=synthetic-code',
 'https://frontaliereticino.ch/?next=' + encodeURIComponent('login?authToken=synthetic-token'),
 ])('does not initialize with a sensitive referrer: %s', async referrer => {
 config.referrer = referrer;
 const { initClarity } = await loadClarity();
 await initClarity();
 expect(scripts()).toHaveLength(0);
 expect(document.referrer).toBe(referrer);
 expect(window.location.href).toBe(cleanUrl);
 config.referrer = '';
 await initClarity();
 expect(scripts()).toHaveLength(0);
 });

 it('blocks credentials even when no autologin exchange owns them', async () => {
 setUrl(cleanUrl + '&ac=synthetic-code');
 const { initClarity, isNewsletterAutologinInFlight } = await loadClarity();
 expect(isNewsletterAutologinInFlight()).toBe(false);
 await initClarity();
 expect(scripts()).toHaveLength(0);
 setUrl(cleanUrl);
 await initClarity();
 expect(scripts()).toHaveLength(0);
 });

 it('latches a sensitive URL before any await even when consent is initially denied', async () => {
 setUrl(cleanUrl + '&ac=synthetic-code');
 config.consent = false;
 const { initClarity, wasNewsletterAutologinAttempted } = await loadClarity();
 expect(wasNewsletterAutologinAttempted()).toBe(false);
 await initClarity();
 setUrl(cleanUrl);
 config.consent = true;
 await initClarity();
 expect(scripts()).toHaveLength(0);
 expect(config.getConfigValue).not.toHaveBeenCalled();
 });

 it('does not initialize when analytics consent is denied', async () => {
 config.consent = false;
 const { initClarity } = await loadClarity();
 await initClarity();
 expect(scripts()).toHaveLength(0);
 expect(config.getConfigValue).not.toHaveBeenCalled();
 config.consent = true;
 await initClarity();
 expect(scripts()).toHaveLength(1);
 });

 it('keeps non-production hosts excluded', async () => {
 setUrl('https://preview.example.test/?ne=candidate%40example.test&ac=synthetic-code');
 const { initClarity } = await loadClarity();
 await initClarity();
 expect(scripts()).toHaveLength(0);
 expect(config.getConfigValue).not.toHaveBeenCalled();
 });

 it('does not inject duplicate scripts for concurrent callers on a clean document', async () => {
 const { initClarity } = await loadClarity();
 const pending = [initClarity(), initClarity()];
 await Promise.all(pending);
 expect(scripts()).toHaveLength(1);
 });
});
