/**
 * EMS-Chemie AG — job parser
 *
 * EMS-Group publishes vacancies on their career portal:
 *   https://jobs.ems-group.com/
 *
 * The old static page at ems-group.com/en/career/job-vacancies/ now loads
 * jobs dynamically and returns empty HTML to crawlers. The actual job data
 * lives on the jobs.ems-group.com portal.
 *
 * EMS-Chemie is headquartered in Domat/Ems (GR) with ~3000 employees
 * globally. The company is a leading specialty chemicals producer.
 *
 * Exports: parseListingPage, parseDetailPage, buildJob, stripHtml, normalizeSpace,
 *          inferLocation, isSwissJob
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';

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
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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
 * Strip the trailing " | Location | <Company> AG Location" suffix that the
 * EMS career portal appends to every job title. Covers both the parent
 * EMS-CHEMIE AG label and the subsidiary EFTEC AG label. Without stripping,
 * the suffix leaks into the slug as `…-ems-chemie-ag-domat-ems` which the
 * build then doubles when it appends its own company suffix.
 *
 * Examples:
 *   "Leiter Controlling | Domat/Ems | EMS-CHEMIE AG Domat/Ems"             → "Leiter Controlling"
 *   "Transportdisponent ... | Romanshorn | EFTEC AG Romanshorn"            → "Transportdisponent ..."
 *   "Leiter Controlling"                                                    → "Leiter Controlling"
 */
export function stripEmsChemieTitleSuffix(value = '') {
  return String(value || '')
    .replace(/\s*\|\s*[^|]*\|\s*(?:EMS-?CHEMIE|EFTEC)\s+AG[^|]*$/i, '')
    .trim();
}

/* ── Location helpers ──────────────────────────────────────── */

/**
 * Infer location from job title and description.
 * EMS has sites in Domat/Ems (HQ), Romanshorn, and internationally.
 */
export function inferLocation(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  if (/domat\/ems|domat.ems|ems\s*\(gr\)|7013/i.test(combined)) return 'Domat/Ems';
  if (/romanshorn/i.test(combined)) return 'Romanshorn';
  if (/zurich|zürich|zurigo/i.test(combined)) return 'Zürich';
  if (/markdorf/i.test(combined)) return 'Markdorf';
  if (/shanghai|china/i.test(combined)) return 'Shanghai';
  if (/usa|america|sumter/i.test(combined)) return 'USA';
  if (/japan|tokyo/i.test(combined)) return 'Japan';
  return 'Domat/Ems'; // Default to HQ
}

/**
 * Check if a job location is in Switzerland. Uses the canonical BFS-based
 * check so every canton/municipality is recognized, with a fallback for
 * empty locations (EMS HQ in Domat/Ems is assumed when no location is given).
 */
export function isSwissJob(location = '') {
  const loc = String(location || '');
  if (!loc.trim()) return true;
  if (/\b(schweiz|svizzera|switzerland|suisse|ch)\b/i.test(loc)) return true;
  return isTargetSwissLocation(loc);
}

/* ── Listing page parser ───────────────────────────────────── */

/**
 * Parse the EMS-Group career listing page.
 * Returns an array of { title, url, location, datePosted }.
 *
 * Handles multiple HTML structures:
 * 1. jobs.ems-group.com portal (primary — cards with links to /offene-stellen/{slug}/{uuid})
 * 2. Legacy ems-group.com table-based layout
 * 3. Card-based layout
 */
export function parseListingPage(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  const seen = new Set();

  // Pattern 1: jobs.ems-group.com portal links (/offene-stellen/{slug}/{uuid})
  const portalLinkRe = /<a[^>]+href="((?:https?:\/\/jobs\.ems-group\.com)?\/offene-stellen\/[^"]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = portalLinkRe.exec(html)) !== null) {
    const url = match[1];
    const linkText = normalizeSpace(stripHtml(match[2]));
    if (!linkText || linkText.length < 3) continue;

    const fullUrl = url.startsWith('http') ? url : `https://jobs.ems-group.com${url}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    // Extract location from surrounding HTML context
    const contextStart = Math.max(0, match.index - 500);
    const contextEnd = Math.min(html.length, match.index + match[0].length + 500);
    const context = html.slice(contextStart, contextEnd);

    jobs.push({
      title: linkText,
      url: fullUrl,
      location: inferLocation(linkText, stripHtml(context)),
      datePosted: '',
    });
  }

  // Pattern 2: Job listing table rows (legacy ems-group.com)
  if (jobs.length === 0) {
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((match = rowRe.exec(html)) !== null) {
      const rowHtml = match[1];
      const linkMatch = rowHtml.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const url = linkMatch[1];
      const title = normalizeSpace(stripHtml(linkMatch[2]));
      if (!title || title.length < 5) continue;

      // Reject navigation links (career section landing pages)
      if (/\/career\/$|\/karriere\/$|\/job-vacancies\/$|\/offene-stellen\/$/i.test(url)) continue;

      const fullUrl = url.startsWith('http') ? url : `https://www.ems-group.com${url}`;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

      const location = inferLocation(title, stripHtml(rowHtml));

      jobs.push({
        title,
        url: fullUrl,
        location,
        datePosted: '',
      });
    }
  }

  // Pattern 3: Card-based layout
  if (jobs.length === 0) {
    const cardRe = /<(?:div|article|li)[^>]*class="[^"]*(?:job|vacanc|stelle|career|position)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article|li)>/gi;
    while ((match = cardRe.exec(html)) !== null) {
      const cardHtml = match[1];
      const linkMatch = cardHtml.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const url = linkMatch[1];
      const title = normalizeSpace(stripHtml(linkMatch[2]));
      if (!title || title.length < 5) continue;

      const fullUrl = url.startsWith('http') ? url : `https://www.ems-group.com${url}`;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

      jobs.push({
        title,
        url: fullUrl,
        location: inferLocation(title, stripHtml(cardHtml)),
        datePosted: '',
      });
    }
  }

  // Pattern 4: Simple link list in career section (legacy)
  if (jobs.length === 0) {
    const linkRe = /<a[^>]+href="(\/(?:en|de)\/career\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = linkRe.exec(html)) !== null) {
      const url = match[1];
      const title = normalizeSpace(stripHtml(match[2]));
      if (!title || title.length < 5) continue;

      // Reject navigation links (career section landing pages)
      if (/\/career\/$|\/career\/job-vacancies\/?$/i.test(url)) continue;
      if (/\/career\/the-start-at-ems|\/career\/apprenticeship|\/career\/further-education|\/career\/employee-statements/i.test(url)) continue;

      const fullUrl = `https://www.ems-group.com${url}`;
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

      jobs.push({
        title,
        url: fullUrl,
        location: inferLocation(title, ''),
        datePosted: '',
      });
    }
  }

  return jobs;
}

