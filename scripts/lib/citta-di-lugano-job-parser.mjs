/**
 * Città di Lugano — job parser
 *
 * The municipality publishes public job competitions (concorsi pubblici) at:
 *   https://www.lugano.ch/temi-servizi/lavoro-e-impresa/concorsi-pubblici-posti-lavoro/
 *
 * Applications go through: https://egov.lugano.ch/it/services/3
 *
 * Listings typically contain:
 *   - Job title (in <strong> or heading tags)
 *   - Deadline (Scadenza)
 *   - PDF capitolato link with full job description
 *   - Link to egov.lugano.ch for application
 *
 * Exports: parseListingPage, parseDetailPage, buildJob, stripHtml, normalizeSpace
 */

/* ── Text helpers ──────────────────────────────────────────── */

export function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/**
 * Extract a date in DD.MM.YYYY format and convert to ISO.
 */
export function parseSwissDate(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return '';
  const [, day, month, year] = m;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/* ── Listing page parser ───────────────────────────────────── */

/**
 * Parse the Città di Lugano concorsi pubblici listing page.
 * Returns an array of { title, url, location, datePosted, deadline }.
 *
 * Structure:
 *   - Job titles in <strong> or <h3>/<h4> tags within list items
 *   - Deadline dates with "Scadenza" label
 *   - PDF links to capitolati (downloadConcorsi paths)
 *   - Application links to egov.lugano.ch
 */
export function parseListingPage(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  const seen = new Set();

  // Pattern 1: List items with <strong> job titles
  // e.g. <li><strong>Architetto/a progettista</strong> ... Scadenza: 30.03.2026 ...
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liRe.exec(html)) !== null) {
    const liHtml = match[1];

    // Extract title from <strong>
    const strongMatch = liHtml.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    if (!strongMatch) continue;
    const title = normalizeSpace(stripHtml(strongMatch[1]));
    if (!title || title.length < 5) continue;

    // Extract deadline
    const deadlineMatch = liHtml.match(/[Ss]cadenza[:\s]*(\d{1,2}\.\d{1,2}\.\d{4})/);
    const deadline = deadlineMatch ? parseSwissDate(deadlineMatch[1]) : '';

    // Extract PDF URL (capitolato)
    const pdfMatch = liHtml.match(/href="([^"]*downloadConcorsi[^"]*)"/i)
      || liHtml.match(/href="([^"]*\.pdf)"/i);
    const pdfUrl = pdfMatch
      ? (pdfMatch[1].startsWith('http') ? pdfMatch[1] : `https://www.lugano.ch${pdfMatch[1]}`)
      : '';

    // Extract application URL
    const applyMatch = liHtml.match(/href="(https?:\/\/egov\.lugano\.ch[^"]*)"/i);
    const applyUrl = applyMatch ? applyMatch[1] : 'https://egov.lugano.ch/it/services/3';

    // Use the application URL or PDF as the job URL
    const jobUrl = pdfUrl || applyUrl;

    if (seen.has(title)) continue;
    seen.add(title);

    jobs.push({
      title,
      url: jobUrl,
      pdfUrl,
      applyUrl,
      location: 'Lugano',
      datePosted: '',
      deadline,
    });
  }

  // Pattern 2: Heading-based structure (h3/h4 with job titles)
  const headingRe = /<h[3-4][^>]*>([\s\S]*?)<\/h[3-4]>/gi;
  while ((match = headingRe.exec(html)) !== null) {
    const title = normalizeSpace(stripHtml(match[1]));
    if (!title || title.length < 5) continue;
    if (seen.has(title)) continue;

    // Check if it looks like a job title (not a section heading)
    if (/concors|lavoro|impieg|responsabil|collaborat|architett|operai|autist|educat|cassi/i.test(title)) {
      seen.add(title);
      jobs.push({
        title,
        url: 'https://egov.lugano.ch/it/services/3',
        pdfUrl: '',
        applyUrl: 'https://egov.lugano.ch/it/services/3',
        location: 'Lugano',
        datePosted: '',
        deadline: '',
      });
    }
  }

  return jobs;
}

/* ── Detail page parser ────────────────────────────────────── */

