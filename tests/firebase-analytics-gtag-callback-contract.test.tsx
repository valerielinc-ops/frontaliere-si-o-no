import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

// Exercise the installed Firebase SDK, not the shared setup's analytics mock.
// The Google tag terminal is a local recorder: no script or request is sent.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('Firebase relays event_callback intact and only Google tag processing invokes it', async () => {
  const [{ initializeApp, deleteApp }, sdk, { Component }] = await Promise.all([
    vi.importActual<typeof import('firebase/app')>('firebase/app'),
    vi.importActual<typeof import('firebase/analytics')>('firebase/analytics'),
    vi.importActual<typeof import('@firebase/component')>('@firebase/component'),
  ]);
  const commands: unknown[][] = [];
  const terminal = vi.fn((...args: unknown[]) => { commands.push(args); });
  const originalGtag = Object.getOwnPropertyDescriptor(window, 'gtag');
  Object.defineProperty(window, 'gtag', { configurable: true, writable: true, value: terminal });
  const script = document.createElement('script');
  script.type = 'application/x-gtag-contract';
  script.src = 'https://www.googletagmanager.com/gtag/js?l=dataLayer&id=G-TEST000000';
  document.head.appendChild(script); // Inert type: prevents the SDK inserting a live loader.
  const network = vi.fn(() => Promise.reject(new Error('network forbidden in SDK contract test')));
  vi.stubGlobal('fetch', network);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Without an API key, the SDK uses the supplied measurement ID and makes
  // no config fetch. The installations provider is also strictly local.
  const app = initializeApp({ appId: '1:123456789:web:callback-test', measurementId: 'G-TEST000000' }, 'gtag-callback-contract');
  (app as unknown as { _container: { addOrOverwriteComponent: (value: unknown) => void } })._container.addOrOverwriteComponent(
    new Component('installations-internal', () => ({ getId: async () => 'local-test-fid', getToken: async () => 'local-test-token' }), 'PRIVATE'),
  );
  try {
    const analytics = sdk.initializeAnalytics(app, { config: { send_page_view: false } });
    const callback = vi.fn();
    const result = sdk.logEvent(analytics, 'application_concierge_checkout_resume', {
      price_eur_cents: 3999, event_callback: callback,
    });
    expect(result).toBeUndefined();
    await waitFor(() => expect(commands.filter(([command, name]) => command === 'event' && name === 'application_concierge_checkout_resume')).toHaveLength(1));
    const event = commands.find(([command, name]) => command === 'event' && name === 'application_concierge_checkout_resume')!;
    const parameters = event[2] as { event_callback: () => void; send_to: string; price_eur_cents: number };
    expect(parameters.event_callback).toBe(callback);
    expect(parameters.send_to).toBe('G-TEST000000');
    expect(parameters.price_eur_cents).toBe(3999);
    expect(callback).not.toHaveBeenCalled();
    // The real SDK has now delivered the command to its gtag terminal.
    // Simulate the documented Google tag processing completion, not an SDK return.
    parameters.event_callback();
    expect(callback).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();
  } finally {
    await deleteApp(app);
    script.remove();
    if (originalGtag) Object.defineProperty(window, 'gtag', originalGtag);
    else Reflect.deleteProperty(window, 'gtag');
  }
});
