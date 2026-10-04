import { sourcePostingDateFields } from './source-posting-date.mjs';
import { JSDOM } from 'jsdom';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { decodeHtmlEntities } from './decode-html-entities.mjs';

const HQ = getCompanyDefaults('ksgr');

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeDate(raw = '') {
  return sourcePostingDateFields(raw).postedDate.slice(0, 10);
}

function pickLocation(job = {}) {
  const attrLocations = Array.isArray(job?.attributes?.['40']) ? job.attributes['40'] : [];
  const firstAttrLocation = attrLocations
    .map((value) => normalizeSpace(value))
    .find((value) => value && !/home office/i.test(value));
  if (firstAttrLocation) return firstAttrLocation;

  const rawAddress = String(job?.szas?.['sza_location.city'] || '').trim();
  if (!rawAddress) return '';
  const lines = rawAddress
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean);
  const postalCityMatch = [...lines]
    .reverse()
    .map((line) => line.match(/\b\d{4}(?:\s+|-(?=\p{L}))(\p{L}[^\n]*)/u))
    .find(Boolean);
  if (postalCityMatch) return normalizeSpace(postalCityMatch[1]);
  return lines[lines.length - 1] || '';
}

function pickPensum(job = {}) {
  const explicit = normalizeSpace(job?.szas?.sza_pensum || '');
  if (explicit) return explicit;
  const min = normalizeSpace(job?.szas?.['sza_pensum.min'] || job?.attributes?.['50']?.[0] || '');
  const max = normalizeSpace(job?.szas?.['sza_pensum.max'] || job?.attributes?.['60']?.[0] || '');
  if (min && max) return `${min} - ${max}%`;
  if (min) return `${min}%`;
  return '';
}

/**
 * Prospective rich-text field → the pipeline's markdown: `- ` bullets for
 * list items, blank-line separated paragraphs, entities decoded (`&ndash;`,
 * `&#39;` appear verbatim in the KSGR feed).
 */
