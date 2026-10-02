// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Firebase runtime config recovery', () => {
  const app = { name: 'recovered-app' };
  const initializeApp = vi.fn(() => app);

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('FIREBASE_API_KEY', '');
    vi.stubEnv('VITE_FIREBASE_API_KEY', '');
    vi.doMock('firebase/app', () => ({ initializeApp }));
    vi.doMock('@/services/errorReporter', () => ({ reportCaughtError: vi.fn() }));
  });

  afterEach(() => {
    vi.doUnmock('firebase/app');
    vi.doUnmock('@/services/errorReporter');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it.each(['network', 'http', 'empty'])('initializes once when the first %s failure is recovered by a fresh config', async (failure) => {
    const fetchMock = vi.fn();
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('temporary network failure'));
    else fetchMock.mockResolvedValueOnce({ ok: failure === 'empty', status: failure === 'empty' ? 200 : 503, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ FIREBASE_API_KEY: 'recovered-public-key' }) });
    vi.stubGlobal('fetch', fetchMock);

    const firebase = await vi.importActual<typeof import('../services/firebase')>('../services/firebase');
    expect(await Promise.all([firebase.getApp(), firebase.getApp()])).toEqual([app, app]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/getPublicConfig\?t=\d+$/);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    expect(initializeApp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ apiKey: 'recovered-public-key' }));
    expect(await firebase.getApp()).toBe(app);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows a later caller to retry after initialization has failed without a key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ FIREBASE_API_KEY: 'recovered-public-key' }) });
    vi.stubGlobal('fetch', fetchMock);
    const firebase = await vi.importActual<typeof import('../services/firebase')>('../services/firebase');

    await expect(firebase.getApp()).rejects.toThrow('Firebase Web API key unavailable from runtime public config');
    expect(initializeApp).not.toHaveBeenCalled();
    await expect(firebase.getApp()).resolves.toBe(app);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });
});
