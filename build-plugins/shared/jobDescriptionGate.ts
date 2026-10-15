import { jobDescriptionPreview } from '../../services/jobs/descriptionPreview';
import { escHtml } from './htmlEscape';

const gateCopy = {
  it: 'Accedi gratis per leggere la descrizione completa e i requisiti e scoprire come candidarti.',
  en: 'Sign in free to read the full description and requirements and find out how to apply.',
  de: 'Melde dich kostenlos an, um die vollständige Beschreibung und Anforderungen zu lesen und dich zu bewerben.',
  fr: 'Connectez-vous gratuitement pour lire la description et les exigences complètes et découvrir comment postuler.',
};

/** Static HTML is an anonymous surface too, including when JavaScript is slow. */
export function renderJobDescriptionGate(description: string, locale: keyof typeof gateCopy): string {
  return `<section class="section" data-job-description-preview><p>${escHtml(jobDescriptionPreview(description))}</p></section><section class="section" id="job-auth-gate"><p>${escHtml(gateCopy[locale])}</p></section>`;
}
