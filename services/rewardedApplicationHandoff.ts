export const REWARDED_APPLICATION_PAGE_PATH = '/rewarded-application/';
const REWARDED_APPLICATION_HANDOFF_PREFIX = 'frontaliere_rewarded_application_handoff_v1:';
const HANDOFF_TTL_MS = 15 * 60 * 1000;

/**
 * This is an entrypoint route, mounted by index.tsx before App/router loads.
 * Keep the predicate next to the canonical path so the external rewarded page
 * cannot drift into an unregistered literal in a second bootstrap location.
 */
export function isRewardedApplicationPagePath(pathname: string): boolean {
  return pathname === REWARDED_APPLICATION_PAGE_PATH;
}

export interface RewardedApplicationHandoff {
  token: string;
  destination: string;
  jobId: string;
  companyId: string;
  companyName?: string;
  jobTitle?: string;
  createdAt: number;
  expiresAt: number;
}

function makeToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the older-browser-safe value below.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
}

function storageKey(token: string): string {
  return `${REWARDED_APPLICATION_HANDOFF_PREFIX}${token}`;
}

function isSafeDestination(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function createRewardedApplicationHandoff(input: {
  destination: string;
  jobId: string;
  companyId: string;
  companyName?: string;
  jobTitle?: string;
}): string | null {
  if (typeof window === 'undefined' || !isSafeDestination(input.destination)) return null;
  const createdAt = Date.now();
  const token = makeToken();
  const handoff: RewardedApplicationHandoff = {
    token,
    destination: input.destination,
    jobId: String(input.jobId),
    companyId: String(input.companyId),
    ...(input.companyName ? { companyName: String(input.companyName) } : {}),
    ...(input.jobTitle ? { jobTitle: String(input.jobTitle) } : {}),
    createdAt,
    expiresAt: createdAt + HANDOFF_TTL_MS,
  };
  try {
    window.localStorage.setItem(storageKey(token), JSON.stringify(handoff));
    return token;
  } catch {
    return null;
  }
}

export function readRewardedApplicationHandoff(token: string | null): RewardedApplicationHandoff | null {
  if (typeof window === 'undefined' || !token) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(token));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RewardedApplicationHandoff>;
    const createdAt = Number(value.createdAt);
    const expiresAt = Number(value.expiresAt);
    if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt) || createdAt > expiresAt) {
      window.localStorage.removeItem(storageKey(token));
      return null;
    }
    if (expiresAt <= Date.now()) {
      window.localStorage.removeItem(storageKey(token));
      return null;
    }
    if (!isSafeDestination(value.destination) || !value.jobId || !value.companyId) return null;
    return {
      token,
      destination: value.destination,
      jobId: String(value.jobId),
      companyId: String(value.companyId),
      ...(value.companyName ? { companyName: String(value.companyName) } : {}),
      ...(value.jobTitle ? { jobTitle: String(value.jobTitle) } : {}),
      createdAt,
      expiresAt,
    };
  } catch {
    return null;
  }
}

export function clearRewardedApplicationHandoff(token: string | null): void {
  if (typeof window === 'undefined' || !token) return;
  try {
    window.localStorage.removeItem(storageKey(token));
  } catch {
    // Best-effort cleanup; the expiry remains the safety net.
  }
}

export function buildRewardedApplicationPageUrl(token: string): string {
  return `${window.location.origin}${REWARDED_APPLICATION_PAGE_PATH}?handoff=${encodeURIComponent(token)}`;
}
