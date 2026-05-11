/**
 * Giorgio Armani job parser for SAP SuccessFactors career pages.
 *
 * The Giorgio Armani careers portal runs on career5.successfactors.eu
 * (company=3397177P). The listing page is a JavaScript SPA, but individual
 * job detail pages are server-rendered HTML — this parser targets those.
 *
 * Detail page URL pattern:
 *   https://career5.successfactors.eu/career?career_ns=job_listing
 *     &company=3397177P&navBarLevel=JOB_SEARCH&rcm_site_locale=en_US
 *     &career_job_req_id={ID}&selected_lang=it_IT
 *
 * Valid pages have: <title>Career Opportunities: {Title} ({ID}) </title>
 * Invalid pages have: <title>Career Opportunities </title>
 */
import { JSDOM } from 'jsdom';
import {  isTargetSwissLocation, inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function htmlToText(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Swiss city names in job titles (Italian/German/French forms) ──

const SWISS_CITY_PATTERNS = [
  /\b(?:zurigo|zurich|zürich)\b/i,
  /\b(?:landquart)\b/i,
  /\b(?:ginevra|genève|genf|geneva)\b/i,
  /\b(?:berna|bern|berne)\b/i,
  /\b(?:basilea|basel|bâle)\b/i,
  /\b(?:losanna|lausanne)\b/i,
  /\b(?:lucerna|luzern|lucerne)\b/i,
  /\b(?:lugano)\b/i,
  /\b(?:winterthur)\b/i,
  /\b(?:san gallo|st\.?\s*gallen|saint-gall)\b/i,
  /\b(?:mendrisio)\b/i,
  /\b(?:chiasso)\b/i,
  /\b(?:bellinzona)\b/i,
  /\b(?:locarno)\b/i,
  /\b(?:stabio)\b/i,
  /\b(?:davos)\b/i,
  /\b(?:st\.?\s*moritz|saint-moritz)\b/i,
];

/**
 * Check if a job title or location refers to a Swiss location.
 * Covers both the SuccessFactors "Switzerland" country tag and
 * Swiss city names that appear in Italian job titles (e.g. "Zurigo").
 *
 * NOTE: We intentionally do NOT use isTargetSwissLocation() here because
 * it does broad substring matching (e.g. "Contra" in "Contract" matches
 * the Ticino municipality Contra). For Giorgio Armani, we use strict
 * word-boundary patterns only.
 */
export function isGiorgioArmaniSwissJob(title = '', country = '') {
  if (/switzerland|svizzera|suisse|schweiz/i.test(country)) return true;
  for (const pattern of SWISS_CITY_PATTERNS) {
    if (pattern.test(title)) return true;
  }
  return false;
}

/**
 * Infer canton from job title or location text via the BFS municipality dataset.
 */
export function inferGiorgioArmaniCanton(title = '', location = '') {
  return inferAnyCanton(`${title} ${location}`);
}

/**
 * Check if a detail page HTML belongs to a valid, active job posting.
 * Valid pages have title: "Career Opportunities: {Title} ({ID})"
 * Invalid pages have just: "Career Opportunities"
 */
export function isValidJobPage(html = '') {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  return /Career Opportunities:\s*.+\(\d+\)/.test(title);
}

/**
 * Quick-extract title and country from detail page HTML without full DOM parse.
 * Used for fast filtering before full parse.
 */
export function quickExtractJobMeta(html = '') {
  // Title from <title> tag
  const titleMatch = html.match(/<title>Career Opportunities:\s*(.+?)\s*\(\d+\)\s*<\/title>/i);
  const title = titleMatch ? normalizeSpace(htmlToText(titleMatch[1])) : '';

  // Country from metadata div: <b>Switzerland</b> or <b>Italy</b>
  const metaMatch = html.match(
    /Requisition ID[^<]*<b>\d+<\/b>[^<]*<b[^>]*>[^<]*<\/b>[^<]*<b>([^<]+)<\/b>[^<]*<b>([^<]+)<\/b>/
  );
  const area = metaMatch ? normalizeSpace(metaMatch[1]) : '';
  const country = metaMatch ? normalizeSpace(metaMatch[2]) : '';

  return { title, area, country };
}

/**
 * Parse a SuccessFactors job detail page.
 * Returns structured job data from the server-rendered HTML.
 */
export function parseGiorgioArmaniJobDetail(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // Title from <title> tag
  const rawTitle = document.querySelector('title')?.textContent || '';
  const titleMatch = rawTitle.match(/Career Opportunities:\s*(.+?)\s*\(\d+\)/);
  const title = titleMatch ? normalizeSpace(titleMatch[1]) : '';

  // Requisition ID from hidden input
  const reqIdEl = document.querySelector('input#career_job_req_id');
  const reqId = reqIdEl?.getAttribute('value') || '';

  // Metadata bar: "Requisition ID <b>5026</b> - Posted <b id='postedOnDate'></b> - <b>RETAIL</b> - <b>Switzerland</b>"
  const metaDivs = [...document.querySelectorAll('div[tabindex="0"]')];
  let area = '';
  let country = '';
  for (const div of metaDivs) {
    const text = div.textContent || '';
    if (text.includes('Requisition ID')) {
      const bolds = [...div.querySelectorAll('b')];
      // Pattern: [reqId, postedDate (empty), area, country]
      if (bolds.length >= 3) {
        area = normalizeSpace(bolds[bolds.length - 2]?.textContent || '');
        country = normalizeSpace(bolds[bolds.length - 1]?.textContent || '');
      }
      break;
    }
  }

  // Description from joqReqDescription
  const descContainer = document.querySelector('.joqReqDescription .externalPosting');
  let description = '';
  if (descContainer) {
    const sections = [];
    let currentBlocks = [];

    const flush = () => {
      if (currentBlocks.length > 0) {
        sections.push(currentBlocks.join('\n\n'));
        currentBlocks = [];
      }
    };

    for (const node of [...descContainer.children]) {
      const tag = node.tagName?.toLowerCase() || '';
      if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
        flush();
        currentBlocks.push(`## ${normalizeSpace(node.textContent || '')}`);
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = [...node.querySelectorAll('li')]
          .map((li) => normalizeSpace(li.textContent || ''))
          .filter(Boolean);
        if (items.length > 0) {
          currentBlocks.push(items.map((item) => `- ${item}`).join('\n'));
        }
        continue;
      }
      const text = normalizeSpace(htmlToText(node.outerHTML || node.textContent || ''));
      if (text) currentBlocks.push(text);
    }
    flush();
    description = sections.join('\n\n').trim();
  }

  // Apply URL
  const applyBtn = document.querySelector('a#applyButton_top, a#applyButton_bottom, a[id*="applyButton"]');
  const applyHref = applyBtn?.getAttribute('href') || '';

  return {
    title,
    reqId,
    area,
    country,
    description,
    applyHref,
  };
}

/**
 * Infer job category from recruiting area and title.
 */
export function inferGiorgioArmaniCategory(area = '', title = '') {
  const haystack = normalize(`${area} ${title}`);
  if (haystack.includes('retail') || haystack.includes('store') || haystack.includes('outlet') || haystack.includes('client advisor') || haystack.includes('sales associate')) return 'sales';
  if (haystack.includes('design') || haystack.includes('visual') || haystack.includes('creative')) return 'design';
  if (haystack.includes('restaurant') || haystack.includes('chef') || haystack.includes('bartender') || haystack.includes('sommelier') || haystack.includes('f&b')) return 'hospitality';
  if (haystack.includes('it') || haystack.includes('technology') || haystack.includes('developer') || haystack.includes('engineer')) return 'it';
  if (haystack.includes('finance') || haystack.includes('accounting') || haystack.includes('tax') || haystack.includes('controller')) return 'finance';
  if (haystack.includes('hr') || haystack.includes('human') || haystack.includes('talent')) return 'hr';
  if (haystack.includes('logist') || haystack.includes('warehouse') || haystack.includes('stock')) return 'logistics';
  if (haystack.includes('marketing') || haystack.includes('communication')) return 'marketing';
  return 'other';
}

/**
 * Build localized content for a parsed job detail.
 */
export function buildGiorgioArmaniLocalizedContent(detail = {}, companyName = '') {
  const sourceTitle = String(detail.title || '').trim();
  const location = String(detail.location || '').trim();
  const slug = slugify(`${sourceTitle} ${companyName} ${location}`.trim());
  return {
    titleByLocale: { it: sourceTitle },
    descriptionByLocale: { it: detail.description || '' },
    slugByLocale: { it: slug },
  };
}
