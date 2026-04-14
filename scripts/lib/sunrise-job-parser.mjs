import { JSDOM } from 'jsdom';

const TICINO_OR_GRIGIONI_TOKENS = [
  'ticino',
  'grigioni',
  'grisons',
  'graubunden',
  'graubuenden',
  'manno',
  'lugano',
  'locarno',
  'bellinzona',
  'mendrisio',
  'chiasso',
  'ascona',
  'bioggio',
  'stabio',
  'agno',
  'landquart',
  'chur',
];

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
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function stripTags(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractSunriseDdo(html = '') {
  const source = String(html || '');
  const match = source.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\})\s*;\s*phApp\.experimentData/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function isSunriseTargetLocation(job = {}) {
  const haystack = normalize([
    job?.state,
    job?.city,
    job?.cityState,
    job?.cityStateCountry,
    job?.address,
    job?.location,
  ].filter(Boolean).join(' '));
  return TICINO_OR_GRIGIONI_TOKENS.some((token) => haystack.includes(token));
}

export function inferSunriseCanton(job = {}) {
  const haystack = normalize([
    job?.standardisedStateCode,
    job?.standardisedState,
    job?.state,
    job?.cityState,
    job?.cityStateCountry,
    job?.address,
    job?.city,
  ].filter(Boolean).join(' '));
  if (haystack.includes('grigioni') || haystack.includes('grisons') || haystack.includes('graub')) return 'GR';
  return '';
}

export function parseSunriseSearchPage(html = '') {
  const ddo = extractSunriseDdo(html);
  const jobs = ddo?.eagerLoadRefineSearch?.data?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((job) => ({
    reqId: String(job.reqId || job.jobId || '').trim(),
    jobId: String(job.jobId || job.reqId || '').trim(),
    title: normalizeSpace(job.title || ''),
    city: normalizeSpace(job.city || ''),
    state: normalizeSpace(job.state || ''),
    cityState: normalizeSpace(job.cityState || ''),
    cityStateCountry: normalizeSpace(job.cityStateCountry || ''),
    address: normalizeSpace(job.address || ''),
    category: Array.isArray(job.multi_category) ? normalizeSpace(job.multi_category[0] || '') : normalizeSpace(job.category || ''),
    postedDate: String(job.postedDate || '').trim(),
    description: String(job.description || '').trim(),
    applyUrl: String(job.applyUrl || '').trim(),
    jobSeqNo: String(job.jobSeqNo || '').trim(),
    standardisedStateCode: String(job.standardisedStateCode || '').trim(),
  })).filter((job) => job.reqId && job.title);
}

export function buildSunriseDetailUrl(job = {}) {
  const reqId = String(job.reqId || job.jobId || '').trim();
  const title = String(job.title || '').trim();
  if (!reqId || !title) return '';
  return `https://careers.sunrise.ch/it/it/job/${encodeURIComponent(reqId)}/${encodeURIComponent(slugify(title))}`;
}

function parseJsonLdJobPosting(document) {
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const jobPosting = items.find((item) => {
        const type = item?.['@type'];
        return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      });
      if (jobPosting) return jobPosting;
    } catch {
      // ignore malformed blocks
    }
  }
  return null;
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
    const text = normalizeSpace(stripTags(node.outerHTML || ''));
    if (text) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

export function parseSunriseJobDetail(html = '') {
  const ddo = extractSunriseDdo(html);
  const rawJob = ddo?.jobDetail?.data?.job || null;
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const jsonLd = parseJsonLdJobPosting(document);

  const title = normalizeSpace(rawJob?.title || jsonLd?.title || document.querySelector('title')?.textContent || '');
  const cityState = normalizeSpace(rawJob?.cityState || '');
  const cityStateCountry = normalizeSpace(rawJob?.cityStateCountry || '');
  const location = normalizeSpace(rawJob?.location || jsonLd?.jobLocation?.address?.addressLocality || '');
  const descriptionHtml = String(rawJob?.description || jsonLd?.description || '').trim();
  const description = htmlFragmentToMarkdown(descriptionHtml);

  return {
    reqId: String(rawJob?.reqId || rawJob?.jobId || jsonLd?.identifier?.value || '').trim(),
    jobSeqNo: String(rawJob?.jobSeqNo || '').trim(),
    title,
    location,
    cityState,
    cityStateCountry,
    state: normalizeSpace(rawJob?.state || rawJob?.standardisedState || jsonLd?.jobLocation?.address?.addressRegion || ''),
    standardisedStateCode: String(rawJob?.standardisedStateCode || '').trim(),
    address: normalizeSpace(rawJob?.address || ''),
    postalCode: String(jsonLd?.jobLocation?.address?.postalCode || '').trim(),
    category: normalizeSpace(
      (Array.isArray(rawJob?.multi_category) && rawJob.multi_category[0]) ||
      rawJob?.category ||
      ''
    ),
    postedDate: String(rawJob?.postedDate || jsonLd?.datePosted || '').trim(),
    validThrough: String(rawJob?.endDate || jsonLd?.validThrough || '').trim(),
    employmentType: String(rawJob?.jobType || jsonLd?.employmentType || '').trim(),
    applyUrl: String(rawJob?.applyUrl || '').trim(),
    sourceLangHint: normalizeSpace(rawJob?.locale || ''),
    description,
    descriptionHtml,
  };
}

export function inferSunriseCategory(detail = {}) {
  const haystack = normalize([
    detail?.category,
    detail?.title,
    detail?.description,
  ].filter(Boolean).join(' '));
  if (haystack.includes('apprend')) return 'apprenticeship';
  if (haystack.includes('customer success') || haystack.includes('account manager') || haystack.includes('sales')) return 'sales';
  if (haystack.includes('data') || haystack.includes('analytics')) return 'data';
  if (haystack.includes('tech')) return 'tech';
  return 'other';
}

export function buildSunriseLocalizedContent(detail = {}) {
  const title = String(detail.title || '').trim();
  const locationLabel = String(detail.cityState || detail.location || '').trim();
  return {
    titleByLocale: {
      it: title,
      en: title,
      de: title,
      fr: title,
    },
    slugByLocale: {
      it: slugify(`${title} Sunrise ${locationLabel}`),
      en: slugify(`${title} Sunrise ${locationLabel}`),
      de: slugify(`${title} Sunrise ${locationLabel}`),
      fr: slugify(`${title} Sunrise ${locationLabel}`),
    },
    descriptionByLocale: {
      [normalize(detail.sourceLangHint || '').startsWith('it') ? 'it' : 'en']: detail.description || '',
    },
  };
}