function richTextToMarkdown(html = '') {
  // Source whitespace (indentation, line wraps in the HTML) is not layout;
  // only the markup below produces line breaks.
  const text = String(html || '')
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n\n')
    .replace(/<\/(?:p|div)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(text)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The vacancy text the Prospective API carries for jobs.ksgr.ch, in the
 * order the detail page renders it: the lead-in with the job title and
 * workload ("Starte nach Vereinbarung als <title> 80 - 100%"), the per-role
 * introduction (attribute `80` — the paragraph that tells one ward or team
 * from another), the task and profile lists, and the company tagline.
 * Every word comes from the feed.
 *
 * Attribute `80` used to be ignored and `sza_introduction` was published on
 * its own ("Starte nach Vereinbarung als" with no object), so the published
 * text was 17-19 % of the detail page and two wards with the same task list
 * shared one body (audit run 36528331656).
 */
function buildDescription(job = {}) {
  const szas = job?.szas || {};
  const parts = [];
  const lead = normalizeSpace(richTextToMarkdown(szas.sza_introduction || ''));
  const title = normalizeSpace(decodeHtml(szas.sza_title || job?.title || ''));
  if (lead) parts.push([lead, title, pickPensum(job)].filter(Boolean).join(' '));
  const intro = richTextToMarkdown((job?.attributes?.['80'] || []).join('\n\n'));
  if (intro) parts.push(intro);
  // The API carries the two lists without their headings; the page's own
  // headings are put back by composeKsgrDescription when the detail page is
  // read — none is invented here (the old "Aufgaben:"/"Anforderungen:").
  const tasks = richTextToMarkdown(szas.sza_tasks || '');
  if (tasks) parts.push(tasks);
  const reqs = richTextToMarkdown(szas.sza_requirements || '');
  if (reqs) parts.push(reqs);
  const profile = richTextToMarkdown(szas.sza_company_profil || '');
  if (profile) parts.push(profile);
  return parts.join('\n\n');
}

function parseWorkplace(raw = '') {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const postalLine = lines.find((l) => /CH-\d{4}/.test(l));
  const postalMatch = postalLine?.match(/CH-(\d{4})(?:\s+|-(?=\p{L}))(\p{L}.*)/u);
  return {
    streetAddress: lines.find((l) => /strasse|weg|gasse|platz/i.test(l)) || '',
    postalCode: postalMatch ? postalMatch[1] : '',
    city: postalMatch ? postalMatch[2] : '',
  };
}

export function parseKsgrApiJob(job = {}) {
  const detailUrl = normalizeSpace(job?.links?.directlink || '');
  if (!detailUrl) return null;

  const szas = job?.szas || {};
  const workplace = parseWorkplace(szas.sza_workplace || '');

  return {
    id: normalizeSpace(job?.id || job?.viewkey || ''),
    title: decodeHtml(normalizeSpace(szas.sza_title || job?.title || '')),
    detailUrl,
    applyUrl: normalizeSpace(szas.sza_apply_link || ''),
    location: pickLocation(job),
    canton: HQ.canton,
    postedDate: normalizeDate(job?.start_date || ''),
    employmentType: pickPensum(job),
    description: buildDescription(job),
    industry: normalizeSpace(szas.sza_industry || ''),
    streetAddress: workplace.streetAddress,
    postalCode: workplace.postalCode,
    region: normalizeSpace(szas['sza_location.region'] || ''),
    country: normalizeSpace(szas['sza_location.country'] || 'Schweiz'),
  };
}

export function parseKsgrJobsPage(payload = {}) {
  const jobs = Array.isArray(payload?.jobs)
    ? payload.jobs.map((job) => parseKsgrApiJob(job)).filter(Boolean)
    : [];
  const total = Number(payload?.total);
  return {
    total: Number.isFinite(total) ? total : jobs.length,
    jobs,
  };
}

/**
 * Sections of the jobs.ksgr.ch detail page that the Prospective API does not
 * carry: the benefit cards ("Und das bieten wir dir") and the contact block.
 * Both are part of every vacancy page; the "Weitere spannende Stellen" /
 * JobAbo teasers after them are chrome and stay out.
 */
export function parseKsgrDetailExtras(html = '') {
  const document = new JSDOM(String(html || '')).window.document;
  // The page's headings of the task and profile lists ("Das sind deine
  // Aufgaben", "Das bringst du mit"), keyed by the list's first item so they
  // can be put back over the same lists in the API text.
  const listHeadings = ['#navTasks', '#navProfile']
    .map((selector) => document.querySelector(selector))
    .filter(Boolean)
    .map((block) => ({
      heading: normalizeSpace(block.querySelector('h2')?.textContent || ''),
      firstItem: normalizeSpace(block.querySelector('li')?.textContent || ''),
    }))
    .filter((entry) => entry.heading && entry.firstItem);
  const benefitsSection = document.querySelector('section#benefits');
  const benefits = benefitsSection
    ? [...benefitsSection.querySelectorAll('.benefitContainer')]
      .map((card) => {
        const title = normalizeSpace(card.querySelector('h3')?.textContent || '');
        const text = normalizeSpace(card.querySelector('.benefitText')?.textContent || '');
        return [title, text].filter(Boolean).join(': ');
      })
      .filter(Boolean)
    : [];
  const contactSection = document.querySelector('section#navContact');
  let contact = '';
  if (contactSection) {
    const lines = [...contactSection.querySelectorAll('p')]
      .flatMap((node) => richTextToMarkdown(node.innerHTML || '').split('\n'))
      .map((line) => normalizeSpace(line))
      .filter(Boolean);
    contact = [...new Set(lines)].join('\n');
  }
  return {
    listHeadings,
    benefitsHeading: normalizeSpace(benefitsSection?.querySelector('h2')?.textContent || ''),
    benefits,
    contactHeading: normalizeSpace(contactSection?.querySelector('h2')?.textContent || ''),
    contact,
  };
}

/**
 * API description + the detail-page-only sections, with the page's own
 * headings. Without extras (detail page unreadable) the API description is
 * returned unchanged. A section whose heading the page does not print gets
 * no heading — none is invented.
 */
export function composeKsgrDescription(apiDescription = '', extras = null) {
  let body = String(apiDescription || '').trim();
  if (!extras) return body;
  if (body && extras.listHeadings?.length) {
    const lines = body.split('\n');
    for (const { heading, firstItem } of extras.listHeadings) {
      const at = lines.findIndex((line) => normalizeSpace(line) === `- ${firstItem}`);
      if (at >= 0 && (at === 0 || !lines[at - 1].trim())) {
        lines.splice(at, 0, `## ${heading}`, '');
      }
    }
    body = lines.join('\n');
  }
  const parts = [body].filter(Boolean);
  if (extras.benefits?.length) {
    const list = extras.benefits.map((item) => `- ${item}`).join('\n');
    parts.push(extras.benefitsHeading ? `## ${extras.benefitsHeading}\n\n${list}` : list);
  }
  if (extras.contact) {
    parts.push(extras.contactHeading ? `## ${extras.contactHeading}\n\n${extras.contact}` : extras.contact);
  }
  return parts.join('\n\n');
}
