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

/** Move the unscoped legacy profile into the anonymous cache before retiring its key. */
function migrateLegacyProfileToAnonymousCache(): void {
  try {
    const legacyRaw = localStorage.getItem(LEGACY_PROFILE_STORAGE_KEY);
    const legacyProfile = parseStoredProfile(legacyRaw);
    if (!legacyRaw || !legacyProfile) return;

    const anonymousKey = userProfileStorageKey(null);
    const anonymousProfile = parseStoredProfile(localStorage.getItem(anonymousKey));
    // Keep a populated scoped cache authoritative, and retain the legacy copy
    // when the two differ rather than discarding data we cannot safely merge.
    if (anonymousProfile) return;
    localStorage.setItem(anonymousKey, JSON.stringify(legacyProfile));
    localStorage.removeItem(LEGACY_PROFILE_STORAGE_KEY);
  } catch {
    // Keep the old key when storage is unavailable; migration is best effort.
  }
}

/** Read one account's local profile without falling back across account boundaries. */
export function loadStoredUserProfile(uid?: string | null): Record<string, unknown> | null {
  try {
    migrateLegacyProfileToAnonymousCache();
    return parseStoredProfile(localStorage.getItem(userProfileStorageKey(uid)));
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
