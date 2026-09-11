/**
 * Firebase Auth persistence helpers.
 *
 * The Firebase Web API key is public client configuration, but it must not be
 * a source or build artifact literal. The runtime Firebase bootstrap loads it
 * from the public Remote Config endpoint and calls `setFirebaseApiKey()`.
 * Before that asynchronous bootstrap completes, callers use an explicit
 * project-independent marker written by authService after a successful sign-in.
 */

const DEFAULT_FIREBASE_APP_NAME = '[DEFAULT]';
const FIREBASE_AUTH_STORAGE_PREFIX = 'firebase:authUser:';
export const FIREBASE_AUTH_SESSION_MARKER_KEY = 'frontaliere:auth-session';

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
type FirebaseAuthMarkerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Mirror the authenticated state for synchronous pre-bootstrap consumers.
 *
 * This is deliberately an opaque, project-independent marker rather than a
 * scan of Firebase's namespace. A browser can retain sessions for multiple
 * Firebase projects, and the namespace alone cannot tell this site which one
 * is active. Only authService writes this marker after Firebase confirms the
 * state, and the null transition removes it.
 */
export function setFirebaseAuthSessionMarker(
  storage: FirebaseAuthMarkerStorage | null | undefined,
  authenticated: boolean,
): void {
  if (!storage) return;
  try {
    if (authenticated) {
      storage.setItem(FIREBASE_AUTH_SESSION_MARKER_KEY, 'true');
    } else {
      storage.removeItem(FIREBASE_AUTH_SESSION_MARKER_KEY);
    }
  } catch {
    // localStorage may be disabled, blocked, or throw in privacy mode.
  }
}

/** Read the explicit auth marker without inferring state from other keys. */
export function hasFirebaseAuthSessionMarker(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(FIREBASE_AUTH_SESSION_MARKER_KEY) === 'true';
  } catch {
    // localStorage may be disabled, blocked, or throw in privacy mode.
    return false;
  }
}

/**
 * Detect a persisted Firebase Auth session.
 *
 * Once runtime configuration is known, only the active project's exact key is
 * accepted. Before then, the explicit marker keeps the synchronous static
 * Offerwall gate useful without embedding a key in HTML or JavaScript or
 * mistaking another Firebase project's session for this site's session.
 */
export function hasFirebaseAuthPersistence(storage: FirebaseAuthStorage | null | undefined): boolean {
  if (!storage) return false;

  try {
    const activeKey = getFirebaseAuthPersistenceKey();
    if (activeKey) return storage.getItem(activeKey) !== null;
    return hasFirebaseAuthSessionMarker(storage);
  } catch {
    // localStorage may be disabled, blocked, or throw in privacy mode.
  }

  return false;
}
