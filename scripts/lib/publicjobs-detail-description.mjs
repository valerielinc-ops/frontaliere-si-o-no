/**
 * publicjobs.ch (PastaHR) vacancy page: the posting is rendered by the
 * `template_preview_*` blocks — lead paragraph, description (tasks, profile,
 * offer, contact), benefits, applicant info and footer. Shared by the GZO
 * Spital Wetzikon and igs Bern parsers.
 *
 * Both parsers used to pick the longest of the first twelve
 * `job|content|main|…` elements, with the WHOLE page as last candidate, and
 * cut the winner at 6000 characters: the lead paragraph was never published
 * (only the description block won) and the cap was the only thing bounding the
 * whole-page candidate (issue 5253). Reading the blocks by id keeps the ad and
 * nothing else — no print/share bar, apply button, contact card or GTM iframe.
 */
import { htmlToText, normalizeSpace } from './hospital-custom-html-helpers.mjs';
import { readClosedElement } from './html-balanced-element.mjs';

// Ad body blocks in page order. The title block is published separately and
// `template_preview_extra_info` is the metadata card (employer, workload,
// address), both left out.
const PUBLICJOBS_AD_BLOCK_IDS = [
  'template_preview_job_lead',
  'template_preview_job_description',
  'template_preview_job_benefits',
  'template_preview_job_applicant_info',
  'template_preview_job_footer',
];

/**
 * Plain-text vacancy body of a publicjobs.ch detail page, or '' when the page
 * does not carry the `template_preview_job_description` block.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractPublicjobsDetailDescription(html = '') {
  const source = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  if (!/id="template_preview_job_description"/.test(source)) return '';
  const parts = PUBLICJOBS_AD_BLOCK_IDS
    .map((id) => normalizeSpace(htmlToText(readClosedElement(source, `id="${id}"`))))
    .filter(Boolean);
  return parts.join('\n\n');
}
