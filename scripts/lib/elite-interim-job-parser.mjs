#!/usr/bin/env node
/**
 * Elite Interim SA — official WordPress source, scoped to electricians in NE.
 *
 * Public listing: https://eliteinterim.ch/toutes-nos-offres-demplois/
 * Official details: https://eliteinterim.ch/wp-json/wp/v2/posts
 *
 * The REST response contains the same authored detail body, canonical URL and
 * publication timestamp rendered by each public detail page. The crawler is
 * deliberately narrow: only electrical roles whose detail says the workplace
 * is exclusively Canton de Neuchatel enter this slice. Branch addresses and
 * multi-canton Arc jurassien roles are never used as a location fallback.
 */
import { sourcePostingDateCandidatesFields } from './source-posting-date.mjs';
import { RETRYABLE_STATUS, fetchWithRetry, slugify, stripHtml } from './crawler-template.mjs';
import { decodeEntities } from './hospital-custom-html-helpers.mjs';

export const ELITE_INTERIM_KEY = 'elite-interim';
export const ELITE_INTERIM_COMPANY_NAME = 'Elite Interim SA';
export const ELITE_INTERIM_COMPANY_DOMAIN = 'eliteinterim.ch';

const PUBLIC_LISTING_URL = 'https://eliteinterim.ch/toutes-nos-offres-demplois/';
const WP_POSTS_URL = 'https://eliteinterim.ch/wp-json/wp/v2/posts';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const SOURCE_LANG = 'fr';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fold(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && (url.hostname === ELITE_INTERIM_COMPANY_DOMAIN
        || url.hostname.endsWith(`.${ELITE_INTERIM_COMPANY_DOMAIN}`));
  } catch {
    return false;
  }
}

export function isEliteInterimJob(job) {
  const key = fold(job?.companyKey || '');
  const company = fold(job?.company || '');
  return key === ELITE_INTERIM_KEY
    || company === fold(ELITE_INTERIM_COMPANY_NAME)
    || isTrustedDomain(job?.url || '');
}

export function eliteInterimDetailText(contentHtml = '') {
  const withLines = decodeEntities(String(contentHtml || ''))
    .replace(/\[\/?vc_[^\]]*\]/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|div|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ');

  return stripHtml(withLines)
    .split(/\n+/)
    .map(normalizeSpace)
    .filter(Boolean)
    .join('\n');
}

export function extractEliteInterimWorkplace(detailText = '') {
  const lines = String(detailText || '').split(/\n+/).map(normalizeSpace).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?:[-•]\s*)?(?:lieu|lieu de travail)\s*:\s*(.*)$/i.exec(lines[index]);
    if (!match) continue;
    return normalizeSpace(match[1] || lines[index + 1] || '');
  }
  return '';
}

export function isNeuchatelElectricianDetail(title = '', workplace = '') {
  const normalizedTitle = fold(title);
  const normalizedWorkplace = fold(workplace);
  const electricalRole = /\b(?:electricien|electricienne|securite electrique)\b/.test(normalizedTitle);
  const neuchatel = /\bneuchatel\b/.test(normalizedWorkplace);
  const otherCanton = /\b(?:arc jurassien|vaud|jura|bernois|berne|valais|fribourg|geneve|soleure)\b/.test(normalizedWorkplace);
  return electricalRole && neuchatel && !otherCanton;
}

function canonicalDetailUrl(rawUrl = '') {
  if (!isTrustedDomain(rawUrl)) return '';
  const url = new URL(rawUrl);
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function publicationFields(post) {
  const dateGmt = typeof post?.date_gmt === 'string' ? post.date_gmt.trim() : '';
  return sourcePostingDateCandidatesFields([
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dateGmt) ? `${dateGmt}Z` : dateGmt,
    post?.date,
  ]);
}

