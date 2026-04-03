/**
 * Ferrovia Retica (RhB) — job parser
 *
 * Rhaetian Railway publishes vacancies at:
 *   https://www.rhb.ch/de/arbeitgeber (German)
 *   https://www.rhb.ch/it/datore-di-lavoro (Italian)
 *
 * RhB is the largest employer in Grisons (Graubünden) with ~1400 employees.
 * Relevant for frontalieri in Grigioni italiani (Poschiavo, Brusio, Valposchiavo).
 *
 * The career page typically uses structured HTML or embeds an external
 * job portal (e.g., gateway.one or custom). Job listings include:
 *   - Title, location (Chur, Poschiavo, Landquart, etc.)
 *   - Employment type, percentage
 *   - Link to detail page
 *
 * Exports: parseListingPage, parseDetailPage, buildJob, stripHtml, normalizeSpace,
 *          isGrigioniItalianoJob
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

/* ── Location helpers ──────────────────────────────────────── */

const GRIGIONI_ITALIANO_LOCATIONS = [
  'poschiavo', 'brusio', 'campocologno', 'le prese',
  'valposchiavo', 'bernina', 'pontresina', 'samedan',
  'st. moritz', 'saint moritz', 'san moritz',
];

const ALL_RHB_LOCATIONS = [
  ...GRIGIONI_ITALIANO_LOCATIONS,
  'chur', 'coira', 'landquart', 'davos', 'klosters',
  'thusis', 'ilanz', 'disentis', 'arosa', 'filisur',
  'tiefencastel', 'scuol', 'zernez',
];

/**
 * Check if a job location is in the Italian-speaking part of Graubünden.
 */
export function isGrigioniItalianoJob(location = '', description = '') {
  const combined = `${location} ${description}`.toLowerCase();
  return GRIGIONI_ITALIANO_LOCATIONS.some((loc) => combined.includes(loc));
}

/**
 * Infer location from job content.
 */
export function inferLocation(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  for (const loc of ALL_RHB_LOCATIONS) {
    if (combined.includes(loc)) {
      return loc.charAt(0).toUpperCase() + loc.slice(1);
    }
  }
  return 'Chur'; // Default to HQ
}

/* ── Listing page parser ───────────────────────────────────── */

/**
 * Parse the RhB career listing page.
 * Returns an array of { title, url, location, datePosted, percentage }.
 */
