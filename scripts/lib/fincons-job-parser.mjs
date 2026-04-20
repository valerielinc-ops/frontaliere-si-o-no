import { JSDOM } from 'jsdom';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '–');
}

function htmlToText(html = '') {
  return normalizeSpace(
    decodeEntities(
      String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\u00a0/g, ' ')
        .replace(/\n{3,}/g, '\n\n'),
    ),
  );
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

function bulletLines(listNode) {
  return [...(listNode?.querySelectorAll?.('li') || [])]
    .map((item) => normalizeSpace(item.textContent || ''))
    .filter(Boolean)
    .map((item) => `- ${item}`);
}

export function parseFinconsListingsPage(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  return [...document.querySelectorAll('#jobs_table tr[id^="row_job_"]')]
    .map((row) => {
      const link = row.querySelector('a.job_title_link');
      const href = String(link?.getAttribute('href') || '').trim();
      const title = normalizeSpace(link?.textContent || '');
      const department = normalizeSpace(row.querySelector('.resumator_department')?.textContent || '');
      const location = normalizeSpace(row.querySelector('td:last-child')?.textContent || '');
      return { href, title, department, location };
    })
    .filter((row) => row.href && row.title);
}

function parseJsonLd(document) {
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const payload = JSON.parse(node.textContent || '{}');
      if (payload && payload['@type'] === 'JobPosting') return payload;
    } catch {}
  }
  return null;
}

export function parseFinconsJobDetail(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const jsonLd = parseJsonLd(document);

  const canonicalUrl = String(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '').trim();
  const title = normalizeSpace(document.querySelector('.job_header .job_title')?.textContent || jsonLd?.title || '');
  const meta = normalizeSpace(document.querySelector('.job_header .job_meta')?.textContent || '');
  const company = normalizeSpace(document.querySelector('.job_header .job_company')?.textContent || jsonLd?.hiringOrganization?.name || 'Fincons Group');
  const descriptionRoot = document.querySelector('.job_description');

  const sections = [];
  if (descriptionRoot) {
    let currentHeading = '';
    let blocks = [];
    const flush = () => {
      if (!currentHeading && blocks.length === 0) return;
      const out = [];
      if (currentHeading) out.push(`## ${currentHeading}`);
      if (blocks.length) out.push(blocks.join('\n\n'));
      sections.push(out.join('\n\n').trim());
      currentHeading = '';
      blocks = [];
    };

    for (const node of [...descriptionRoot.children]) {
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'strong') {
        flush();
        currentHeading = normalizeSpace(node.textContent || '');
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        const bullets = bulletLines(node);
        if (bullets.length) blocks.push(bullets.join('\n'));
        continue;
      }
      const text = htmlToText(node.outerHTML || node.textContent || '');
      if (!text) continue;
      const headingLike = text.match(/^([^:\n]{3,80}):$/);
      if (headingLike) {
        flush();
        currentHeading = headingLike[1];
        continue;
      }
      blocks.push(text);
    }
    flush();
  }

  const description = sections.join('\n\n').trim() || htmlToText(jsonLd?.description || '');
  const applyUrl = canonicalUrl || String(jsonLd?.url || '').trim();
  const locationParts = meta.split('|').map((part) => normalizeSpace(part));
  const location = locationParts[1] || normalizeSpace([
    jsonLd?.jobLocation?.address?.addressLocality || '',
    jsonLd?.jobLocation?.address?.addressRegion || '',
    'Switzerland',
  ].filter(Boolean).join(', '));
  const employmentType = String(jsonLd?.employmentType || locationParts[2] || '').trim();
  const postalCode = String(jsonLd?.jobLocation?.address?.postalCode || '').trim();
  const region = normalizeSpace(jsonLd?.jobLocation?.address?.addressRegion || '');
  const datePosted = String(jsonLd?.datePosted || '').trim();
  const validThrough = String(jsonLd?.validThrough || '').trim();
  const experienceRequirements = normalizeSpace(jsonLd?.experienceRequirements || '');
  const uniqueJobCode = String(jsonLd?.uniqueJobCode || '').trim();

  return {
    title,
    company,
    canonicalUrl,
    applyUrl,
    location,
    region,
    postalCode,
    employmentType,
    datePosted,
    validThrough,
    experienceRequirements,
    uniqueJobCode,
    description,
  };
}

export function buildFinconsLocalizedContent(detail = {}) {
  const sourceTitle = String(detail.title || '').trim();
  const location = String(detail.location || 'Lugano').trim();
  const descriptions = {
    en: detail.description || '',
  };
  return {
    titleByLocale: {
      en: sourceTitle,
    },
    slugByLocale: {
      en: slugify(`${sourceTitle} Fincons Group ${location}`),
    },
    descriptionByLocale: descriptions,
  };
}
