/** Browser-safe labels shared by static and hydrated job cards. */
export const SALARY_ESTIMATE_SUFFIX = {
  it: '(stima)',
  en: '(est.)',
  de: '(Schätzung)',
  fr: '(est.)',
} as const;


/** Missing/legacy provenance does not establish that the employer reported it. */
export function salaryProvenanceSuffix(source: string | null | undefined, locale: keyof typeof SALARY_ESTIMATE_SUFFIX): string {
  if (source === 'reported') return '';
  if (source === 'estimated') return SALARY_ESTIMATE_SUFFIX[locale];
  return {
    it: '(fonte non verificata)',
    en: '(source unverified)',
    de: '(Quelle ungeprüft)',
    fr: '(source non vérifiée)',
  }[locale];
}
