/**
 * Shared reader for JobCloud Company Page detail pages
 * (company.jobcloud.ch/{lang}/jobs/...).
 *
 * Two server-rendered templates exist and both must stay readable:
 *   - current (Next.js): body in `<div class="job-description ...">`, key info
 *     as `<dt>label</dt><dd>value</dd>`, apply link is a plain `<a>` to the
 *     jobs.ch / jobup.ch `/application/create/` form with no stable id.
 *   - legacy (Webflow): `w-richtext` body, `<div>label</div><div
 *     class="text-size-small">value</div>` rows, apply link `id="job-ad-apply-btn"`.
 * The current template is tried first, then the legacy one. There is no
 * generic "first block of text" fallback: an unrecognised page yields an empty
 * body so the source-body floor keeps withholding it.
 */
import { decodeEntities, htmlToText, normalizeSpace } from './hospital-custom-html-helpers.mjs';

const TAG_RE = /<\/?div\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const OPEN_DIV_RE = /<div\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const APPLY_HOSTS = new Set(['jobs.ch', 'www.jobs.ch', 'jobup.ch', 'www.jobup.ch']);

function decodeText(value = '') {
  return decodeEntities(String(value || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec))));
}

function classTokens(tag = '') {
  const match = tag.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return (match?.[1] ?? match?.[2] ?? '').split(/\s+/).filter(Boolean);
}

/** Inner HTML of the div opened at `openIdx`, read with balanced div depth. */
function readBalancedDivInner(html, openIdx) {
  TAG_RE.lastIndex = openIdx;
  let depth = 0;
  let innerStart = -1;
  let match;
  while ((match = TAG_RE.exec(html)) !== null) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(innerStart, match.index);
    } else {
      if (depth === 0) innerStart = match.index + match[0].length;
      depth += 1;
    }
  }
  return '';
}

function extractLegacyRichTextBlock(html = '') {
  const startMatch = html.match(/class\s*=\s*(["'])[^"']*\b(?:text-rich-text[^"']*\bw-richtext|w-richtext[^"']*\btext-rich-text)[^"']*\1[^>]*>/i);
  if (!startMatch) return '';
  const contentStart = startMatch.index + startMatch[0].length;
  const endMatch = html.slice(contentStart).match(/<[^>]*\bjob_details_content-right\b[^>]*>/i);
  return html.slice(contentStart, endMatch ? contentStart + endMatch.index : undefined);
}

/** Raw (still-HTML) job body, or '' when neither known template matches. */
export function extractJobCloudDescriptionHtml(rawHtml = '') {
  const html = String(rawHtml || '');
  OPEN_DIV_RE.lastIndex = 0;
  let match;
  while ((match = OPEN_DIV_RE.exec(html)) !== null) {
    if (!classTokens(match[0]).includes('job-description')) continue;
    const inner = readBalancedDivInner(html, match.index);
    if (inner) return inner;
  }
  return extractLegacyRichTextBlock(html);
}

/** Text value of a key-info row; `labelPattern` is a regex source (no colon). */
export function extractJobCloudKeyInfo(rawHtml = '', labelPattern = '') {
  const html = String(rawHtml || '');
  const dtRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  const labelRe = new RegExp(`^(?:${labelPattern}):?$`, 'i');
  let match;
  while ((match = dtRe.exec(html)) !== null) {
    if (labelRe.test(normalizeSpace(htmlToText(decodeText(match[1]))))) {
      return normalizeSpace(htmlToText(match[2]));
    }
  }
  const legacy = html.match(new RegExp(
    `<div[^>]*>\\s*(?:${labelPattern}):?\\s*</div>\\s*<div[^>]*class=["'][^"']*\\btext-size-small\\b[^"']*["'][^>]*>([\\s\\S]*?)</div>`,
    'i',
  ));
  return legacy ? normalizeSpace(htmlToText(legacy[1])) : '';
}

function resolveHref(tag, baseUrl) {
  const href = tag.match(/\bhref\s*=\s*(["'])([^"']+)\1/i);
  if (!href) return null;
  try {
    return new URL(decodeText(href[2]).replace(/&amp;/g, '&'), baseUrl);
  } catch {
    return null;
  }
}

/** Application link: jobs.ch/jobup.ch application form, or the legacy id'd button. */
export function extractJobCloudApplyUrl(rawHtml = '', baseUrl = 'https://company.jobcloud.ch/') {
  const tags = String(rawHtml || '').match(/<a\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi) || [];
  for (const tag of tags) {
    const url = resolveHref(tag, baseUrl);
    if (url && APPLY_HOSTS.has(url.hostname.toLowerCase()) && /\/application\/create\//i.test(url.pathname)) {
      return url.toString();
    }
  }
  for (const tag of tags) {
    if (!/\bid\s*=\s*(["'])job-ad-apply-btn\1/i.test(tag)) continue;
    const url = resolveHref(tag, baseUrl);
    if (url) return url.toString();
  }
  return '';
}

const MONTHS = new Map([
  ['janvier', 1], ['januar', 1], ['january', 1], ['jan', 1],
  ['fevrier', 2], ['februar', 2], ['february', 2], ['feb', 2],
  ['mars', 3], ['marz', 3], ['maerz', 3], ['march', 3], ['mar', 3],
  ['avril', 4], ['april', 4], ['apr', 4],
  ['mai', 5], ['may', 5],
  ['juin', 6], ['juni', 6], ['june', 6], ['jun', 6],
  ['juillet', 7], ['juli', 7], ['july', 7], ['jul', 7],
  ['aout', 8], ['august', 8], ['aug', 8],
  ['septembre', 9], ['september', 9], ['sep', 9], ['sept', 9],
  ['octobre', 10], ['oktober', 10], ['october', 10], ['oct', 10],
  ['novembre', 11], ['november', 11], ['nov', 11],
  ['decembre', 12], ['dezember', 12], ['december', 12], ['dec', 12],
]);

/** ISO date from `d.m.yyyy`, `25 novembre 2026` or `25. September 2026`; '' otherwise. */
export function parseJobCloudDate(raw = '') {
  const value = normalizeSpace(decodeText(raw));
  const numeric = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const named = value.match(/^(\d{1,2})\.?\s*([\p{L}.]+)\s+(\d{4})$/u);
  let day; let month; let year;
  if (numeric) [, day, month, year] = numeric;
  else if (named) {
    day = named[1]; year = named[3];
    month = MONTHS.get(named[2].replace(/\.$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());
  }
  if (!month) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
