import type { AdminSection, AdminSectionGroup } from '../adminSections';

const PALETTE_GROUP_LABELS: Record<AdminSectionGroup, string> = {
  oggi: 'Oggi',
  lavoro: 'Lavoro',
  aziende: 'Aziende',
  redazione: 'Redazione',
  sistema: 'Sistema',
};

export type AdminPaletteItemKind = 'section' | 'action' | 'crawler' | 'company';

export interface AdminPaletteItem {
  id: string;
  label: string;
  kind: AdminPaletteItemKind;
  group?: AdminSectionGroup;
  description?: string;
  section?: AdminSection;
  onSelect?: () => void;
}

export interface AdminPaletteIndexEntry {
  item: AdminPaletteItem;
  normalizedText: string;
}

export interface AdminPaletteIndex {
  small: readonly AdminPaletteIndexEntry[];
  large: readonly AdminPaletteIndexEntry[];
}

export const ADMIN_PALETTE_LARGE_RESULT_LIMIT = 8;

function isLargePaletteCategory(kind: AdminPaletteItemKind): boolean {
  return kind === 'company' || kind === 'crawler';
}

export function normalizeAdminPaletteText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('it-CH')
    .replace(/\s+/gu, ' ')
    .trim();
}

function searchableText(item: AdminPaletteItem): string {
  return [item.label, item.description || '', item.group ? PALETTE_GROUP_LABELS[item.group] : ''].join(' ');
}

export function buildAdminPaletteIndex(items: readonly AdminPaletteItem[]): AdminPaletteIndex {
  const entries = items.map((item) => ({ item, normalizedText: normalizeAdminPaletteText(searchableText(item)) }));
  return {
    small: entries.filter((entry) => !isLargePaletteCategory(entry.item.kind)),
    large: entries.filter((entry) => isLargePaletteCategory(entry.item.kind)),
  };
}

function filterEntries(
  entries: readonly AdminPaletteIndexEntry[],
  query: string,
): AdminPaletteItem[] {
  if (!query) return entries.map((entry) => entry.item);
  return entries.filter((entry) => entry.normalizedText.includes(query)).map((entry) => entry.item);
}

function filterLargeEntries(
  entries: readonly AdminPaletteIndexEntry[],
  query: string,
): AdminPaletteItem[] {
  if (query.length < 2) return [];
  const counts = new Map<AdminPaletteItemKind, number>();
  const results: AdminPaletteItem[] = [];
  for (const entry of entries) {
    if (!entry.normalizedText.includes(query)) continue;
    const count = counts.get(entry.item.kind) || 0;
    if (count >= ADMIN_PALETTE_LARGE_RESULT_LIMIT) continue;
    counts.set(entry.item.kind, count + 1);
    results.push(entry.item);
  }
  return results;
}

/**
 * Small palette categories can react to the raw input. The large categories
 * receive a debounced query so a keypress never scans thousands of records.
 */
export function filterAdminPaletteIndex(
  index: AdminPaletteIndex,
  query: string,
  largeQuery = query,
): AdminPaletteItem[] {
  return [
    ...filterEntries(index.small, normalizeAdminPaletteText(query)),
    ...filterLargeEntries(index.large, normalizeAdminPaletteText(largeQuery)),
  ];
}