export function parseEliteInterimPost(post, now = new Date()) {
  const title = normalizeSpace(decodeEntities(stripHtml(post?.title?.rendered || '')));
  const description = eliteInterimDetailText(post?.content?.rendered || '');
  const workplace = extractEliteInterimWorkplace(description);
  const url = canonicalDetailUrl(post?.link || '');

  if (!title || !url || !isNeuchatelElectricianDetail(title, workplace)) return null;
  if (description.split(/\s+/).filter(Boolean).length < 50) return null;

  const postId = String(post?.id || '').trim();
  if (!/^\d+$/.test(postId)) return null;

  const jobSlug = slugify(`${title} elite interim neuchatel`);
  const publication = publicationFields(post, now);

  return {
    id: `${ELITE_INTERIM_KEY}-${postId}`,
    slug: jobSlug,
    slugByLocale: { [SOURCE_LANG]: jobSlug },
    company: ELITE_INTERIM_COMPANY_NAME,
    companyKey: ELITE_INTERIM_KEY,
    companyDomain: ELITE_INTERIM_COMPANY_DOMAIN,
    title,
    titleByLocale: { [SOURCE_LANG]: title },
    description,
    descriptionByLocale: { [SOURCE_LANG]: description },
    needsRetranslation: true,
    location: workplace,
    canton: 'NE',
    url,
    applyUrl: url,
    source: 'Elite Interim Dedicated Parser (official WordPress detail)',
    sourceLang: SOURCE_LANG,
    crawledAt: now.toISOString(),
    addressLocality: workplace,
    addressRegion: 'NE',
    addressCountry: 'CH',
    country: 'CH',
    postalCode: '',
    streetAddress: '',
    hiringOrganizationName: ELITE_INTERIM_COMPANY_NAME,
    category: 'Elettricista',
    sector: 'Edilizia / Impiantistica',
    contract: 'full-time',
    employmentType: 'FULL_TIME',
    experienceLevel: 'mid',
    currency: 'CHF',
    featured: false,
    requirements: [],
    requirementsByLocale: { [SOURCE_LANG]: [] },
    ...publication,
  };
}

function postsPageUrl(page) {
  const fields = 'id,slug,link,date,date_gmt,title,content';
  return `${WP_POSTS_URL}?per_page=${PAGE_SIZE}&page=${page}&_fields=${fields}`;
}

async function fetchPostsPage(page) {
  const url = postsPageUrl(page);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Referer: PUBLIC_LISTING_URL,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${url}`);
        error.status = response.status;
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      const batch = JSON.parse(await response.text());
      if (!Array.isArray(batch)) {
        throw new Error('Unexpected Elite Interim WordPress payload: expected an array');
      }
      const rawTotalPages = response.headers?.get?.('x-wp-totalpages');
      const declaredTotalPages = Number(rawTotalPages);
      return {
        batch,
        totalPages: Number.isInteger(declaredTotalPages) && declaredTotalPages > 0
          ? declaredTotalPages
          : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }, { label: `Elite Interim official WordPress posts page ${page}` });
}

export async function fetchAllEliteInterimJobs() {
  console.log(`Fetching ${ELITE_INTERIM_COMPANY_NAME} electrician jobs in NE`);
  console.log(`   Source: ${PUBLIC_LISTING_URL}\n`);

  const posts = [];
  let totalPages = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetchPostsPage(page);
    if (page === 1 && result.totalPages != null) {
      if (result.totalPages > MAX_PAGES) {
        throw new Error(`Elite Interim WordPress feed exceeded ${MAX_PAGES * PAGE_SIZE} posts`);
      }
      totalPages = result.totalPages;
    }
    posts.push(...result.batch);
    if ((totalPages != null && page >= totalPages) || result.batch.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) throw new Error(`Elite Interim WordPress feed exceeded ${MAX_PAGES * PAGE_SIZE} posts`);
  }

  const now = new Date();
  const jobs = posts.map((post) => parseEliteInterimPost(post, now)).filter(Boolean);
  console.log(`   Official posts: ${posts.length}; electrician:NE jobs: ${jobs.length}`);
  return jobs;
}
