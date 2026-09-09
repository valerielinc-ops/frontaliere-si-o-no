export interface HubProfileIdentity {
  readonly companyKey: string | null;
}

/**
 * Resolve the company key used by a static hub's follow CTA.
 *
 * The profile emitter already applies the canonical dominant-companyKey
 * resolution across the complete employer group. Reuse that result whenever
 * an indexable profile exists; only below-floor hubs need the deterministic
 * URL-slug fallback, never an order-dependent job pick.
 */
export function resolveHubCompanyKey(
  hubSlug: string,
  profileIdentity?: HubProfileIdentity,
): string | null {
  if (profileIdentity) return String(profileIdentity.companyKey || '').trim() || null;
  return String(hubSlug || '').trim() || null;
}
