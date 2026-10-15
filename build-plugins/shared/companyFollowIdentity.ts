export interface HubProfileIdentity {
  readonly companyKey: string | null;
}

/**
 * Resolve the company key used by a static hub's follow CTA.
 *
 * The profile emitter already applies the canonical dominant-companyKey
 * resolution across the complete employer group. Reuse that result whenever
 * it is present; if a rendered profile has no crawler key, keep the hub's
 * canonical slug as the deterministic identity fallback. Never choose an
 * order-dependent job pick.
 */
export function resolveHubCompanyKey(
  hubSlug: string,
  profileIdentity?: HubProfileIdentity,
): string | null {
  const profileKey = String(profileIdentity?.companyKey || '').trim();
  return profileKey || String(hubSlug || '').trim() || null;
}
