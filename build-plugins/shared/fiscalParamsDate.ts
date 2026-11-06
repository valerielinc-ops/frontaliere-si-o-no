import { FISCAL_PARAMS_UPDATED_AT } from '../../services/contentDates';
import { formatUpdatedDate, type LandingLocale } from './humanDate';

const LABEL: Record<LandingLocale, string> = {
  it: 'Parametri fiscali aggiornati al',
  en: 'Tax parameters updated on',
  de: 'Steuerparameter aktualisiert am',
  fr: 'Paramètres fiscaux mis à jour le',
};

/**
 * Visible date of the parameters behind a simulation. It replaces "Aggiornata al
 * 2026": a year says nothing, and the page's own build date would claim a change
 * in the figures every deploy. It dates the parameters, not a review of the page.
 */
export function renderFiscalParamsDate(locale: LandingLocale): string {
  return `<p class="fh-disc">${LABEL[locale]} <time datetime="${FISCAL_PARAMS_UPDATED_AT}">${formatUpdatedDate(FISCAL_PARAMS_UPDATED_AT, locale)}</time></p>`;
}
