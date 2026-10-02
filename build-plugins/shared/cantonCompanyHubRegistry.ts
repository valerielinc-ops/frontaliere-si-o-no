/**
 * Cross-plugin registry of the per-canton company hubs that
 * `jobsSeoPagesPlugin` (Phase 3.3) actually emits as indexable pages:
 * `/{section}/{company-route-prefix}-{slug}/`.
 *
 * Why (2026-10-02). `seoHubsPlugin` renders the canton "Aziende che assumono"
 * page (`/{section}/aziende/`) from the weekly jobs snapshot and linked
 * `azienda-{employerKey}`: a key that is not the slug the hub is emitted
 * under (`canonicalCompanyProfileSlug(company, companyKey)`), counted on an
 * older inventory, with the Italian route prefix in every locale. Measured on
 * build f3659686, Zurich IT: of the 100 links, 28 pointed at noindex bridges
 * and 26 at pages that do not exist in the dist. This registry lets the page
 * link exactly the hubs that exist.
 *
 * Both plugins run sequentially in one Node process (`closeBundle`),
 * jobsSeoPagesPlugin first: module state is enough, as for
 * `cantonSectorPageRegistry`. Empty under a build that skips Phase 3.3; the
 * consumer then keeps its previous source.
 */

export interface CantonCompanyHub {
  /** Canonical company slug of the hub URL (without the route prefix). */
  readonly slug: string;
  /** Company display name. */
  readonly name: string;
  /** Active jobs of the company in the canton (the hub's own count). */
  readonly jobs: number;
  /** Key for the logo manifests (employer/company key, else the slug). */
  readonly logoKey: string;
}

const hubsByCanton = new Map<string, Map<string, CantonCompanyHub>>();

/** Called by jobsSeoPagesPlugin for every above-floor per-canton company hub. */
export function markCantonCompanyHub(canton: string, hub: CantonCompanyHub): void {
  let hubs = hubsByCanton.get(canton);
  if (!hubs) hubsByCanton.set(canton, (hubs = new Map()));
  hubs.set(hub.slug, Object.freeze({ ...hub }));
}

/** Emitted hubs of a canton, most jobs first (name, then slug, on ties). */
export function cantonCompanyHubs(canton: string): CantonCompanyHub[] {
  return [...(hubsByCanton.get(canton)?.values() ?? [])]
    .sort((a, b) => (b.jobs - a.jobs) || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

/** Test/diagnostic helper — never mutate from production code. */
export function _resetCantonCompanyHubRegistry(): void {
  hubsByCanton.clear();
}
