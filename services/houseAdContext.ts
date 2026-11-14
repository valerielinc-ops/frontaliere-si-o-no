export type HouseAdContextSource = 'job_detail' | 'job_filter';
export type HouseAdImageSector =
  | 'commute'
  | 'construction'
  | 'electrician'
  | 'hospitality'
  | 'logistics'
  | 'maintenance'
  | 'production';

export interface HouseAdCreativeContext {
  source: HouseAdContextSource;
  sector: HouseAdImageSector;
  role?: string;
  place?: string;
}

const SECTOR_TERMS: ReadonlyArray<[HouseAdImageSector, readonly string[]]> = [
  ['electrician', ['elettric', 'electric', 'elektrik', 'elektroinstall', 'electricien']],
  ['construction', ['murator', 'carpenter', 'zimmer', 'maçon', 'mason', 'construct', 'edil', 'cantiere', 'chantier', 'baugewerbe']],
  ['hospitality', ['hospital', 'hotel', 'restaurant', 'ristor', 'camerier', 'cuoc', 'cucin', 'barista', 'gastgewerbe', 'gastronom', 'hotellerie']],
  ['logistics', ['logist', 'magazzin', 'warehouse', 'supply', 'transport', 'spedizion', 'lager']],
  ['maintenance', ['manutenz', 'mechanic', 'maintenance', 'instandhalt', 'mécanicien', 'facility']],
  ['production', ['produzion', 'production', 'produktions', 'manufactur', 'assembl', 'montage', 'fabrikation', 'fabrication']],
];

function normalizeSectorText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchSector(value: unknown): HouseAdImageSector | null {
  const words = normalizeSectorText(value).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  for (const [sector, terms] of SECTOR_TERMS) {
    if (words.some((word) => terms.some((term) => word.startsWith(term)))) return sector;
  }
  return null;
}

/**
 * Select an existing campaign photo only when structured sector or role text
 * supports it. Unmatched roles use the cross-border commute image, which is
 * relevant to Swiss job searches without inventing a profession.
 */
export function resolveHouseAdImageSector(
  category: unknown,
  sector: unknown,
  title: unknown,
): HouseAdImageSector {
  const explicitSector = matchSector(sector);
  if (explicitSector) return explicitSector;
  const titleSector = matchSector(title);
  if (titleSector) return titleSector;
  if (normalizeSectorText(category) === 'hospitality') return 'hospitality';
  return 'commute';
}

/** Public page text only; callers must never pass free-text search input. */
export function sanitizeHouseAdContextLabel(value: unknown, maxLength = 52): string | undefined {
  const clean = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  const characters = Array.from(clean);
  if (characters.length <= maxLength) return clean;
  const clipped = characters.slice(0, maxLength).join('');
  const wordBoundary = clipped.lastIndexOf(' ');
  return (wordBoundary >= Math.floor(maxLength * 0.55) ? clipped.slice(0, wordBoundary) : clipped).trim();
}
