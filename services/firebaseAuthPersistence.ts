/**
 * Firebase Auth persistence helpers.
 *
 * The Firebase Web API key is public client configuration, but it must not be
 * a source or build artifact literal. The runtime Firebase bootstrap loads it
 * from the public Remote Config endpoint and calls `setFirebaseApiKey()`.
 * Before that asynchronous bootstrap completes, callers use the stable
 * `firebase:authUser:` storage namespace as a conservative fallback.
 */

const DEFAULT_FIREBASE_APP_NAME = '[DEFAULT]';
const FIREBASE_AUTH_STORAGE_PREFIX = 'firebase:authUser:';

let activeFirebaseApiKey = '';

/** Set the key received from runtime configuration without persisting it. */
export function setFirebaseApiKey(apiKey: string): void {
  const normalized = apiKey.trim();
  activeFirebaseApiKey = normalized;
}

/** Return the key currently received from runtime configuration, if any. */
export function getFirebaseApiKey(): string {
  return activeFirebaseApiKey;
}

/** Firebase Auth's browser persistence key for the default app. */
export function getFirebaseAuthPersistenceKey(): string {
  if (!activeFirebaseApiKey) return '';
  return `${FIREBASE_AUTH_STORAGE_PREFIX}${activeFirebaseApiKey}:${DEFAULT_FIREBASE_APP_NAME}`;
}

type FirebaseAuthStorage = Pick<Storage, 'length' | 'key' | 'getItem'>;

/**
 * Detect a persisted Firebase Auth session.
 *
 * Once runtime configuration is known, only the active project's exact key is
 * accepted. Before then, scanning the namespace keeps the synchronous static
 * Offerwall gate useful without embedding a key in HTML or JavaScript.
 */
export function hasFirebaseAuthPersistence(storage: FirebaseAuthStorage | null | undefined): boolean {
  if (!storage) return false;

  try {
    const activeKey = getFirebaseAuthPersistenceKey();
    if (activeKey) return storage.getItem(activeKey) !== null;

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(FIREBASE_AUTH_STORAGE_PREFIX)) return true;
    }
  } catch {
    // localStorage may be disabled, blocked, or throw in privacy mode.
  }

  return false;
}
