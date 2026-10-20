import type { SectorPublicationLocale } from '../../data/sector-hub-publications';

const LOCALES: readonly SectorPublicationLocale[] = ['it', 'en', 'de', 'fr'];

export type SectorHubLabelTranslator = (
  text: string,
  sourceLocale: SectorPublicationLocale,
  targetLocale: SectorPublicationLocale,
) => Promise<string>;

function normalizeLabel(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function isUsableLabelTranslation(value: string, sourceLabel: string): boolean {
  const label = value.trim();
  if (!label || label.length > 80 || /[\r\n<>]/.test(label) || !/\p{Letter}/u.test(label)) return false;
  if (label.split(/\s+/).length > 8) return false;
  return normalizeLabel(label) !== normalizeLabel(sourceLabel);
}

/** Add validated translations without inventing hreflang labels when a provider fails. */
export async function localizeSectorHubLabel({
  label,
  sourceLocale,
  existingLabels = {},
  translate,
}: {
  label: string;
  sourceLocale: SectorPublicationLocale;
  existingLabels?: Partial<Record<SectorPublicationLocale, string>>;
  translate: SectorHubLabelTranslator;
}): Promise<Partial<Record<SectorPublicationLocale, string>>> {
  const labels: Partial<Record<SectorPublicationLocale, string>> = { ...existingLabels };
  if (!labels[sourceLocale]?.trim()) labels[sourceLocale] = label;

  for (const targetLocale of LOCALES) {
    if (targetLocale === sourceLocale || labels[targetLocale]?.trim()) continue;
    try {
      const translated = await translate(label, sourceLocale, targetLocale);
      if (isUsableLabelTranslation(translated, label)) labels[targetLocale] = translated.trim();
    } catch {
      // The source locale remains publishable; a failed translation omits only that locale.
    }
  }

  return labels;
}
