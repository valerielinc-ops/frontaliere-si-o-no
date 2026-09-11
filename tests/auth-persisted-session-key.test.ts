// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/services/authService');

const {
  FIREBASE_AUTH_SESSION_MARKER_KEY,
  getFirebaseAuthPersistenceKey,
  setFirebaseApiKey,
  setFirebaseAuthSessionMarker,
} = await import('@/services/firebaseAuthPersistence');
const { hasPersistedAuthSession } = await import('@/services/authService');
setFirebaseApiKey('runtime-api-key');
const ACTIVE_PERSISTENCE_KEY = getFirebaseAuthPersistenceKey();

describe('persisted Firebase auth session detection', () => {
 beforeEach(() => {
  setFirebaseApiKey('runtime-api-key');
  window.localStorage.clear();
 });

 it('checks only the active Firebase persistence key', () => {
 window.localStorage.setItem('firebase:authUser:stale-api-key:[DEFAULT]', '{}');
 expect(hasPersistedAuthSession()).toBe(false);

 window.localStorage.setItem(ACTIVE_PERSISTENCE_KEY, '{}');
 expect(hasPersistedAuthSession()).toBe(true);
 });

 it('uses only the explicit marker until runtime configuration is available', () => {
  setFirebaseApiKey('');
  window.localStorage.setItem('firebase:authUser:runtime-project:[DEFAULT]', '{}');
  expect(hasPersistedAuthSession()).toBe(false);

  setFirebaseAuthSessionMarker(window.localStorage, true);
  expect(window.localStorage.getItem(FIREBASE_AUTH_SESSION_MARKER_KEY)).toBe('true');
  expect(hasPersistedAuthSession()).toBe(true);

  setFirebaseAuthSessionMarker(window.localStorage, false);
  expect(hasPersistedAuthSession()).toBe(false);
 });

 it('returns before reading localStorage during SSR', () => {
 vi.stubGlobal('window', undefined);
 expect(hasPersistedAuthSession()).toBe(false);
 vi.unstubAllGlobals();
 });
});
