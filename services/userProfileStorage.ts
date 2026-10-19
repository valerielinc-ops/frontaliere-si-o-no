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

/** Read one account's local profile without falling back across account boundaries. */
export function loadStoredUserProfile(uid?: string | null): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(userProfileStorageKey(uid));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function saveStoredUserProfile(uid: string | null | undefined, profile: Record<string, unknown>): void {
  try {
    localStorage.setItem(userProfileStorageKey(uid), JSON.stringify(profile));
  } catch {
    // Local storage is a cache; Firestore remains the signed-in source of truth.
  }
}
