import { JSDOM } from 'jsdom';

function normalize(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Minimum Jaccard overlap required to treat a PDF heading as the same title as the page link text. */
export const MIN_TITLE_OVERLAP = 0.7;

/** Maximum character length for a line to be considered a job title (not a body paragraph). */
const MAX_PDF_TITLE_LEN = 80;

/**
 * Word-level Jaccard similarity between two title strings.
 * Returns 1 if both are empty, 0 if one is empty.
 */
export function titleOverlap(a = '', b = '') {
  const words = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .replace(/[-_]/g, ' ')
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(Boolean)
    );
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  return intersection / new Set([...setA, ...setB]).size;
}

/**
 * Extract the first meaningful title-like line from normalized PDF text.
 *
 * A valid title candidate must:
 *   - be short (<= MAX_PDF_TITLE_LEN chars)
 *   - contain at least 2 words
 *   - not start with a bullet marker (-, •, *, –)
 *   - not be a URL
 *   - not be fully uppercase (company header)
 *
 * @param {string} pdfText - Normalized plain-text content from the PDF
 * @returns {string} The first title candidate, or empty string if none found
 */
export function extractTitleFromPdfText(pdfText = '') {
  if (!pdfText) return '';
  const paragraphs = String(pdfText).split('\n\n').map((p) => p.trim()).filter(Boolean);
  for (const para of paragraphs) {
    const firstLine = para.split('\n')[0].trim();
    if (firstLine.length > MAX_PDF_TITLE_LEN) continue;
    const wordList = firstLine.split(/\s+/).filter(Boolean);
    if (wordList.length < 2) continue;
    if (/^[-•*–]/.test(firstLine)) continue;
    if (/^https?:\/\//i.test(firstLine)) continue;
    // Skip all-uppercase company headers (e.g. "LWP LEDERMANN WIETING & PARTNERS")
    if (firstLine === firstLine.toUpperCase() && /[A-Z]/.test(firstLine)) continue;
    return firstLine;
  }
  return '';
}

/**
 * Reconcile the page-extracted title with the PDF-extracted heading.
 *
 * - If pdfTitle is empty, fall back to pageTitle.
 * - If overlap >= MIN_TITLE_OVERLAP (0.7), the two refer to the same role → keep pageTitle.
 * - Otherwise the PDF heading is more specific/accurate → prefer pdfTitle.
 *
 * @param {string} pageTitle - Title from the HTML careers page link text
 * @param {string} pdfTitle  - Title candidate extracted from the PDF body
 * @returns {string}
 */
export function reconcilePdfTitle(pageTitle = '', pdfTitle = '') {
  if (!pdfTitle) return pageTitle;
  if (titleOverlap(pageTitle, pdfTitle) >= MIN_TITLE_OVERLAP) return pageTitle;
  return pdfTitle;
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8203;/g, '')
    .replace(/\u00a0/g, ' ');
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

export function absoluteLwphrUrl(rawHref = '') {
  const href = String(rawHref || '').trim();
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return `https://www.lwphr.ch${href.startsWith('/') ? '' : '/'}${href}`;
}

export function parseLwphrOpenJobs(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const accordionItems = [...document.querySelectorAll('.accordion__item')];
  const openItem = accordionItems.find((item) => /posizioni aperte|open positio/i.test(normalize(item.textContent || '')));
  if (!openItem) {
    throw new Error('Could not find LWPHR open positions accordion');
  }

  const jobs = [];
  for (const link of openItem.querySelectorAll('.accordion__content a[href$=".pdf"]')) {
    const title = normalize(decodeHtml(link.textContent || ''));
    const pdfUrl = absoluteLwphrUrl(link.getAttribute('href') || '');
    if (!title || title === ')' || title === '​') continue;
    jobs.push({ title, pdfUrl });
  }

  const deduped = [];
  const seen = new Set();
  for (const job of jobs) {
    const key = `${job.title.toLowerCase()}|${job.pdfUrl.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  return deduped;
}

export function inferLwphrLocation(title = '', pdfText = '') {
  const text = `${title} ${pdfText}`.toLowerCase();
  if (/locarno/.test(text)) return 'Locarno';
  if (/mendrisiotto|mendrisio/.test(text)) return 'Mendrisio';
  if (/luganese|lugano/.test(text)) return 'Lugano';
  if (/ticino/.test(text)) return 'Ticino';
  if (/svizzera|switzerland/.test(text)) return 'Ticino';
  return 'Lugano';
}

export function inferLwphrCategory(title = '', pdfText = '') {
  const text = `${title} ${pdfText}`.toLowerCase();
  if (/(security|developer|software|web|it|architect)/.test(text)) return 'tech';
  if (/(banker|patrimoniale|asset|analyst|contabile|accountant|cfo|financial|procurement)/.test(text)) return 'finance';
  if (/(marketing|business development|vendita|key account|customer service)/.test(text)) return 'sales';
  if (/(hr specialist|human resources|segretaria|assistant|office)/.test(text)) return 'admin';
  if (/(ingegneri civili|responsabile tecnico|metal costruzione)/.test(text)) return 'engineering';
  return 'other';
}

export function buildLwphrLocalizedPayload({ title = '', pdfText = '', location = 'Lugano', pdfUrl = '' } = {}) {
  const trimmed = normalize(pdfText);
  const titles = {
    en: title,
    it: title,
    de: title,
    fr: title,
  };
  const slugs = {
    en: slugify(`${title} lwp ledermann wieting partners ${location}`),
    it: slugify(`${title} lwp ledermann wieting partners ${location}`),
    de: slugify(`${title} lwp ledermann wieting partners ${location}`),
    fr: slugify(`${title} lwp ledermann wieting partners ${location}`),
  };

  const descriptions = {
    it: [
      `LWP Ledermann Wieting & Partners pubblica questa opportunita nel suo portale Ticino. La descrizione completa del ruolo e stata estratta dal PDF ufficiale del mandato.`,
      `Sede indicativa: ${location}.`,
      trimmed,
      `PDF ufficiale: ${pdfUrl}`,
    ].join('\n\n'),
    en: [
      `LWP Ledermann Wieting & Partners lists this role on its Ticino opportunities portal. The full role description below is extracted from the official PDF published by the recruiter.`,
      `Indicative location: ${location}.`,
      trimmed,
      `Official PDF: ${pdfUrl}`,
    ].join('\n\n'),
    de: [
      `LWP Ledermann Wieting & Partners veroeffentlicht diese Stelle im Tessiner Karriereportal. Die vollstaendige Beschreibung unten wurde aus dem offiziellen PDF der Ausschreibung extrahiert.`,
      `Ungefaehrer Arbeitsort: ${location}.`,
      trimmed,
      `Offizielles PDF: ${pdfUrl}`,
    ].join('\n\n'),
    fr: [
      `LWP Ledermann Wieting & Partners publie cette opportunite sur son portail carrières au Tessin. La description complete ci-dessous provient du PDF officiel de l annonce.`,
      `Lieu indicatif: ${location}.`,
      trimmed,
      `PDF officiel: ${pdfUrl}`,
    ].join('\n\n'),
  };

  return { titles, slugs, descriptions };
}
