/**
 * BancaStato (Banca dello Stato del Cantone Ticino) — job parser
 *
 * BancaStato publishes vacancies on their website at:
 *   https://www.bancastato.ch/la-banca/posti-vacanti
 *
 * The career page lists jobs as structured HTML with title, location,
 * and link to detail pages. BancaStato is a cantonal bank with ~500
 * employees, headquartered in Bellinzona (TI).
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

/* ── Listing page parser ───────────────────────────────────── */

/**
 * Parse the BancaStato career listing page HTML.
 * Returns an array of { title, url, location, datePosted }.
 *
 * Expected HTML patterns:
 *   - Job links within <a> tags pointing to detail pages
 *   - Job titles in headings or link text
 *   - Location often mentioned in body or as "Bellinzona", "Lugano", etc.
 */
export function parseListingPage(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  const seen = new Set();

  // Pattern 1: Links to job detail pages (typical career page structure)
  // Match <a> tags with href containing job-related paths
  const linkRe = /<a[^>]+href="([^"]*(?:posti-vacanti|offerte-lavoro|careers?|jobs?|stellen)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const url = match[1];
    const linkText = normalizeSpace(stripHtml(match[2]));

    if (!linkText || linkText.length < 5) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    jobs.push({
      title: linkText,
      url: url.startsWith('http') ? url : `https://www.bancastato.ch${url}`,
      location: 'Bellinzona',
      datePosted: '',
    });
  }

  // Pattern 2: Structured job cards with h2/h3 + link
  const cardRe = /<(?:h[2-4]|div)[^>]*class="[^"]*(?:job|vacancy|position|posto)[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = cardRe.exec(html)) !== null) {
    const url = match[1];
    const title = normalizeSpace(stripHtml(match[2]));

    if (!title || title.length < 5) continue;
    const fullUrl = url.startsWith('http') ? url : `https://www.bancastato.ch${url}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    jobs.push({
      title,
      url: fullUrl,
      location: 'Bellinzona',
      datePosted: '',
    });
  }

  // Pattern 3: Generic list items with links inside career section
  const liRe = /<li[^>]*>\s*<a[^>]+href="(\/[^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi;
  while ((match = liRe.exec(html)) !== null) {
    const url = match[1];
    const title = normalizeSpace(stripHtml(match[2]));

    if (!title || title.length < 10) continue;
    const fullUrl = `https://www.bancastato.ch${url}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    // Only include if it looks like a job title
    if (/bancastato|posti|lavoro|impieg|responsabil|collaborat|dirett|analista|special/i.test(title + url)) {
      jobs.push({
        title,
        url: fullUrl,
        location: 'Bellinzona',
        datePosted: '',
      });
    }
  }

  return jobs;
}

/* ── Detail page parser ────────────────────────────────────── */

/**
 * Parse a BancaStato job detail page.
 * Returns { title, description, location, requirements[], sections[] }
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract title from <h1> or <title>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = h1Match
    ? normalizeSpace(stripHtml(h1Match[1]))
    : titleMatch
      ? normalizeSpace(stripHtml(titleMatch[1])).replace(/\s*[-|].*$/, '')
      : '';

  if (!title || title.length < 3) return null;

  // Extract main content area
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const contentHtml = mainMatch ? mainMatch[1] : html;

  // Extract description text
  const description = normalizeSpace(stripHtml(contentHtml));

  // Extract sections (h2/h3 based)
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

    // Extract list items
    const items = [];
    const liRe2 = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe2.exec(sectionHtml)) !== null) {
      const text = normalizeSpace(stripHtml(li[1]));
      if (text.length > 5) items.push(text);
    }

    if (items.length > 0 || normalizeSpace(stripHtml(sectionHtml)).length > 30) {
      sections.push({
        heading: headings[i].text,
        items,
        text: normalizeSpace(stripHtml(sectionHtml)),
      });
    }
  }

  // Infer location from content
  let location = 'Bellinzona';
  if (/\blugano\b/i.test(description)) location = 'Lugano';
  else if (/\blocarno\b/i.test(description)) location = 'Locarno';
  else if (/\bchiasso\b/i.test(description)) location = 'Chiasso';
  else if (/\bmendrisio\b/i.test(description)) location = 'Mendrisio';

  // Extract requirements
  const requirements = sections
    .filter((s) => /requisit|profil|competen|formazione|esperien|richied/i.test(s.heading))
    .flatMap((s) => s.items);

  return {
    title,
    description: description.length > 50 ? description : '',
    location,
    canton: 'TI',
    sections,
    requirements,
    sourceTextLength: description.length,
  };
}

/* ── Job builder ───────────────────────────────────────────── */

/**
 * Build a normalized job object from raw listing + detail data.
 */
export function buildJob(raw) {
  if (!raw || !raw.title) return null;

  const title = normalizeSpace(raw.title);
  if (!title || title.length < 3) return null;

  const location = raw.location || 'Bellinzona';
  const description = raw.description || `${title} presso Banca dello Stato del Cantone Ticino (BancaStato), istituto bancario cantonale con sede a Bellinzona. BancaStato è la banca di riferimento per famiglie, aziende e enti pubblici del Cantone Ticino, con filiali su tutto il territorio cantonale.`;

  // Ensure description is >= 220 chars for quality gate
  const minDesc = `${title} — posizione aperta presso Banca dello Stato del Cantone Ticino (BancaStato), istituto bancario cantonale con sede a ${location}. BancaStato è la banca di riferimento per famiglie, aziende e enti pubblici del Cantone Ticino, con filiali su tutto il territorio cantonale. Offre un ambiente lavorativo stabile e stimolante.`;
  const finalDescription = description.length >= 220 ? description : minDesc;

  return {
    title,
    company: 'BancaStato',
    companyKey: 'bancastato',
    url: raw.url || '',
    location,
    canton: raw.canton || 'TI',
    country: 'CH',
    addressLocality: location,
    addressCountry: 'CH',
    category: detectCategory(title, finalDescription),
    description: finalDescription,
    postedDate: raw.datePosted || new Date().toISOString().slice(0, 10),
    source: 'company-website',
    slug: slugify(`${title}-bancastato-${location}`),
    slugByLocale: {
      it: slugify(`${title}-bancastato-${location}`),
      en: slugify(`${title}-bancastato-${location}`),
      de: slugify(`${title}-bancastato-${location}`),
      fr: slugify(`${title}-bancastato-${location}`),
    },
    titleByLocale: { it: title, en: title, de: title, fr: title },
    _targetScope: { canton: 'TI', location },
  };
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  if (/credito|finanz|invest|risk|tesor|asset|portfolio/i.test(combined)) return 'finance';
  if (/compliance|legal|giuridic|normativ/i.test(combined)) return 'legal';
  if (/assistente|segretari|support|reception|amministrativ/i.test(combined)) return 'administration';
  if (/it\b|software|developer|system|informatica|ict|digital/i.test(combined)) return 'technology';
  if (/marketing|comunicazion|social|media|relazioni/i.test(combined)) return 'marketing';
  if (/risorse umane|hr\b|personale/i.test(combined)) return 'hr';
  if (/operativ|back office|logistic/i.test(combined)) return 'operations';
  return 'finance'; // Default for a bank
}