export function parseListingPage(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  const seen = new Set();

  // Pattern 1: Job cards with title and link (typical CMS structure)
  const cardRe = /<(?:div|article|li)[^>]*class="[^"]*(?:job|vacancy|stelle|position)[^"]*"[^>]*>([\s\S]*?)(?:<\/(?:div|article|li)>)/gi;
  let match;
  while ((match = cardRe.exec(html)) !== null) {
    const cardHtml = match[1];
    const linkMatch = cardHtml.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = linkMatch[1];
    const title = normalizeSpace(stripHtml(linkMatch[2]));
    if (!title || title.length < 5) continue;

    const fullUrl = url.startsWith('http') ? url : `https://www.rhb.ch${url}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    // Extract percentage if present (e.g., "80-100%")
    const pctMatch = cardHtml.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
    const percentage = pctMatch ? `${pctMatch[1]}-${pctMatch[2]}%` : '';

    // Extract location from card
    const location = inferLocation(title, stripHtml(cardHtml));

    jobs.push({ title, url: fullUrl, location, datePosted: '', percentage });
  }

  // Pattern 2: Direct job links matching /it/job/ or /de/job/ URL pattern
  // The job-uebersicht page lists jobs as links like /it/job/title-slug_YYYY-NNNN/
  const jobLinkRe = /<a[^>]+href="(\/(?:it|de|en|fr)\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = jobLinkRe.exec(html)) !== null) {
    const url = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (!rawTitle || rawTitle.length < 5) continue;

    const fullUrl = `https://www.rhb.ch${url}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    // Extract location from title (e.g., "Standort Chur" or "Standort Samedan")
    const standortMatch = rawTitle.match(/Standort\s+(\w+)/i);
    const location = standortMatch ? standortMatch[1] : inferLocation(rawTitle, '');

    // Extract percentage (e.g., "50-100%" or "100%")
    const pctMatch = rawTitle.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || rawTitle.match(/\((\d{1,3})%\)/);
    const percentage = pctMatch ? (pctMatch[2] ? `${pctMatch[1]}-${pctMatch[2]}%` : `${pctMatch[1]}%`) : '';

    // Extract date from nearby context (DD. Month YYYY pattern)
    const dateMatch = html.slice(Math.max(0, match.index - 200), match.index + match[0].length + 200)
      .match(/(\d{1,2})\.\s*(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s*(\d{4})/i);
    let datePosted = '';
    if (dateMatch) {
      const months = { gennaio: '01', febbraio: '02', marzo: '03', aprile: '04', maggio: '05', giugno: '06', luglio: '07', agosto: '08', settembre: '09', ottobre: '10', novembre: '11', dicembre: '12', januar: '01', februar: '02', 'märz': '03', april: '04', mai: '05', juni: '06', juli: '07', august: '08', september: '09', oktober: '10', november: '11', dezember: '12' };
      const m = months[dateMatch[2].toLowerCase()] || '01';
      datePosted = `${dateMatch[3]}-${m}-${dateMatch[1].padStart(2, '0')}`;
    }

    jobs.push({ title: rawTitle, url: fullUrl, location, datePosted, percentage });
  }

  // Pattern 3: Simple link list with job-related URLs (fallback)
  const linkRe = /<a[^>]+href="([^"]*(?:stellen|jobs|offene|vacancies)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = linkRe.exec(html)) !== null) {
    const url = match[1];
    const title = normalizeSpace(stripHtml(match[2]));
    if (!title || title.length < 5) continue;

    const fullUrl = url.startsWith('http') ? url : `https://www.rhb.ch${url}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    jobs.push({
      title,
      url: fullUrl,
      location: inferLocation(title, ''),
      datePosted: '',
      percentage: '',
    });
  }

  return jobs;
}

/* ── Detail page parser ────────────────────────────────────── */

/**
 * Extract the job content div from an RhB detail page.
 * Targets the specific `JobDetailsPage_text` container which holds only
 * the job description, requirements, and benefits — excluding navigation,
 * breadcrumbs, share buttons, sidebar, contact cards, and related jobs.
 *
 * Returns the inner HTML of the content div, or falls back to <main>/<article>.
 */
function extractJobContentHtml(html) {
  // Primary: RhB's React-rendered job content container
  const textIdx = html.indexOf('JobDetailsPage_text');
  if (textIdx >= 0) {
    const divStart = html.lastIndexOf('<div', textIdx);
    if (divStart >= 0) {
      let depth = 0;
      let i = divStart;
      while (i < html.length) {
        if (html.slice(i, i + 4) === '<div') depth++;
        else if (html.slice(i, i + 6) === '</div>') {
          depth--;
          if (depth === 0) return html.slice(divStart, i + 6);
        }
        i++;
      }
    }
  }
  // Fallback: <main> or <article> (less precise)
  const fallback = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  return fallback ? fallback[1] : html;
}

/**
 * Parse an RhB job detail page.
 * Returns { title, description, location, canton, sections[], requirements[] }
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? normalizeSpace(stripHtml(h1Match[1])) : '';
  if (!title || title.length < 3) return null;

  const contentHtml = extractJobContentHtml(html);
  const description = normalizeSpace(stripHtml(contentHtml));

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

  const location = inferLocation(title, description);
  const canton = 'GR';

  const requirements = sections
    .filter((s) => /anforderung|profil|voraussetz|mitbring|qualifikat|requisit|competen/i.test(s.heading))
    .flatMap((s) => s.items);

  return {
    title,
    description: description.length > 50 ? description : '',
    location,
    canton,
    sections,
    requirements,
    sourceTextLength: description.length,
  };
}

/* ── Postal code mapping ────────────────────────────────────── */

export const RHB_POSTAL_CODES = {
  'chur': { postalCode: '7000', streetAddress: 'Bahnhofstrasse 25, 7001 Chur' },
  'coira': { postalCode: '7000', streetAddress: 'Bahnhofstrasse 25, 7001 Chur' },
  'landquart': { postalCode: '7302', streetAddress: 'Bahnhofstrasse 1, 7302 Landquart' },
  'davos': { postalCode: '7270', streetAddress: 'Bahnhofstrasse 1, 7270 Davos Platz' },
  'klosters': { postalCode: '7250', streetAddress: 'Bahnhofstrasse 1, 7250 Klosters' },
  'samedan': { postalCode: '7503', streetAddress: 'Bahnhof, 7503 Samedan' },
  'poschiavo': { postalCode: '7742', streetAddress: 'Piazza della Stazione, 7742 Poschiavo' },
  'pontresina': { postalCode: '7504', streetAddress: 'Bahnhof, 7504 Pontresina' },
  'st. moritz': { postalCode: '7500', streetAddress: 'Bahnhof, 7500 St. Moritz' },
  'thusis': { postalCode: '7430', streetAddress: 'Bahnhofstrasse, 7430 Thusis' },
  'ilanz': { postalCode: '7130', streetAddress: 'Bahnhof, 7130 Ilanz' },
  'disentis': { postalCode: '7180', streetAddress: 'Bahnhof, 7180 Disentis/Mustér' },
  'arosa': { postalCode: '7050', streetAddress: 'Bahnhof, 7050 Arosa' },
  'filisur': { postalCode: '7477', streetAddress: 'Bahnhof, 7477 Filisur' },
  'scuol': { postalCode: '7550', streetAddress: 'Bahnhof, 7550 Scuol' },
  'zernez': { postalCode: '7530', streetAddress: 'Bahnhof, 7530 Zernez' },
  'brusio': { postalCode: '7743', streetAddress: 'Stazione, 7743 Brusio' },
  'campocologno': { postalCode: '7744', streetAddress: 'Stazione, 7744 Campocologno' },
  'tiefencastel': { postalCode: '7450', streetAddress: 'Bahnhof, 7450 Tiefencastel' },
};

/**
 * Get postal code and address for a location.
 */
export function getLocationAddress(location = '') {
  const loc = location.toLowerCase().trim();
  const match = RHB_POSTAL_CODES[loc];
  if (match) return match;
  // Default to Chur HQ
  return { postalCode: '7000', streetAddress: 'Bahnhofstrasse 25, 7001 Chur' };
}

/* ── Fallback description builder ──────────────────────────── */

/**
 * Build a rich fallback description (>50 words) when detail page yields nothing.
 */
export function buildFallbackDescription(title, location, percentage) {
  const pctInfo = percentage ? ` Grado di occupazione: ${percentage}.` : '';
  return `${title} presso la Ferrovia Retica (RhB) a ${location}, Cantone dei Grigioni, Svizzera.${pctInfo}\n\nLa Ferrovia Retica è la più grande azienda di trasporti del Cantone dei Grigioni con circa 1400 collaboratori. La RhB gestisce la rete ferroviaria a scartamento ridotto più estesa della Svizzera, con 384 km di linee che attraversano 115 gallerie e 383 ponti, inclusa la celebre tratta patrimonio mondiale UNESCO dell'Albula/Bernina. L'azienda offre condizioni di impiego moderne e attrattive, un abbonamento generale di 2a classe, sconti viaggio, un piano pensionistico completo, possibilità di acquisto di vacanze supplementari e numerose opportunità di formazione e perfezionamento professionale.`;
}

/* ── Job builder ───────────────────────────────────────────── */

export function buildJob(raw) {
  if (!raw || !raw.title) return null;

  const title = normalizeSpace(raw.title);
  if (!title || title.length < 3) return null;

  const location = raw.location || 'Chur';
  const address = getLocationAddress(location);

  // Use detail description if available and >50 words, otherwise use rich fallback
  let description = '';
  if (raw.description && raw.description.split(/\s+/).length >= 50) {
    description = raw.description;
  } else {
    description = buildFallbackDescription(title, location, raw.percentage);
  }

  // Detect employment type from percentage
  let employmentType = 'FULL_TIME';
  if (raw.percentage) {
    const pctMatch = raw.percentage.match(/(\d{1,3})/);
    if (pctMatch && parseInt(pctMatch[1], 10) < 80) employmentType = 'PART_TIME';
  }

  // Use consistent company identifier across ALL locales to prevent slug churn.
  // "Ferrovia Retica (RhB)" slugifies to "ferrovia-retica-rhb" — this matches the
  // stable form that hardenJobLocaleFields produces from the company name.
  const baseSlug = slugify(`${title}-ferrovia-retica-rhb-${location}`);

  return {
    title,
    company: 'Ferrovia Retica (RhB)',
    companyKey: 'ferrovia-retica',
    url: raw.url || '',
    location,
    canton: 'GR',
    country: 'CH',
    postalCode: address.postalCode,
    streetAddress: address.streetAddress,
    employmentType,
    category: detectCategory(title, description),
    description,
    postedDate: raw.datePosted || new Date().toISOString().slice(0, 10),
    source: 'company-website',
    sourceLang: 'de',
    slug: baseSlug,
    slugByLocale: { it: baseSlug, en: baseSlug, de: baseSlug, fr: baseSlug },
    titleByLocale: { de: title },
    percentage: raw.percentage || '',
  };
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  if (/lokführer|macchinista|conducent|zugbegleit|capotreno/i.test(combined)) return 'transport';
  if (/gleisbau|binari|infrastruktur|infrastruttur|manutenz|unterhalt/i.test(combined)) return 'engineering';
  if (/elektri|meccanico|techniker|tecnico|werkstatt|officina/i.test(combined)) return 'engineering';
  if (/it\b|software|informatik|informatica|digital/i.test(combined)) return 'technology';
  if (/kaufm|commerci|administrat|amministrativ|büro|ufficio/i.test(combined)) return 'administration';
  if (/marketing|kommunikation|comunicazion|verkauf|vendita/i.test(combined)) return 'marketing';
  if (/finanz|contabil|buchhalt|controlling/i.test(combined)) return 'finance';
  if (/hr\b|personal|risorse umane/i.test(combined)) return 'hr';
  return 'transport'; // Default for railway company
}
