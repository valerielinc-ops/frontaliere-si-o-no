export interface GamificationAuthUser {
  uid?: unknown;
  isAnonymous?: boolean;
}

/** Gamification popups are reserved for registered, non-anonymous accounts. */
export function canShowGamificationPopups(
  user: GamificationAuthUser | null | undefined,
): boolean {
  return Boolean(user?.uid) && user?.isAnonymous !== true;
}
