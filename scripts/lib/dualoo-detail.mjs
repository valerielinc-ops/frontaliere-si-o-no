/**
 * Shared reader for a Dualoo (jobs.dualoo.com) vacancy detail page.
 *
 * Six dedicated crawlers (cereneo, cham-swiss-properties, forel-klinik,
 * klinik-aadorf, klinik-arlesheim, uroviva) carried six copies of the same
 * `fetchDualooDetail`, and every copy lost part of the vacancy (#5253):
 *
 *   - it read only the three list sections and dropped
 *     `advertisementDescriptionText`, the paragraph the portal renders at the
 *     top of every ad (company presentation and, often, the role intro);
 *   - it replaced the headings the page renders («Was solltest du
 *     mitbringen?», «Your tasks», …) with fixed German labels, so an English
 *     posting was published under «Aufgaben:/Anforderungen:»;
 *   - it cut each section at the first `</div>`, and flattened the closing
 *     paragraphs of a section into its last bullet.
 *
 * The page renders one `advertisement` container whose sections are, in
 * order: the untitled `advertisementDescriptionText`, then a heading
 * `advertisement<Name>Title` + body `advertisement<Name>Text` pair for
 * Responsibilities, Requirements and Benefits, then the contact card
 * (`advertisementContact*`: recruiter name and phone, not vacancy content —
 * left out on purpose, like the apply button and the print icon).
 */
import { classAttrRx } from './crawler-template.mjs';
import {
  decodeEntities,
  extractBalancedTagBlock,
  fetchHtml,
  normalizeSpace,
} from './hospital-custom-html-helpers.mjs';

// Portal order. `label` is used only when the page renders no heading for a
// section that has content — the labels the per-tenant copies always printed.
const DUALOO_SECTIONS = [
  { name: 'Description', label: '' },
  { name: 'Responsibilities', label: 'Aufgaben' },
  { name: 'Requirements', label: 'Anforderungen' },
  { name: 'Benefits', label: 'Wir bieten' },
];

function openingTag(html, className, tag = 'div') {
  return new RegExp(`<${tag}\\b[^>]*${classAttrRx(className)}[^>]*>`, 'i').exec(html);
}

/**
 * Section HTML → text that keeps the list structure: one `• ` line per `<li>`
 * (its inner paragraphs joined on that line), one line per paragraph/block.
 */
function sectionText(html = '') {
  const text = decodeEntities(
    String(html || '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n• ${normalizeSpace(inner.replace(/<[^>]+>/g, ' '))}\n`)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|ul|ol|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' '),
  );
  return text
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter((line) => line && line !== '•')
    .join('\n');
}

function headingText(html, name) {
  const open = openingTag(html, `advertisement${name}Title`, 'h[1-6]');
  if (!open) return '';
  const close = html.indexOf('</', open.index + open[0].length);
  if (close < 0) return '';
  return normalizeSpace(decodeEntities(html.slice(open.index + open[0].length, close).replace(/<[^>]+>/g, ' ')));
}

function asHeading(text) {
  return /[:?!.]$/.test(text) ? text : `${text}:`;
}

/**
 * Every vacancy section of a Dualoo detail page, in page order.
 *
 * @param {string} html detail page
 * @returns {string} `Heading:\n• item…` blocks joined by a blank line; '' when
 *   the page carries none of the sections (not a Dualoo ad)
 */
export function parseDualooDetail(html = '') {
  const source = String(html || '');
  const parts = [];
  for (const { name, label } of DUALOO_SECTIONS) {
    const open = openingTag(source, `advertisement${name}Text`);
    if (!open) continue;
    const body = sectionText(extractBalancedTagBlock(source.slice(open.index + open[0].length), 'div', 100_000));
    if (!body) continue;
    const heading = headingText(source, name) || label;
    parts.push(heading ? `${asHeading(heading)}\n${body}` : body);
  }
  return parts.join('\n\n');
}

/**
 * Fetch a Dualoo detail page and return its sections (see
 * `parseDualooDetail`). A failed fetch returns '' — the per-tenant parsers
 * already count detail hits and keep the job with its listing metadata.
 *
 * @param {string} detailUrl
 * @param {{ fetchPage?: (url: string) => Promise<string> }} [options]
 */
export async function fetchDualooDetail(detailUrl, { fetchPage = fetchHtml } = {}) {
  try {
    return parseDualooDetail(await fetchPage(detailUrl));
  } catch {
    return '';
  }
}
