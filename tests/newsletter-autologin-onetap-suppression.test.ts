import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

// The newsletter-autologin-in-flight signal is computed at module load from
// window.location.search (before App.tsx strips the newsletter params), so each
// case sets the URL, then re-imports the signal module fresh via resetModules().

const ORIGINAL_LOCATION = window.location;

function setSearch(search: string): void {
 Object.defineProperty(window, 'location', {
 configurable: true,
 value: new URL(`https://frontaliereticino.ch/articoli-frontaliere/x/${search}`),
 });
}

async function freshSignal() {
 vi.resetModules();
 // Avoid leaving a real 8s backstop timer dangling after the test process.
 vi.spyOn(window, 'setTimeout').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
 return import('@/services/newsletterAutologinSignal');
}

afterEach(() => {
 Object.defineProperty(window, 'location', { configurable: true, value: ORIGINAL_LOCATION });
 vi.restoreAllMocks();
});

describe('newsletter autologin → sign-in affordance suppression', () => {
 it('is in-flight when the URL carries an autologin code + recipient email', async () => {
 setSearch('?ne=a%40b.com&ac=deadbeef&utm_medium=newsletter');
 const sig = await freshSignal();
 expect(sig.isNewsletterAutologinInFlight()).toBe(true);
 });

 it('settles to false, notifies subscribers, and is idempotent', async () => {
 setSearch('?ne=a%40b.com&ac=deadbeef');
 const sig = await freshSignal();
 const cb = vi.fn();
 const unsub = sig.subscribeNewsletterAutologin(cb);

 expect(sig.isNewsletterAutologinInFlight()).toBe(true);
 sig.settleNewsletterAutologin();
 expect(sig.isNewsletterAutologinInFlight()).toBe(false);
 expect(cb).toHaveBeenCalledTimes(1);

 sig.settleNewsletterAutologin(); // second call must be a no-op
 expect(cb).toHaveBeenCalledTimes(1);
 unsub();
 });

 it('subscribe is a no-op (returns a safe unsubscribe) once already settled', async () => {
 setSearch(''); // not in flight
 const sig = await freshSignal();
 const cb = vi.fn();
 const unsub = sig.subscribeNewsletterAutologin(cb);
 sig.settleNewsletterAutologin();
 expect(cb).not.toHaveBeenCalled();
 expect(() => unsub()).not.toThrow();
 });

 it('is NOT in-flight for a plain newsletter link without an autologin code', async () => {
 setSearch('?ne=a%40b.com&utm_medium=newsletter');
 const sig = await freshSignal();
 expect(sig.isNewsletterAutologinInFlight()).toBe(false);
 });

 it('is NOT in-flight for unsubscribe / resubscribe actions', async () => {
 setSearch('?ne=a%40b.com&ac=x&action=unsubscribe');
 const sig = await freshSignal();
 expect(sig.isNewsletterAutologinInFlight()).toBe(false);
 });
});

describe('promptOneTap suppression wiring', () => {
 it('promptOneTap bails out while a newsletter autologin is in flight', () => {
 const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');
 // Guard sits before any Firebase/GIS work at the top of promptOneTap.
 expect(source).toContain('if (isNewsletterAutologinInFlight()) return;');
 expect(source).toContain("from '@/services/newsletterAutologinSignal'");
 });
});
