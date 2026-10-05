import { decode as decodeHTML } from 'html-entities';
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
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
 * globally. The company is a leading specialty chemicals producer; this
 * parser remains tied to the company's own portal and site postings.
 *
 * Exports: parseListingPage, parseDetailPage, buildJob, stripHtml, normalizeSpace,
 *          inferLocation, isSwissJob
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';
import { stripScriptsAndStyles } from './crawler-template.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/* ── Text helpers ──────────────────────────────────────────── */

export function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html = '') {
  return decodeHTML(String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' '), { scope: 'strict' })
    .replaceAll('\u00a0', ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
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
 * check for the portal's site postings, with a fallback for empty locations
 * (the EMS seat in Domat/Ems is assumed when no location is given).
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
    // The careercenter card carries the workplace in its own desktop cell,
    // e.g. `<div class="width-15 desktop"><span>Groß-Umstadt, DEU</span>` or
    // `<span>Domat/Ems </span>`. Keep it: without it every card defaulted to
    // the Domat/Ems seat, and the German Groß-Umstadt vacancies were
    // published as Swiss ones (audit run 36528331656).
    const cardLocation = parsePortalCardLocation(match[2]);

    jobs.push({
      title: linkText,
      url: fullUrl,
      location: cardLocation.city
        ? (cardLocation.countryCode && cardLocation.countryCode !== 'CHE'
          ? cardLocation.city
          : inferLocation(cardLocation.city, ''))
        : inferLocation(linkText, stripHtml(context)),
      countryCode: cardLocation.countryCode,
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

/**
 * Read the workplace cell of a jobs.ems-group.com careercenter card.
 * Returns `{ city, countryCode }`; `countryCode` is the ISO-3 suffix the
 * portal appends to foreign sites ("Groß-Umstadt, DEU") and '' when the card
 * names a Swiss site without a country ("Domat/Ems ").
 *
 * @param {string} cardHtml Inner HTML of the card anchor.
 */
export function parsePortalCardLocation(cardHtml = '') {
  const cell = String(cardHtml || '').match(/<div[^>]*class="[^"]*\bdesktop\b[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
  const raw = cell ? normalizeSpace(stripHtml(cell[1])) : '';
  if (!raw) return { city: '', countryCode: '' };
  const withCountry = raw.match(/^(.*?),\s*([A-Z]{3})$/);
  const city = normalizeSpace((withCountry ? withCountry[1] : raw).replace(/,\s*$/, '')).replace(/\s*\/\s*/g, '/');
  return { city, countryCode: withCountry ? withCountry[2] : '' };
}

/**
 * A careercenter listing is out of scope when its card names a non-Swiss
 * country. The portal publishes EMS's German sites next to the Swiss ones.
 */
export function isForeignPortalListing(listing = {}) {
  const code = String(listing?.countryCode || '').toUpperCase();
  return Boolean(code) && code !== 'CHE';
}

// Attribute-aware opening tag: the portal puts markup inside attribute values
// (`<section aria-label="<b>Über uns</b>" class="about">`), so `[^>]*` would
// stop inside the aria-label and miss the class.
const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;

function openTagRe(tag, attrPattern) {
  return new RegExp(`<${tag}\\b${ATTRS}?${attrPattern}${ATTRS}>`, 'i');
}

function readBalancedElement(html, contentStart, tagName) {
  const tagRe = new RegExp(`<(/?)${tagName}\\b${ATTRS}>`, 'gi');
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[1] === '/') depth -= 1;
    else if (!/\/>$/.test(m[0])) depth += 1;
    if (depth === 0) return html.slice(contentStart, m.index);
  }
  return '';
}

function portalBlock(html, tag, attrPattern) {
  const m = openTagRe(tag, attrPattern).exec(html);
  if (!m) return '';
  return readBalancedElement(html, m.index + m[0].length, tag);
}

function portalBlockText(blockHtml = '') {
  const cleaned = String(blockHtml || '')
    .replace(/<a[^>]*class="[^"]*\breadmore\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<h[1-6][^>]*>/gi, '\n');
  return stripHtml(cleaned)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function portalJsonLdPosting(html = '') {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      const posting = nodes.find((node) => node && node['@type'] === 'JobPosting');
      if (posting) return posting;
    } catch { /* malformed block: ignore */ }
  }
  return null;
}

