const LEGACY_PROFILE_STORAGE_KEY = 'frontaliere_user_profile';
const PROFILE_STORAGE_PREFIX = `${LEGACY_PROFILE_STORAGE_KEY}:`;

export function userProfileStorageKey(uid?: string | null): string {
  return uid
    ? `${PROFILE_STORAGE_PREFIX}${encodeURIComponent(uid)}`
    : `${PROFILE_STORAGE_PREFIX}anonymous`;
}

export function userWeatherCacheKey(uid?: string | null): string {
  return uid ? `morning_weather_cache:${encodeURIComponent(uid)}` : 'morning_weather_cache:anonymous';
}

export function userLocationCacheKey(uid?: string | null): string {
  return uid ? `user_location_cache:${encodeURIComponent(uid)}` : 'user_location_cache:anonymous';
}

function parseStoredProfile(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** The ownerless legacy profile is offered for explicit recovery after sign-in. */
export function hasLegacyStoredUserProfile(): boolean {
  try {
    return parseStoredProfile(localStorage.getItem(LEGACY_PROFILE_STORAGE_KEY)) !== null;
  } catch {
    return false;
  }
}

export function loadLegacyStoredUserProfileForImport(): Record<string, unknown> | null {
  try {
    return parseStoredProfile(localStorage.getItem(LEGACY_PROFILE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function removeLegacyStoredUserProfileAfterImport(): boolean {
  try {
    localStorage.removeItem(LEGACY_PROFILE_STORAGE_KEY);
    return localStorage.getItem(LEGACY_PROFILE_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

/** Read one account's local profile without falling back across account boundaries. */
export function loadStoredUserProfile(uid?: string | null): Record<string, unknown> | null {
  try {
    return parseStoredProfile(localStorage.getItem(userProfileStorageKey(uid)));
  } catch {
    return null;
  }
}

export function saveStoredUserProfile(uid: string | null | undefined, profile: Record<string, unknown>): boolean {
  try {
    localStorage.setItem(userProfileStorageKey(uid), JSON.stringify(profile));
    return true;
  } catch {
    // Local storage is a cache; Firestore remains the signed-in source of truth.
    return false;
  }
}