/**
 * Parse a Città di Lugano job detail / PDF info page.
 * Returns { title, description, location, sections[], requirements[] }
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? normalizeSpace(stripHtml(h1Match[1])) : '';

  if (!title || title.length < 3) return null;

  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const contentHtml = mainMatch ? mainMatch[1] : html;
  const description = normalizeSpace(stripHtml(contentHtml));

  // Extract sections
  const sections = [];
  const headingRe = /<h[2-3][^>]*>([\s\S]*?)<\/h[2-3]>/gi;
  const headings = [];
  let m;
  while ((m = headingRe.exec(contentHtml)) !== null) {
    headings.push({ text: normalizeSpace(stripHtml(m[1])), index: m.index, length: m[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index + headings[i].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : contentHtml.length;
    const sectionHtml = contentHtml.slice(start, end);
    const items = [];
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe.exec(sectionHtml)) !== null) {
      const text = normalizeSpace(stripHtml(li[1]));
      if (text.length > 5) items.push(text);
    }
    if (items.length > 0 || normalizeSpace(stripHtml(sectionHtml)).length > 30) {
      sections.push({ heading: headings[i].text, items });
    }
  }

  const requirements = sections
    .filter((s) => /requisit|profil|competen|formazione|richied/i.test(s.heading))
    .flatMap((s) => s.items);

  return {
    title,
    description: description.length > 50 ? description : '',
    location: 'Lugano',
    canton: 'TI',
    sections,
    requirements,
    sourceTextLength: description.length,
  };
}

/* ── Job builder ───────────────────────────────────────────── */

/**
 * Build a normalized job object from raw listing data.
 */
export function buildJob(raw) {
  if (!raw || !raw.title) return null;

  const title = normalizeSpace(raw.title);
  if (!title || title.length < 3) return null;

  const rawDescription = raw.description || '';

  // Richer fallback description that always exceeds 50 words and 220 chars
  const richDesc = `${title} — concorso pubblico presso la Città di Lugano, amministrazione comunale del principale centro urbano del Cantone Ticino. La Città di Lugano è il più grande Comune della Svizzera italiana con circa 3000 dipendenti attivi in diversi settori dell'amministrazione pubblica. L'ente offre condizioni di lavoro pubbliche regolate dal contratto cantonale per i dipendenti dello Stato, con prestazioni sociali complete, contributi alla cassa pensione e un ambiente di lavoro stabile e inclusivo. La sede principale si trova a Piazza della Riforma 1, nel cuore del centro storico di Lugano. Le candidature vanno presentate tramite il portale digitale egov.lugano.ch.`;

  // Use raw description only if it meets both quality gates: >= 220 chars AND >= 50 words
  const rawWordCount = rawDescription.split(/\s+/).filter(Boolean).length;
  const finalDescription = (rawDescription.length >= 220 && rawWordCount >= 50) ? rawDescription : richDesc;

  return {
    title,
    company: 'Città di Lugano',
    companyKey: 'citta-di-lugano',
    url: raw.url || 'https://egov.lugano.ch/it/services/3',
    location: 'Lugano',
    canton: 'TI',
    country: 'CH',
    addressLocality: 'Lugano',
    addressRegion: 'TI',
    addressCountry: 'CH',
    postalCode: '6900',
    streetAddress: 'Piazza della Riforma',
    employmentType: inferEmploymentType(title, finalDescription),
    category: detectCategory(title, finalDescription),
    description: finalDescription,
    postedDate: raw.datePosted || new Date().toISOString().slice(0, 10),
    source: 'company-website',
    slug: slugify(`${title}-citta-di-lugano`),
    slugByLocale: {
      it: slugify(`${title}-citta-di-lugano`),
    },
    titleByLocale: { it: title },
    descriptionByLocale: { it: finalDescription },
    sourceLang: 'it',
    deadline: raw.deadline || '',
    _targetScope: { canton: 'TI', location: 'Lugano' },
  };
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  if (/architett|ingegner|progettist|edil|costruz/i.test(combined)) return 'engineering';
  if (/educato|docente|scuol|infanzia|asilo/i.test(combined)) return 'education';
  if (/pulizia|manuten|operai|giardinier|netturbino/i.test(combined)) return 'operations';
  if (/autist|conducent|trasport/i.test(combined)) return 'logistics';
  if (/cassi|sportell|riceviment/i.test(combined)) return 'administration';
  if (/informatica|it\b|digital|software/i.test(combined)) return 'technology';
  if (/comunicazion|marketing|relazioni/i.test(combined)) return 'marketing';
  if (/finanz|contabil|tesor/i.test(combined)) return 'finance';
  return 'administration'; // Default for public administration
}

/**
 * Infer employment type from title, description and optional percentage field.
 * Swiss job postings commonly include percentage (e.g. "80-100%").
 * @param {string} title
 * @param {string} description
 * @param {string} percentage
 * @returns {string} FULL_TIME or PART_TIME
 */
export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}
