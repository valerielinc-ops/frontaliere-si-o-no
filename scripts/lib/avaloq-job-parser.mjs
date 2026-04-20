import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function htmlToMarkdown(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|h2|h3|h4)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, '\'')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function textWindow(source = '', startLabel = '', endLabels = []) {
  const text = String(source || '');
  const start = text.indexOf(startLabel);
  if (start === -1) return '';
  const afterStart = text.slice(start + startLabel.length);
  let end = afterStart.length;
  for (const label of endLabels) {
    const idx = afterStart.indexOf(label);
    if (idx !== -1 && idx < end) end = idx;
  }
  return normalizeSpace(afterStart.slice(0, end));
}

export function parseAvaloqListingLinks(html = '') {
  // Strategy 1: traditional <a href="/careers/job-openings/ID"> links
  const hrefLinks = [...html.matchAll(/href="(\/(?:de\/)?careers\/job-openings\/[^"]+)"/g)]
    .map((match) => `https://www.avaloq.com${String(match[1] || '').trim()}`)
    .filter((url) => /\/careers\/job-openings\/\d{6,}/.test(url));
  if (hrefLinks.length > 0) return hrefLinks;

  // Strategy 2: SmartRecruiters posting IDs embedded in page (escaped JSON)
  const srIds = [...new Set(
    [...html.matchAll(/smartrecruiters\.com\\?\/v1\\?\/companies\\?\/Avaloq1\\?\/postings\\?\/(7\d{14,17})/g)]
      .map((m) => m[1])
  )];
  if (srIds.length > 0) {
    return srIds.map((id) => `https://www.avaloq.com/careers/job-openings/${id}`);
  }

  return [];
}

const SR_API = 'https://api.smartrecruiters.com/v1/companies/Avaloq1/postings';

async function srFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`SmartRecruiters API HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all Avaloq job postings from the SmartRecruiters public API.
 * Step 1: Fetch listing (lightweight, no descriptions).
 * Step 2: For target jobs, fetch individual postings for full descriptions.
 * @param {Function} locationFilter - Filter function for target locations.
 */
export async function fetchAvaloqJobsFromApi(timeoutMs = 20000, locationFilter = () => true) {
  // Step 1: Fetch all postings (listing only — no jobAd content)
  const all = [];
  let offset = 0;
  while (true) {
    const data = await srFetch(`${SR_API}?limit=100&offset=${offset}`, timeoutMs);
    all.push(...(data.content || []));
    if (all.length >= (data.totalFound || 0)) break;
    offset += 100;
  }

  // Step 2: Filter to target locations before fetching descriptions
  const targetPostings = all.filter((p) => {
    const city = normalizeSpace((p.location || {}).city || '');
    return locationFilter(city);
  });

  // Step 3: Fetch individual postings for full descriptions (concurrently, max 5)
  const details = [];
  const queue = [...targetPostings];
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length > 0) {
      const posting = queue.shift();
      try {
        const full = await srFetch(`${SR_API}/${posting.id}`, timeoutMs);
        details.push(buildDetailFromPosting(full));
      } catch (err) {
        // Fallback to listing data if individual fetch fails
        details.push(buildDetailFromPosting(posting));
      }
    }
  });
  await Promise.all(workers);
  return details;
}

function buildDetailFromPosting(posting) {
  const loc = posting.location || {};
  const city = normalizeSpace(loc.city || '');
  const sections = [];
  const jobDesc = (posting.jobAd?.sections?.jobDescription?.text || '').trim();
  const qualif = (posting.jobAd?.sections?.qualifications?.text || '').trim();
  const addInfo = (posting.jobAd?.sections?.additionalInformation?.text || '').trim();
  if (jobDesc) sections.push(htmlToMarkdown(jobDesc));
  if (qualif) sections.push(`## Qualifiche\n\n${htmlToMarkdown(qualif)}`);
  if (addInfo) sections.push(`## Informazioni aggiuntive\n\n${htmlToMarkdown(addInfo)}`);
  const description = sections.join('\n\n').trim() || normalizeSpace(posting.name || '');
  return {
    title: normalizeSpace(posting.name || ''),
    description,
    canonicalUrl: `https://www.avaloq.com/careers/job-openings/${posting.id}`,
    applyUrl: posting.applyUrl || `https://jobs.smartrecruiters.com/Avaloq1/${posting.id}`,
    location: city,
    postalCode: normalizeSpace(loc.postalCode || ''),
    workArrangement: posting.typeOfEmployment?.label || '',
    releasedDate: posting.releasedDate || '',
  };
}

export function parseAvaloqJobDetail(html = '', url = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const title =
    normalizeSpace(document.querySelector('h1')?.textContent || '') ||
    normalizeSpace(document.querySelector('title')?.textContent || '');

  const text = document.body.textContent.replace(/\s+/g, ' ');
  const locationBlock = textWindow(text, 'Location', ['Work arrangement', 'Apply']);
  const workArrangement = textWindow(text, 'Work arrangement', ['Apply']);
  const role = textWindow(text, 'A bit about the role', ['Your key tasks', 'A bit about you', 'Additional information']);
  const tasks = textWindow(text, 'Your key tasks', ['A bit about you', 'Additional information']);
  const profile = textWindow(text, 'A bit about you', ['It would be a real bonus if you have', 'Additional information']);
  const bonus = textWindow(text, 'It would be a real bonus if you have', ['Additional information']);
  const extra = textWindow(text, 'Additional information', ['Apply', 'See jobs']);

  const locationLines = locationBlock
    .split(/\s{2,}|(?<=Switzerland)\s+/)
    .map((line) => normalizeSpace(line))
    .filter(Boolean);
  const joinedLocation = normalizeSpace(locationLines.join(', '));
  const cityMatch = joinedLocation.match(/\b(\d{4})\s+([A-Za-zÀ-ÿ' -]+),?\s*Switzerland\b/i)
    || joinedLocation.match(/\b([A-Za-zÀ-ÿ' -]+),?\s*Switzerland\b/i);
  const city = normalizeSpace(cityMatch?.[2] || cityMatch?.[1] || '');
  const postalCode = normalizeSpace(joinedLocation.match(/\b(\d{4})\b/)?.[1] || '');
  const applyUrl =
    document.querySelector('a[href*="jobs.smartrecruiters.com"]')?.href
    || '';

  const sections = [];
  if (role) sections.push(`## Il ruolo\n\n${role}`);
  if (tasks) sections.push(`## Le tue responsabilita\n\n${tasks}`);
  if (profile) sections.push(`## Il tuo profilo\n\n${profile}`);
  if (bonus) sections.push(`## Plus graditi\n\n${bonus}`);
  if (extra) sections.push(`## Informazioni aggiuntive\n\n${extra}`);

  return {
    title,
    canonicalUrl: url || document.querySelector('link[rel="canonical"]')?.href || '',
    applyUrl,
    location: city,
    postalCode,
    workArrangement,
    description: sections.join('\n\n').trim(),
  };
}

export function isAvaloqTargetLocation(raw = '') {
  return isTargetSwissLocation(raw, { includeGrigioni: true });
}

export function inferAvaloqCanton(raw = '') {
  return inferAnyCanton(raw) || 'TI';
}

export function buildAvaloqLocalizedContent(detail = {}, companyName = 'Avaloq') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Bioggio';
  const description = String(detail.description || '').trim();
  return {
    titleByLocale: { it: title },
    descriptionByLocale: { it: description },
    slugByLocale: { it: slugify(`${title} ${companyName} ${location}`) },
  };
}
