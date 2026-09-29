// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Firebase optional telemetry Installations guard', () => {
 afterEach(() => {
  vi.doUnmock('firebase/installations');
  vi.doUnmock('firebase/analytics');
  vi.doUnmock('@/services/errorReporter');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
 });

 it('blocks Analytics when Create Installation is permanently denied', async () => {
  vi.resetModules();
  vi.stubEnv('FIREBASE_API_KEY', 'test-api-key');
  vi.stubGlobal('indexedDB', undefined);

  const initializeAnalytics = vi.fn(() => ({ name: 'analytics' }));
  vi.doMock('firebase/installations', () => ({
   getInstallations: vi.fn(() => ({})),
   getToken: vi.fn().mockRejectedValue(Object.assign(
    new Error('Installations: Create Installation request failed with error "403 PERMISSION_DENIED: blocked"'),
    { code: 'installations/request-failed', customData: { serverCode: 403 } },
   )),
  }));
  vi.doMock('firebase/analytics', () => ({ initializeAnalytics }));
  vi.doMock('@/services/errorReporter', () => ({ reportCaughtError: vi.fn() }));

  const firebase = await vi.importActual<typeof import('../services/firebase')>('../services/firebase');
  const result = await firebase.getAnalytics();

  expect(result).toBeNull();
  expect(firebase.isAnalyticsBlocked()).toBe(true);
  expect(initializeAnalytics).not.toHaveBeenCalled();
 });

 it('keeps Analytics eligible when Installations fails transiently', async () => {
  vi.resetModules();
  vi.stubEnv('FIREBASE_API_KEY', 'test-api-key');
  vi.stubGlobal('indexedDB', undefined);

  const initializeAnalytics = vi.fn(() => ({ name: 'analytics' }));
  vi.doMock('firebase/installations', () => ({
   getInstallations: vi.fn(() => ({})),
   getToken: vi.fn().mockRejectedValue(new Error('Installations: Application offline.')),
  }));
  vi.doMock('firebase/analytics', () => ({ initializeAnalytics }));
  vi.doMock('@/services/errorReporter', () => ({ reportCaughtError: vi.fn() }));

  const firebase = await vi.importActual<typeof import('../services/firebase')>('../services/firebase');
  const result = await firebase.getAnalytics();

  expect(result).toEqual({ name: 'analytics' });
  expect(firebase.isAnalyticsBlocked()).toBe(false);
  expect(initializeAnalytics).toHaveBeenCalledTimes(1);
 });
});
