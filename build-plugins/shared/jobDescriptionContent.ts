import { jobDescriptionTextToHtml } from './jobDescription/toHtml';
import { escHtml } from './htmlEscape';

const requirementsHeading = { it: 'Requisiti', en: 'Requirements', de: 'Anforderungen', fr: 'Exigences' };

const descriptionHeading = {
  it: 'Descrizione completa',
  en: 'Full description',
  de: 'Vollständige Beschreibung',
  fr: 'Description complète',
};

/**
 * Owner contract (2026-10-29): every static job detail contains the complete
 * source, independently of authentication or user-agent. The 220-character
 * preview belongs ONLY to the hydrated anonymous-human view.
 * The shared serializer preserves semantic headings/lists and sanitizes ATS HTML.
 */
export function renderJobDescriptionContent(description: string, locale: keyof typeof descriptionHeading, requirements: readonly string[] = []): string {
  const requirementsHtml = requirements.length
    ? `<section class="section"><h2>${escHtml(requirementsHeading[locale])}</h2><ul>${requirements.map((item) => `<li>${jobDescriptionTextToHtml(item)}</li>`).join('')}</ul></section>`
    : '';
  return `<section class="section" data-job-description-full><h2>${escHtml(descriptionHeading[locale])}</h2>${jobDescriptionTextToHtml(description)}</section>${requirementsHtml}`;
}
