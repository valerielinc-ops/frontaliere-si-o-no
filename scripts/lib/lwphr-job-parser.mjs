import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import { titleOverlap, MIN_TITLE_OVERLAP } from './title-utils.mjs';
export { titleOverlap, MIN_TITLE_OVERLAP };
import { inferAnyCanton, rescueSwissCityFromText } from './target-swiss-locations.mjs';

function normalize(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Maximum character length for a line to be considered a job title (not a body paragraph). */
const MAX_PDF_TITLE_LEN = 80;

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
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
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

/**
 * Resolve the location named by an LWP publication.
 *
 * City rescue is limited to the title, explicit work-location labels, and
 * canton-qualified parentheticals; ordinary PDF prose is never treated as an
 * address. A canton or country without a resolvable city leaves the locality
 * empty so the crawler cannot fabricate an address.
 */
const LWPHR_LOCATION_LABEL_RE = /\b(?:luogo\s+di\s+lavoro|sede\s+di\s+lavoro|posto\s+di\s+lavoro|localit(?:a|à)\s+di\s+lavoro|arbeitsort|arbeitsplatz|standort|lieu\s+de\s+travail|work(?:ing)?\s+location|based\s+(?:in|at)|office\s+in)\b\s*[:\-–]?\s*(.*)$/iu;
const LWPHR_OPERATIONAL_WORKSITE_RE = /\b(?:presso|per|nella|nello|nel|nella|nei|nelle|alla|allo|all[’']?interno)\s+(?:(?:la|il|una|un|della|dello|delle|dei|degli|del)\s+)?(?:(?:nostr[oaie]|propri[oaie]|su[oaie]|vostr[oaie]|loro)\s+)?(?:l[’']|dell[’'])?(?:sede(?:\s+(?:operativa|prestigiosa|di\s+lavoro))?|ufficio|filiale|studio|stabilimento|struttura)\s+(?:a|ad|in|nel|nella|nei|nelle|di)\s+([^,;:\n]+?)(?=\s*(?:[,;:]|$))/iu;
const LWPHR_CONTRACTED_WORKSITE_RE = /\b(?:nell|all)[’'](?:sede(?:\s+(?:operativa|prestigiosa|di\s+lavoro))?|ufficio|filiale|studio|stabilimento|struttura)\s+(?:a|ad|in|nel|nella|nei|nelle|di)\s+([^,;:\n]+?)(?=\s*(?:[,;:]|$))/iu;
const LWPHR_OPERATIONAL_MANDATE_RE = /\b(?:siamo\s+stati|ci\s+ha(?:nno)?|siamo)\s+incaricat\w*\b|\bsiamo\s+alla\s+ricerca\b/iu;
const LWPHR_PARENTHETICAL_RE = /\(([^()\n]{2,100})\)/gu;

function extractLwphrLocationContext(title = '', pdfText = '') {
  const contexts = [];
  const titleText = String(title || '').trim();
  if (titleText) contexts.push(titleText);

  const lines = String(pdfText || '').split(/\r?\n/);
  let hasExplicitWorksiteLabel = false;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(LWPHR_LOCATION_LABEL_RE);
    if (!match) continue;
    hasExplicitWorksiteLabel = true;
    const value = match[1].trim();
    if (value) contexts.push(value);
    else if (lines[index + 1]?.trim()) contexts.push(lines[index + 1].trim());
  }

  // LWP PDFs sometimes state an operational worksite in narrative prose
  // (for example "Per la sede prestigiosa di St. Moritz, siamo stati
  // incaricati..."). Require both the operational relation and the exact
  // mandate wording: employer-seat prose such as "con sede a Lugano ricerca"
  // is not a worksite signal, and an explicit worksite label always wins.
  const narrativeText = String(pdfText || '');
  const narrativeParagraphs = narrativeText
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/-\s*\r?\n\s*/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (const paragraph of narrativeParagraphs) {
    if (hasExplicitWorksiteLabel || !LWPHR_OPERATIONAL_MANDATE_RE.test(paragraph)) continue;
    const match = paragraph.match(LWPHR_OPERATIONAL_WORKSITE_RE)
      || paragraph.match(LWPHR_CONTRACTED_WORKSITE_RE);
    if (match?.[1]) contexts.push(match[1].trim());
  }

  // A few LWP PDFs put the work city in the heading as "City/CANTON". Only
  // accept a parenthetical that resolves to both a Swiss city and a canton;
  // a bare city mentioned in body prose is deliberately ignored.
  for (const match of String(pdfText || '').matchAll(LWPHR_PARENTHETICAL_RE)) {
    const value = match[1].trim();
    if (rescueSwissCityFromText(value) && inferAnyCanton(value)) contexts.push(value);
  }

  return contexts.join('\n');
}

export function inferLwphrLocation(title = '', pdfText = '') {
  const locationContext = extractLwphrLocationContext(title, pdfText);
  const explicitCity = rescueSwissCityFromText(locationContext);
  if (explicitCity) return explicitCity;

  // Preserve the known city aliases used in LWP location contexts, but never
  // turn a city mentioned in ordinary PDF prose into a locality. Each
  // returned alias is checked through the shared all-canton registry before
  // it becomes a locality.
  const text = locationContext.toLowerCase();
  const cityAliases = [
    ['Locarno', /locarno/],
    ['Mendrisio', /mendrisiotto|mendrisio/],
    ['Lugano', /luganese|lugano/],
  ];
  for (const [city, pattern] of cityAliases) {
    if (pattern.test(text) && inferAnyCanton(city)) return city;
  }

  return '';
}

export function inferLwphrCanton(title = '', pdfText = '') {
  const location = inferLwphrLocation(title, pdfText);
  if (location) return inferAnyCanton(location);

  return inferAnyCanton(extractLwphrLocationContext(title, pdfText));
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

export function buildLwphrLocalizedPayload({ title = '', pdfText = '', location = '', pdfUrl = '' } = {}) {
  const trimmed = normalize(pdfText);
  const locationLabel = String(location || '').trim();
  const locationForSlug = locationLabel || 'Switzerland';
  const locationSentenceIt = locationLabel ? `Sede indicativa: ${locationLabel}.` : 'Sede indicativa non specificata nella pubblicazione.';
  const locationSentenceEn = locationLabel ? `Indicative location: ${locationLabel}.` : 'The publication does not specify a location.';
  const locationSentenceDe = locationLabel ? `Ungefaehrer Arbeitsort: ${locationLabel}.` : 'Die Ausschreibung nennt keinen Arbeitsort.';
  const locationSentenceFr = locationLabel ? `Lieu indicatif: ${locationLabel}.` : 'La publication ne precise pas de lieu.';
  const titles = {
    en: title,
    it: title,
    de: title,
    fr: title,
  };
  const slugs = {
    en: slugify(`${title} lwp ledermann wieting partners ${locationForSlug}`),
    it: slugify(`${title} lwp ledermann wieting partners ${locationForSlug}`),
    de: slugify(`${title} lwp ledermann wieting partners ${locationForSlug}`),
    fr: slugify(`${title} lwp ledermann wieting partners ${locationForSlug}`),
  };

  const descriptions = {
    it: [
      `LWP Ledermann Wieting & Partners pubblica questa opportunita sul proprio portale per il mercato svizzero. La descrizione completa del ruolo e stata estratta dal PDF ufficiale del mandato.`,
      locationSentenceIt,
      trimmed,
      `PDF ufficiale: ${pdfUrl}`,
    ].join('\n\n'),
    en: [
      `LWP Ledermann Wieting & Partners lists this role on its Swiss opportunities portal. The full role description below is extracted from the official PDF published by the recruiter.`,
      locationSentenceEn,
      trimmed,
      `Official PDF: ${pdfUrl}`,
    ].join('\n\n'),
    de: [
      `LWP Ledermann Wieting & Partners veroeffentlicht diese Stelle in seinem Schweizer Karriereportal. Die vollstaendige Beschreibung unten wurde aus dem offiziellen PDF der Ausschreibung extrahiert.`,
      locationSentenceDe,
      trimmed,
      `Offizielles PDF: ${pdfUrl}`,
    ].join('\n\n'),
    fr: [
      `LWP Ledermann Wieting & Partners publie cette opportunite sur son portail suisse. La description complete ci-dessous provient du PDF officiel de l annonce.`,
      locationSentenceFr,
      trimmed,
      `PDF officiel: ${pdfUrl}`,
    ].join('\n\n'),
  };

  return { titles, slugs, descriptions };
}
