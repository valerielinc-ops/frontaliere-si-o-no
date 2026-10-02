import { clampMetaDescription } from './titleSuffix';

/**
 * Compose the meta description for an active job page.
 *
 * Keep the source context whenever available. If the source record is
 * genuinely short, let the shared metadata clamp add its truthful,
 * locale-aware completeness context so the page does not ship a
 * sub-120-character description.
 */
export function buildJobMetaDescription(input: {
 locale: 'it' | 'en' | 'de' | 'fr';
 title: string;
 company: string;
 location: string;
 cleanDescription?: string;
 salaryMin?: unknown;
 salaryMax?: unknown;
 currency?: string;
}): string {
 const { locale, title, company, location, cleanDescription = '' } = input;
 const metaIntro = locale === 'de'
  ? `${title} bei ${company} in ${location}.`
  : locale === 'fr'
  ? `${title} chez ${company} à ${location}.`
  : locale === 'en'
  ? `${title} at ${company} in ${location}.`
  : `${title} presso ${company} a ${location}.`;
 const salaryMin = Number(input.salaryMin);
 const salaryMax = Number(input.salaryMax);
 const currency = String(input.currency || 'CHF');
 const salaryLabel = locale === 'de' ? 'Gehalt' : locale === 'fr' ? 'Salaire' : locale === 'en' ? 'Salary' : 'Salario';
 const salarySnippet = Number.isFinite(salaryMin) && salaryMin > 0
  ? (Number.isFinite(salaryMax) && salaryMax > salaryMin
   ? ` ${salaryLabel}: ${currency} ${Math.round(salaryMin).toLocaleString('de-CH')}-${Math.round(salaryMax).toLocaleString('de-CH')}.`
   : ` ${salaryLabel}: ${currency} ${Math.round(salaryMin).toLocaleString('de-CH')}.`)
  : '';
 const cta = locale === 'de'
  ? ' Jetzt auf Frontaliere Ticino bewerben.'
  : locale === 'fr'
  ? ' Postulez sur Frontaliere Ticino.'
  : locale === 'en'
  ? ' Apply now on Frontaliere Ticino.'
  : ' Candidati ora su Frontaliere Ticino.';
 const body = String(cleanDescription || '').trim();
 const candidate = `${metaIntro}${salarySnippet}${body ? ` ${body}` : ''}${cta}`;
 return clampMetaDescription(candidate, undefined, locale);
}
