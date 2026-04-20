import { JSDOM } from 'jsdom';

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

function stripHtmlTags(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|ul|ol|section|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlFragmentToMarkdown(html = '') {
  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;
  const parts = [];

  for (const node of [...body.children]) {
    const tag = node.tagName?.toLowerCase() || '';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(`## ${text}`);
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = [...node.querySelectorAll('li')]
        .map((li) => normalizeSpace(li.textContent || ''))
        .filter(Boolean)
        .map((text) => `- ${text}`);
      if (items.length) parts.push(items.join('\n'));
      continue;
    }
    const text = normalizeSpace(
      (node.innerHTML || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
    );
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

function extractJobPostingJsonLd(html = '') {
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'JobPosting') return item;
      }
    } catch {
      // malformed — skip
    }
  }
  return null;
}

/**
 * Extract the LinkedIn job numeric ID from a URL or data-entity-urn string.
 *
 * Handles:
 *   - https://www.linkedin.com/jobs/view/4366703746/
 *   - urn:li:jobPosting:4366703746
 *   - "4366703746"
 */
export function extractLinkedInJobId(raw = '') {
  const urlMatch = String(raw).match(/\/jobs\/view\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  const urnMatch = String(raw).match(/urn:li:jobPosting:(\d+)/);
  if (urnMatch) return urnMatch[1];
  if (/^\d+$/.test(String(raw).trim())) return String(raw).trim();
  return null;
}

/**
 * Canonical LinkedIn public job detail URL from a job ID.
 */
export function linkedInJobUrl(jobId = '') {
  return `https://www.linkedin.com/jobs/view/${jobId}/`;
}

/**
 * Parse LinkedIn guest listing cards.
 *
 * Works on:
 *   - The JSON/HTML response from /jobs-guest/jobs/api/seeMoreJobPostings/search
 *   - The public search page HTML at /jobs/search/
 *
 * Both use the same `.base-card` / `li[data-entity-urn]` card structure.
 */
export function parseDotLifeLinkedInCards(html = '') {
  const document = new JSDOM(html).window.document;

  // Cards appear as list items or divs with data-entity-urn
  const cardEls = [
    ...document.querySelectorAll('li[data-entity-urn], div.base-card[data-entity-urn]'),
  ];

  // Also pick up cards that are children of li elements
  const listCards = [...document.querySelectorAll('li .base-card')];
  const allCards = cardEls.length > 0 ? cardEls : listCards;

  const results = [];

  for (const el of allCards) {
    const urn =
      el.getAttribute('data-entity-urn') ||
      el.querySelector('[data-entity-urn]')?.getAttribute('data-entity-urn') ||
      '';

    const linkHref =
      el.querySelector('a[href*="/jobs/view/"]')?.getAttribute('href') ||
      el.querySelector('a.base-card__full-link')?.getAttribute('href') ||
      '';

    const jobId = extractLinkedInJobId(urn) || extractLinkedInJobId(linkHref);
    if (!jobId) continue;

    const title = normalizeSpace(
      el.querySelector('.base-search-card__title')?.textContent || '',
    );
    const company = normalizeSpace(
      el.querySelector('.base-search-card__subtitle a, .hidden-nested-link')?.textContent ||
      el.querySelector('.base-search-card__subtitle')?.textContent ||
      '',
    );
    const location = normalizeSpace(
      el.querySelector('.job-search-card__location')?.textContent || '',
    );
    const postedDate =
      el.querySelector('time[datetime]')?.getAttribute('datetime') || '';

    if (!title) continue;

    results.push({
      jobId,
      href: linkedInJobUrl(jobId),
      title,
      company,
      location,
      postedDate,
    });
  }

  // Deduplicate by jobId
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.jobId)) return false;
    seen.add(r.jobId);
    return true;
  });
}

