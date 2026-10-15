/**
 * Pure fuel-station brand normalisation shared by the build plugins and the
 * licence audit. Keep this module free of filesystem and browser imports so
 * both Node and the client-facing TypeScript wrapper can use the same slug.
 */

export const BRAND_LOGO_ALIASES = Object.freeze({
  eni: 'agipeni',
  agip: 'agipeni',
  coop: 'cooppronto',
  cooppronto: 'cooppronto',
  ruedirussel: 'ruedirussel',
  ruedirüssel: 'ruedirussel',
  migrolino: 'migrol',
  total: 'totalenergies',
  totalenergies: 'totalenergies',
});

export function normaliseBrand(brand) {
  return String(brand ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

export function brandLogoSlug(brand) {
  const normalised = normaliseBrand(brand);
  return BRAND_LOGO_ALIASES[normalised] ?? normalised;
}
