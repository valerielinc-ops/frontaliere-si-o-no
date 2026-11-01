export type JobMetaLocale = 'it' | 'en' | 'de' | 'fr';

/** Etichette della riga sotto il titolo dell'annuncio, HTML statico e app. */
export const JOB_META_LABELS: Record<JobMetaLocale, { category: string; contract: string; salary: string; notSpecified: string }> = {
  it: { category: 'Categoria', contract: 'Contratto', salary: 'Salario', notSpecified: 'non indicato' },
  en: { category: 'Category', contract: 'Contract', salary: 'Salary', notSpecified: 'not specified' },
  de: { category: 'Kategorie', contract: 'Vertrag', salary: 'Gehalt', notSpecified: 'nicht angegeben' },
  fr: { category: 'Catégorie', contract: 'Contrat', salary: 'Salaire', notSpecified: 'non indiqué' },
};

export const JOB_CATEGORY_LABELS: Record<string, Record<JobMetaLocale, string>> = {
  health: { it: 'Sanità', en: 'Healthcare', de: 'Gesundheit', fr: 'Santé' },
  finance: { it: 'Finanza', en: 'Finance', de: 'Finanzen', fr: 'Finance' },
  tech: { it: 'Informatica', en: 'Technology', de: 'Technik', fr: 'Technologie' },
  engineering: { it: 'Ingegneria', en: 'Engineering', de: 'Ingenieurwesen', fr: 'Ingénierie' },
  admin: { it: 'Amministrazione', en: 'Administration', de: 'Verwaltung', fr: 'Administration' },
  hospitality: { it: 'Ristorazione', en: 'Hospitality', de: 'Gastgewerbe', fr: 'Hôtellerie' },
  sales: { it: 'Vendita', en: 'Sales', de: 'Vertrieb', fr: 'Vente' },
  other: { it: 'Altro', en: 'Other', de: 'Andere', fr: 'Autre' },
};

/** Lingua delle etichette, con l'italiano come ripiego. */
export function jobMetaLocale(locale: string): JobMetaLocale {
  return locale === 'en' || locale === 'de' || locale === 'fr' ? locale : 'it';
}
