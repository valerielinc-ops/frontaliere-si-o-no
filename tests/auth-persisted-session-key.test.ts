// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/services/authService');

const { getFirebaseAuthPersistenceKey } = await import('@/services/firebaseAuthPersistence');
const { hasPersistedAuthSession } = await import('@/services/authService');
const ACTIVE_PERSISTENCE_KEY = getFirebaseAuthPersistenceKey();

describe('persisted Firebase auth session detection', () => {
 beforeEach(() => {
 window.localStorage.clear();
 });

 it('checks only the active Firebase persistence key', () => {
 window.localStorage.setItem('firebase:authUser:stale-api-key:[DEFAULT]', '{}');
 expect(hasPersistedAuthSession()).toBe(false);

 window.localStorage.setItem(ACTIVE_PERSISTENCE_KEY, '{}');
 expect(hasPersistedAuthSession()).toBe(true);
 });

 it('returns before reading localStorage during SSR', () => {
 vi.stubGlobal('window', undefined);
 expect(hasPersistedAuthSession()).toBe(false);
 vi.unstubAllGlobals();
 });
});
