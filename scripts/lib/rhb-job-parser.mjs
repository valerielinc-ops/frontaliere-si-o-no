import { JSDOM } from 'jsdom';

function normalizeSpace(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tryUrl(value = '', baseUrl = '') {
  try {
    return new URL(String(value || '').trim(), baseUrl).href;
  } catch {
    return '';
  }
}

function stripTitleSuffix(value = '') {
  return normalizeSpace(String(value || '').replace(/\s*\|\s*Rhätische Bahn\s*$/i, ''));
}

function parseGermanDate(value = '') {
  const match = normalizeSpace(value).match(/(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/);
  if (!match) return '';
  const months = new Map([
    ['januar', '01'],
    ['februar', '02'],
    ['märz', '03'],
    ['maerz', '03'],
    ['april', '04'],
    ['mai', '05'],
    ['juni', '06'],
    ['juli', '07'],
    ['august', '08'],
    ['september', '09'],
    ['oktober', '10'],
    ['november', '11'],
    ['dezember', '12'],
  ]);
  const day = match[1].padStart(2, '0');
  const month = months.get(match[2].toLowerCase()) || '';
  if (!month) return '';
  return `${match[3]}-${month}-${day}`;
}

function decodeEscapedJsonString(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return JSON.parse(`"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  } catch {
    return raw
      .replace(/\\u003c/gi, '<')
      .replace(/\\u003e/gi, '>')
      .replace(/\\u0026/gi, '&')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"');
  }
}

function htmlFragmentToText(html = '') {
  const fragment = decodeEscapedJsonString(html);
  if (!fragment) return '';
  const dom = new JSDOM(`<body>${fragment}</body>`);
  const lines = [];
  for (const element of Array.from(dom.window.document.body.children)) {
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(element.querySelectorAll('li'))
        .map((li) => normalizeSpace(li.textContent || ''))
        .filter(Boolean);
      for (const item of items) lines.push(`- ${item}`);
      continue;
    }
    const text = normalizeSpace(element.textContent || '');
    if (text) lines.push(text);
  }
  return lines.join('\n').trim();
}

function extractEmbeddedField(html = '', key = '') {
  const s = String(html);
  // Try escaped quotes first (\"key\":\"val\") from Next.js __next_f payloads
  const escaped = s.match(new RegExp(`\\\\"${key}\\\\"\\s*:\\s*\\\\"([\\s\\S]*?)\\\\"(?:,|})`, 'i'));
  if (escaped?.[1]) {
    // Content has an extra level of JSON encoding (\\u003c should become <).
    // Reduce one escape level, then JSON.parse to decode \uXXXX sequences.
    const unescaped = escaped[1].replace(/\\\\/g, '\\');
    try {
      return JSON.parse(`"${unescaped.replace(/"/g, '\\"')}"`);
    } catch {
      return decodeEscapedJsonString(unescaped);
    }
  }
  // Fall back to plain quotes ("key":"val")
  const plain = s.match(new RegExp(`"${key}":"([\\s\\S]*?)"(?:,|})`, 'i'));
  return decodeEscapedJsonString(plain?.[1] || '');
}

function extractJsonLdJob(html = '') {
  const matches = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.['@type'] === 'JobPosting') return parsed;
    } catch {
      // ignore malformed blocks
    }
  }
  return null;
}

function uniqueLines(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const line = normalizeSpace(value);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function parseRhbListingPage(html = '', baseUrl = '') {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  return Array.from(doc.querySelectorAll('article'))
    .map((article) => {
      const link = article.querySelector('h3 a');
      const paragraphs = Array.from(article.querySelectorAll('p'))
        .map((p) => normalizeSpace(p.textContent || ''))
        .filter(Boolean);
      return {
        detailUrl: tryUrl(link?.getAttribute('href') || '', baseUrl),
        title: normalizeSpace(link?.textContent || ''),
        summary: paragraphs[0] || '',
        location: paragraphs[1] || '',
        postedDate: parseGermanDate(paragraphs[2] || ''),
      };
    })
    .filter((item) => item.detailUrl && item.title);
}

export function parseRhbJobDetail(html = '', detailUrl = '') {
  const jsonLd = extractJsonLdJob(html) || {};
  const title = stripTitleSuffix(jsonLd?.title || '');
  const intro = extractEmbeddedField(html, 'intro');
  const tasksText = htmlFragmentToText(extractEmbeddedField(html, 'tasks'));
  const qualificationsText = htmlFragmentToText(extractEmbeddedField(html, 'qualifications'));
  const offerText = htmlFragmentToText(extractEmbeddedField(html, 'offer'));
  const additionalText = htmlFragmentToText(extractEmbeddedField(html, 'additional'));
  const location = normalizeSpace(extractEmbeddedField(html, 'department') || jsonLd?.jobLocation?.address?.addressLocality || jsonLd?.jobLocation?.address?.addressRegion || '');
  const contract = normalizeSpace(extractEmbeddedField(html, 'period') || jsonLd?.employmentType || '');
  const applyUrl = tryUrl(extractEmbeddedField(html, 'url'), detailUrl);
  const postedDate = normalizeSpace(String(jsonLd?.datePosted || '')).slice(0, 10);
  const requirements = uniqueLines(
    qualificationsText
      .split('\n')
      .map((line) => line.replace(/^- /, '').trim())
      .filter(Boolean)
  );

  const parts = [];
  if (title) parts.push(`# ${title}`);
  if (intro) parts.push(intro);
  if (tasksText) parts.push(`## Aufgaben\n${tasksText}`);
  if (qualificationsText) parts.push(`## Anforderungen\n${qualificationsText}`);
  if (offerText) parts.push(`## Angebot\n${offerText}`);
  if (additionalText) parts.push(`## Zusatzinfos\n${additionalText}`);

  return {
    title,
    location,
    contract,
    applyUrl,
    postedDate,
    description: parts.join('\n\n').trim(),
    requirements,
  };
}
