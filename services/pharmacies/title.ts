import type { Pharmacy } from './types';

function pharmacyTitleBase(pharmacy: Pharmacy, discriminator: string): string {
  const citySuffix = ` — ${pharmacy.city}`;
  const nameBudget = Math.max(1, 52 - citySuffix.length - discriminator.length);
  const name = pharmacy.name.length > nameBudget
    ? `${pharmacy.name.slice(0, Math.max(1, nameBudget - 1)).replace(/[\s,:;–—-]+$/, '')}…`
    : pharmacy.name;
  return `${name}${citySuffix}${discriminator}`;
}

function pharmacyDiscriminator(pharmacy: Pharmacy, duplicateKeys: ReadonlySet<string>): string {
  if (!duplicateKeys.has(`${pharmacy.name}\u0000${pharmacy.city}`)) return '';
  const compactAddress = pharmacy.address
    .replace(/^(via|viale|piazza|corso|largo|vicolo|strada)\s+/i, '')
    .replace(/[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` · ${pharmacy.ministryId ? `#${pharmacy.ministryId}` : `${pharmacy.postalCode} ${compactAddress}`}`;
}

const pharmacyTitleCache = new WeakMap<object, Map<string, string>>();

function buildPharmacyTitleMap(pharmacies: readonly Pharmacy[]): Map<string, string> {
  const cached = pharmacyTitleCache.get(pharmacies);
  if (cached) return cached;

  const duplicateKeys = new Set(
    pharmacies
      .map((candidate) => `${candidate.name}\u0000${candidate.city}`)
      .filter((key, index, keys) => keys.indexOf(key) !== index),
  );
  const titleGroups = new Map<string, string[]>();
  for (const candidate of pharmacies) {
    const title = pharmacyTitleBase(candidate, pharmacyDiscriminator(candidate, duplicateKeys));
    titleGroups.set(title, [...(titleGroups.get(title) || []), candidate.id]);
  }
  const collisionRanks = new Map<string, number>();
  for (const ids of titleGroups.values()) {
    if (ids.length < 2) continue;
    ids.forEach((id, index) => collisionRanks.set(id, index + 1));
  }

  const titles = new Map<string, string>();
  for (const pharmacy of pharmacies) {
    const rank = collisionRanks.get(pharmacy.id);
    const discriminator = rank
      ? ` · #${rank}`
      : pharmacyDiscriminator(pharmacy, duplicateKeys);
    titles.set(pharmacy.id, pharmacyTitleBase(pharmacy, discriminator));
  }
  pharmacyTitleCache.set(pharmacies, titles);
  return titles;
}

/** Build the unique pharmacy title used by both static pages and SPA SEO. */
export function buildPharmacyTitle(pharmacy: Pharmacy, pharmacies: readonly Pharmacy[]): string {
  return buildPharmacyTitleMap(pharmacies).get(pharmacy.id) || pharmacy.name;
}
