import { jobDescriptionTextToHtml } from './jobDescription/toHtml';
import { escHtml } from './htmlEscape';

const requirementsHeading = { it: 'Requisiti', en: 'Requirements', de: 'Anforderungen', fr: 'Exigences' };

const descriptionHeading = {
  it: 'Descrizione completa',
  en: 'Full description',
  de: 'Vollständige Beschreibung',
  fr: 'Description complète',
};

type JobDescriptionLocale = keyof typeof descriptionHeading;

function renderRequirementsHtml(locale: JobDescriptionLocale, requirements: readonly string[]): string {
  return requirements.length
    ? `<h2>${escHtml(requirementsHeading[locale])}</h2><ul>${requirements.map((item) => `<li>${jobDescriptionTextToHtml(item)}</li>`).join('')}</ul>`
    : '';
}

/**
 * Owner contract (2026-10-29): every static job detail contains the complete
 * source, independently of authentication or user-agent. The 220-character
 * preview belongs ONLY to the hydrated anonymous-human view.
 * The shared serializer preserves semantic headings/lists and sanitizes ATS HTML.
 */
export function renderJobDescriptionContent(description: string, locale: JobDescriptionLocale, requirements: readonly string[] = []): string {
  return renderJobDescriptionVariants(description, locale, requirements).page;
}

/**
 * The listing text for `JobPosting.description`: the same content as the page
 * without its interface. "Full description" is a heading of our template, not
 * part of the employer's text, and the schema opened with it.
 */
export function renderJobPostingDescription(description: string, locale: JobDescriptionLocale, requirements: readonly string[] = []): string {
  return renderJobDescriptionVariants(description, locale, requirements).schema;
}

/** Both forms from one parse, for the pages that emit the text and the schema. */
export function renderJobDescriptionVariants(description: string, locale: JobDescriptionLocale, requirements: readonly string[] = []): { page: string; schema: string } {
  const body = jobDescriptionTextToHtml(description);
  const requirementsHtml = renderRequirementsHtml(locale, requirements);
  return {
    page: `<section class="section" data-job-description-full><h2>${escHtml(descriptionHeading[locale])}</h2>${body}</section>${requirementsHtml ? `<section class="section">${requirementsHtml}</section>` : ''}`,
    schema: `${body}${requirementsHtml}`,
  };
}
