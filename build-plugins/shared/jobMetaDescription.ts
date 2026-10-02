import { clampMetaDescription } from './titleSuffix';
import { decodeHtmlText } from '../../packages/articles/engine/shared/htmlEntities';

/**
 * Compose the meta description for an active job page.
 *
 * Keep the source context whenever available. If the source record is
 * genuinely short, let the shared metadata clamp add its truthful,
 * locale-aware completeness context so the page does not ship a
 * sub-120-character description.
 *
 * Every source fragment is decoded EXACTLY ONCE, before clamping. `title`,
 * `company`, `location` and `cleanDescription` are source text and are
 * decoded here; `decodedDescription` is text the caller already decoded (the
 * job emitter's `cleanMetaDescription` decodes, then strips markdown and
 * emoji) and is never decoded again. Decoding the assembled string instead
 * decoded that description a second time: a source `&amp;eacute;` — the
 * literal text "&eacute;" — reached the SERP as "é"
 * (tests/html-entity-publication-boundaries.test.ts).
 */
export function buildJobMetaDescription(input: {
 locale: 'it' | 'en' | 'de' | 'fr';
 title: string;
 company: string;
 location: string;
 cleanDescription?: string;
 decodedDescription?: string;
 salaryMin?: unknown;
 salaryMax?: unknown;
 currency?: string;
}): string {
 const { locale } = input;
 const title = decodeHtmlText(String(input.title || ''));
 const company = decodeHtmlText(String(input.company || ''));
 const location = decodeHtmlText(String(input.location || ''));
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
 const body = (input.decodedDescription !== undefined
  ? String(input.decodedDescription)
  : decodeHtmlText(String(input.cleanDescription || ''))).trim();
 // Fragments are decoded before clamping: an HTML entity can expand or
 // straddle the raw character budget, and cutting its source spelling would
 // emit a broken reference or discard source context at the SERP boundary.
 const candidate = `${metaIntro}${salarySnippet}${body ? ` ${body}` : ''}${cta}`;
 return clampMetaDescription(candidate, undefined, locale);
}
