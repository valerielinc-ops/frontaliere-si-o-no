// These are the same units queried by the dedicated VTG crawler. Keep the
// server-side VTG query and Confederazione's client-side ownership filter on
// one source of truth: each crawler group checks out the same pinned site
// commit, so the other group's published slice can be stale for the whole run.
export const VTG_VERWALTUNGSEINHEIT_IDS = Object.freeze([
  '1083433', // VBS/DDPS
  '1132413', // Armasuisse
  '1526654', // Nachrichtendienst NDB
  '1132414', // Gruppe Verteidigung
  '1083406', // Generalstab / Führungsstab der Armee
]);

export const VTG_VERWALTUNGSEINHEIT_FILTER = VTG_VERWALTUNGSEINHEIT_IDS.join(',');

const VTG_UNIT_LABELS = new Set([
  'vbs/ddps',
  'armasuisse',
  'nachrichtendienst ndb',
  'gruppe verteidigung',
  'generalstab / führungsstab der armee',
]);

function nonEmptyFacet(values) {
  return Array.isArray(values) && values.some((value) => String(value ?? '').trim() !== '');
}

/** Match a raw Prospective record owned by the dedicated Swiss Armed Forces crawler. */
export function isVtgApiRecord(record = {}) {
  const attributes = record?.attributes;
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;

  for (const id of VTG_VERWALTUNGSEINHEIT_IDS) {
    if (nonEmptyFacet(attributes[`verwaltungseinheit_${id}`])) return true;
  }

  // Some API responses omit the numeric sub-facet key but retain its exact
  // unit label. Do not match the broader DEFR parent: it also contains SECO,
  // SEFRI and other jobs that belong to the national Confederazione crawler.
  for (const [key, values] of Object.entries(attributes)) {
    if (key !== 'verwaltungseinheit' && !/^verwaltungseinheit_\d+$/.test(key)) continue;
    if (!Array.isArray(values)) continue;
    if (values.some((value) => VTG_UNIT_LABELS.has(String(value ?? '').trim().toLowerCase()))) return true;
  }
  return false;
}