/**
 * Parse a jobs.ems-group.com vacancy page (Prospective "directlink" posting
 * template): tasks, profile, benefits and the "Über uns" paragraph, in page
 * order, with list items kept as bullets. The contact block (phone numbers,
 * recruiter e-mail), the send-to-me form and the privacy footer are outside
 * the returned body by construction. Returns null for any other layout.
 *
 * @param {string} html
 */
export function parsePortalDetailPage(html = '') {
  if (!html || !/<section[^>]*\bid="AufgabenProfil"/i.test(html)) return null;
  const titleBlock = portalBlock(html, 'section', 'class="[^"]*\\bjob-title\\b[^"]*"');
  const h1 = titleBlock.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1 ? normalizeSpace(stripHtml(h1[1])) : '';
  const subtitle = normalizeSpace(stripHtml((titleBlock.match(/<div[^>]*class="[^"]*\bjob-subtitle\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || ''));

  const sections = [
    portalBlock(html, 'section', 'id="Einleitung"'),
    portalBlock(html, 'section', 'id="AufgabenProfil"'),
    portalBlock(html, 'section', 'class="[^"]*\\bbenefits\\b[^"]*"'),
    portalBlock(html, 'div', 'class="[^"]*\\baboutText\\b[^"]*"'),
  ].map(portalBlockText).filter(Boolean);
  const description = sections.join('\n\n');

  const posting = portalJsonLdPosting(html);
  const address = posting?.jobLocation?.address || {};
  const locality = normalizeSpace(String(address.addressLocality || '').replace(/,\s*$/, ''));
  const country = normalizeSpace(address.addressCountry || '');
  const postalCode = normalizeSpace(address.postalCode || '');
  const subtitleLocation = subtitle.split('|').map((part) => part.trim()).filter(Boolean).pop() || '';

  return {
    title,
    description,
    locality: locality || subtitleLocation.replace(/,\s*[A-Z]{3}$/, ''),
    country,
    postalCode,
    subtitle,
    employmentType: normalizeSpace(posting?.employmentType || ''),
    datePosted: normalizeSpace(posting?.datePosted || ''),
  };
}

/**
 * True when the portal page itself places the vacancy outside Switzerland
 * (`addressCountry: "Deutschland"` in the JobPosting, or the ", DEU" suffix
 * of the subtitle location).
 */
export function isForeignPortalDetail(detail = {}) {
  const country = String(detail?.country || '').trim();
  if (country && !/^(schweiz|switzerland|suisse|svizzera|ch|che)$/i.test(country)) return true;
  const code = String(detail?.subtitle || '').match(/,\s*([A-Z]{3})\s*$/);
  return Boolean(code && code[1] !== 'CHE');
}

/* ── Detail page parser ────────────────────────────────────── */

/**
 * Parse an EMS-Chemie job detail page.
 * Returns { title, description, location, canton, sections[], requirements[] }
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  const h1Match = stripScriptsAndStyles(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
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
  // Only the posting's own text is published (issue 5253): without the
  // careercenter body a listing used to go out with an invented Italian
  // blurb about the Domat/Ems seat; no job is built from it any more.
  const description = String(raw.description || '').trim();
  if (!meetsSourceBodyFloor(description)) return null;
  // The vacancy body is German on the careercenter portal. Declare the
  // language of the text actually stored instead of leaving it to a
  // downstream default.
  const sourceLang = raw.sourceLang || 'de';

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
    descriptionByLocale: { [sourceLang]: description },
    sourceLang,
    ...sourcePostingDateFields(raw.datePosted),
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