/* ── Detail page parser ────────────────────────────────────── */

/**
 * Parse an EMS-Chemie job detail page.
 * Returns { title, description, location, canton, sections[], requirements[] }
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? normalizeSpace(stripHtml(h1Match[1])) : '';
  if (!title || title.length < 3) return null;

  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const contentHtml = mainMatch ? mainMatch[1] : html;
  const description = stripHtml(contentHtml);

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
  const canton = location === 'Romanshorn' ? 'TG' : 'GR';

  const requirements = sections
    .filter((s) => /anforderung|profil|voraussetz|mitbring|qualifikat|requirements|skills/i.test(s.heading))
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

/* ── Job builder ───────────────────────────────────────────── */

export function buildJob(raw) {
  if (!raw || !raw.title) return null;

  const title = stripEmsChemieTitleSuffix(normalizeSpace(raw.title));
  if (!title || title.length < 3) return null;

  const location = raw.location || 'Domat/Ems';
  const canton = location === 'Romanshorn' ? 'TG' : 'GR';
  const description = raw.description || `${title} presso EMS-Chemie AG, azienda leader nel settore dei polimeri speciali e della chimica fine con sede a Domat/Ems (Grigioni). EMS-Chemie è il più grande produttore mondiale di poliammidi ad alte prestazioni, con circa 3000 collaboratori in tutto il mondo. Sede di lavoro: ${location}.`;

  return {
    title,
    company: 'EMS-Chemie AG',
    companyKey: 'ems-chemie',
    url: raw.url || '',
    location,
    canton,
    country: 'CH',
    postalCode: '7013',
    streetAddress: 'Via Innovativa 1',
    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    employmentType: raw.employmentType || 'FULL_TIME',
    category: detectCategory(title, description),
    description,
    postedDate: raw.datePosted || new Date().toISOString().slice(0, 10),
    source: 'company-website',
    slug: slugify(`${title}-ems-chemie-${location}`),
    slugByLocale: {
      it: slugify(`${title}-ems-chemie-${location}`),
      en: slugify(`${title}-ems-chemie-${location}`),
      de: slugify(`${title}-ems-chemie-${location}`),
      fr: slugify(`${title}-ems-chemie-${location}`),
    },
    titleByLocale: { it: title, en: title, de: title, fr: title },
  };
}

/* ── Category detection ────────────────────────────────────── */

function detectCategory(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  if (/chemik|chimico|labor|analy|forsch|ricerca|r&d|entwicklung/i.test(combined)) return 'science';
  if (/produktion|produzion|anlage|impianto|schicht|turno/i.test(combined)) return 'manufacturing';
  if (/ingenieur|ingegnere|engineer|technik|tecnic/i.test(combined)) return 'engineering';
  if (/it\b|software|informatik|informatica|system|sap/i.test(combined)) return 'technology';
  if (/kaufm|commerci|administrat|amministrativ|büro|ufficio|assistenz|controlling|buchhalt|finanzbuch/i.test(combined)) return 'administration';
  if (/logistik|logistica|lager|magazz|supply chain/i.test(combined)) return 'logistics';
  if (/verkauf|vendita|sales|marketing|vertrieb|key account|area sales/i.test(combined)) return 'sales';
  if (/finanz|contabil|buchhalt|controlling|finanza|leiter controlling|leiter finanzbuch/i.test(combined)) return 'finance';
  if (/hr\b|personal|risorse umane/i.test(combined)) return 'hr';
  if (/qualität|qualita|quality/i.test(combined)) return 'quality';
  if (/projektleiter|project/i.test(combined)) return 'engineering';
  return 'manufacturing'; // Default for chemicals company
}