/**
 * Parse a LinkedIn guest job detail page or fragment.
 *
 * Accepts both:
 *   - Full page: https://www.linkedin.com/jobs/view/{id}/
 *   - Fragment endpoint: https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}
 *
 * Prefers JSON-LD when present; falls back to HTML selector extraction.
 */
export function parseDotLifeLinkedInDetail(html = '', pageUrl = '') {
  // Try JSON-LD first (present on full pages, sometimes on fragments)
  const jsonLd = extractJobPostingJsonLd(html);
  if (jsonLd?.title) {
    const addressLocality =
      jsonLd.jobLocation?.address?.addressLocality ||
      jsonLd.jobLocation?.address?.addressRegion ||
      '';
    const description = typeof jsonLd.description === 'string'
      ? stripHtmlTags(jsonLd.description)
      : '';
    return {
      title: normalizeSpace(jsonLd.title),
      company: normalizeSpace(jsonLd.hiringOrganization?.name || ''),
      location: normalizeSpace(addressLocality),
      description,
      employmentType: jsonLd.employmentType || '',
      seniority: '',
      jobFunction: '',
      industry: jsonLd.industry || '',
      postedDate: jsonLd.datePosted || '',
      shareUrl: jsonLd.url || pageUrl,
    };
  }

  // HTML fallback — covers both full pages and API fragment pages
  const document = new JSDOM(html).window.document;

  const title = normalizeSpace(
    document.querySelector('.top-card-layout__title')?.textContent ||
    document.querySelector('h1')?.textContent ||
    '',
  );
  const company = normalizeSpace(
    document.querySelector('.topcard__org-name-link')?.textContent ||
    document.querySelector('.top-card-layout__card .top-card-layout__second-subline a')?.textContent ||
    document.querySelector('.top-card-layout__second-subline')?.textContent ||
    '',
  );
  const location = normalizeSpace(
    document.querySelector('.topcard__flavor--bullet')?.textContent ||
    document.querySelector('.top-card-layout__first-subline .top-card-layout__bullet')?.textContent ||
    '',
  );

  // Description container — LinkedIn uses various wrappers
  const descEl =
    document.querySelector('.show-more-less-html__markup') ||
    document.querySelector('.description__text section') ||
    document.querySelector('[data-test="job-description"]');
  const description = descEl ? htmlFragmentToMarkdown(descEl.innerHTML || '') : '';

  // Job criteria (seniority, employment type, job function, industry)
  const criteriaMap = {};
  for (const item of document.querySelectorAll('.description__job-criteria-item')) {
    const label = normalizeSpace(item.querySelector('h3')?.textContent || '').toLowerCase();
    const value = normalizeSpace(item.querySelector('span')?.textContent || '');
    if (label && value) criteriaMap[label] = value;
  }

  const employmentType =
    criteriaMap['employment type'] ||
    criteriaMap['tipo di contratto'] ||
    criteriaMap['emploi'] ||
    '';
  const seniority =
    criteriaMap['seniority level'] ||
    criteriaMap['livello di esperienza'] ||
    '';
  const jobFunction =
    criteriaMap['job function'] ||
    criteriaMap['funzione professionale'] ||
    '';
  const industry =
    criteriaMap['industries'] ||
    criteriaMap['settore'] ||
    '';

  const postedDate =
    document.querySelector('time[datetime]')?.getAttribute('datetime') || '';

  return {
    title,
    company,
    location,
    description,
    employmentType,
    seniority,
    jobFunction,
    industry,
    postedDate,
    shareUrl: pageUrl,
  };
}

/**
 * Build stub localised content for a DOT Life / LinkedIn job.
 * The AI translation pipeline will fill in remaining locales.
 */
export function buildDotLifeLocalizedContent(detail = {}) {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || 'Paradiso').trim();
  const slug = slugify(`${title} dot-life-sa ${location}`);
  return {
    titleByLocale: { it: title },
    descriptionByLocale: { it: detail.description || '' },
    slugByLocale: { it: slug, en: slug },
  };
}
