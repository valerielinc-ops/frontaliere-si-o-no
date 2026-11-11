export const EXPIRED_JOB_EDGE_SCHEMA_VERSION = 1;
export const EXPIRED_JOB_EDGE_SHARD_COUNT = 128;
export const EXPIRED_JOB_EDGE_DATASET_PREFIX = '/edge/expired-jobs/v1';
export const EXPIRED_JOB_EDGE_BASE_URL = 'https://frontaliereticino.ch';

const EDGE_TEMPLATE_TOKENS = [
  '__FT_EDGE_TITLE__',
  '__FT_EDGE_SOCIAL_TITLE__',
  '__FT_EDGE_DESCRIPTION__',
  '__FT_EDGE_SOCIAL_DESCRIPTION__',
  '__FT_EDGE_CANONICAL_PATH__',
  '__FT_EDGE_HREFLANG__',
  '__FT_EDGE_JSONLD__',
  '__FT_EDGE_DATA__',
  '__FT_EDGE_BODY__',
  '__FT_EDGE_AD_SNIPPET__',
];

/** Normalize a page URL or pathname to the site's trailing-slash path form. */
export function normalizeExpiredJobEdgePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const pathname = new URL(raw, EXPIRED_JOB_EDGE_BASE_URL).pathname;
    if (!pathname || pathname === '/') return pathname;
    return `${pathname.replace(/\/+$/, '')}/`;
  } catch {
    return '';
  }
}

/** Stable FNV-1a bucket shared by the build publisher and the Worker. */
export function expiredJobEdgeShardId(value) {
  const pathname = normalizeExpiredJobEdgePath(value);
  if (!pathname || pathname === '/') return '';

  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(pathname)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % EXPIRED_JOB_EDGE_SHARD_COUNT).toString(16).padStart(2, '0');
}

/**
 * RC sections are a comma-separated, exact-match allowlist. An absent or
 * malformed value is off, which is the safe build and Worker default.
 */
export function parseExpiredJobEdgeSections(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return [...new Set(value.split(',').map((part) => part.trim().toLowerCase()).filter((part) => /^[a-z][a-z0-9-]*$/.test(part)))];
}

export function isExpiredJobEdgeManifestUsable(manifest, locale) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  if (manifest.version !== EXPIRED_JOB_EDGE_SCHEMA_VERSION || manifest.locale !== locale) return false;
  if (manifest.datasetPrefix !== EXPIRED_JOB_EDGE_DATASET_PREFIX) return false;
  if (typeof manifest.generation !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(manifest.generation)) return false;
  if (!Array.isArray(manifest.activeSections)
    || !manifest.activeSections.every((item) => typeof item === 'string' && /^[a-z][a-z0-9-]*$/.test(item))
    || new Set(manifest.activeSections).size !== manifest.activeSections.length) return false;
  if (!Array.isArray(manifest.shardIds)
    || !manifest.shardIds.every((item) => /^[0-9a-f]{2}$/.test(item))
    || new Set(manifest.shardIds).size !== manifest.shardIds.length) return false;
  if (!manifest.coverage || manifest.coverage.complete !== true) return false;
  if (!Number.isSafeInteger(manifest.shardCount) || manifest.shardCount !== EXPIRED_JOB_EDGE_SHARD_COUNT) return false;
  if (typeof manifest.template !== 'string' || !EDGE_TEMPLATE_TOKENS.every((token) => manifest.template.includes(token))) return false;
  if (typeof manifest.adSnippetHtml !== 'string') return false;
  return true;
}

export function isExpiredJobEdgeShardUsable(shard, { locale, generation, shardId } = {}) {
  if (!shard || typeof shard !== 'object' || Array.isArray(shard)) return false;
  if (shard.version !== EXPIRED_JOB_EDGE_SCHEMA_VERSION
    || shard.locale !== locale
    || shard.generation !== generation
    || shard.shardId !== shardId
    || shard.coverage?.complete !== true
    || !shard.pages
    || typeof shard.pages !== 'object'
    || Array.isArray(shard.pages)) return false;
  return true;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function internalUrl(value) {
  try {
    const url = new URL(String(value ?? ''), EXPIRED_JOB_EDGE_BASE_URL);
    if (url.origin !== EXPIRED_JOB_EDGE_BASE_URL || url.protocol !== 'https:') return '';
    const pathname = normalizeExpiredJobEdgePath(url.pathname);
    return pathname ? `${EXPIRED_JOB_EDGE_BASE_URL}${pathname}` : '';
  } catch {
    return '';
  }
}

function renderSimilarJobs(jobs, locale, heading, boardUrl) {
  const rows = Array.isArray(jobs) ? jobs.slice(0, 5).flatMap((job) => {
    const href = internalUrl(job?.href);
    const title = String(job?.title ?? '').trim();
    if (!href || !title) return [];
    const company = String(job?.employer ?? '').trim();
    const place = String(job?.place ?? '').trim();
    return [
      `<li><a href="${escapeHtml(href)}">${escapeHtml(title)}</a>`
      + `${company ? ` — ${escapeHtml(company)}` : ''}${place ? `, ${escapeHtml(place)}` : ''}</li>`,
    ];
  }).join('') : '';

  const activeLinks = rows
    ? `<section class="ft-expired-related"><h2>${escapeHtml(heading)}</h2><ul>${rows}</ul></section>`
    : '';
  const browseLink = `<p class="ft-expired-cta"><a href="${escapeHtml(boardUrl)}">${escapeHtml(locale === 'it'
    ? 'Vedi le offerte attive'
    : locale === 'de' ? 'Offene Stellen ansehen'
      : locale === 'fr' ? 'Voir les offres actives'
        : 'Browse active jobs')} →</a></p>`;
  return `${activeLinks}${browseLink}`;
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Render a build-provided shell with only the small per-page edge record. */
export function renderExpiredJobEdgeHtml(template, page, locale, adSnippetHtml = '') {
  if (typeof template !== 'string' || !page || typeof page !== 'object') return null;
  const title = String(page.title ?? '').trim();
  const pageTitle = String(page.pageTitle ?? title).trim();
  const socialTitle = String(page.socialTitle ?? pageTitle).trim();
  const canonicalPath = normalizeExpiredJobEdgePath(page.canonicalPath);
  const canonicalUrl = internalUrl(canonicalPath);
  if (!title || !pageTitle || !canonicalPath || !canonicalUrl || !['it', 'en', 'de', 'fr'].includes(locale)) return null;

  const description = String(page.metaDescription ?? page.description ?? '').trim();
  const socialDescription = String(page.socialDescription ?? description).trim();
  const boardUrl = internalUrl(page.boardUrl) || EXPIRED_JOB_EDGE_BASE_URL + '/cerca-lavoro-svizzera/';
  const employer = String(page.employer ?? '').trim();
  const expiredMessage = String(page.expiredMessage ?? '').trim();
  const similarHeading = String(page.similarHeading ?? '').trim();
  const body = '<div class="ft-expired-shell"><header class="ft-expired-intro">'
    + `<h1>${escapeHtml(title)}${employer ? ` — ${escapeHtml(employer)}` : ''}</h1>`
    + `${expiredMessage ? `<p class="ft-expired-status"><strong>${escapeHtml(expiredMessage)}</strong></p>` : ''}`
    + '</header>'
    + renderSimilarJobs(page.similarActiveJobs, locale, similarHeading, boardUrl)
    + '</div>';

  const alternates = Array.isArray(page.alternates) ? page.alternates.flatMap((alternate) => {
    const href = internalUrl(alternate?.href);
    const language = String(alternate?.locale ?? '').trim().toLowerCase();
    if (!href || !/^(it|en|de|fr|x-default)$/.test(language)) return [];
    return [`<link rel="alternate" hreflang="${escapeHtml(language)}" href="${escapeHtml(href)}">`];
  }).join('\n') : '';

  const breadcrumbs = Array.isArray(page.breadcrumbs) ? page.breadcrumbs.flatMap((crumb, index) => {
    const href = internalUrl(crumb?.href);
    const name = String(crumb?.name ?? '').trim();
    if (!href || !name) return [];
    return [{ '@type': 'ListItem', position: index + 1, name, item: href }];
  }) : [];
  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbs,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: pageTitle,
      description,
      url: canonicalUrl,
      inLanguage: locale,
    },
  ].map((schema) => `<script type="application/ld+json">${safeJsonForScript(schema)}</script>`).join('\n');

  const seeded = {
    slug: String(page.slug ?? ''),
    title,
    titleByLocale: page.titleByLocale && typeof page.titleByLocale === 'object' ? page.titleByLocale : { [locale]: title },
    company: employer,
    location: String(page.place ?? ''),
    canton: String(page.canton ?? ''),
    expiredAt: String(page.expiredAt ?? ''),
    slugByLocale: page.slugByLocale && typeof page.slugByLocale === 'object' ? page.slugByLocale : {},
  };

  const replacements = new Map([
    ['__FT_EDGE_TITLE__', escapeHtml(pageTitle)],
    ['__FT_EDGE_SOCIAL_TITLE__', escapeHtml(socialTitle)],
    ['__FT_EDGE_DESCRIPTION__', escapeHtml(description)],
    ['__FT_EDGE_SOCIAL_DESCRIPTION__', escapeHtml(socialDescription)],
    ['__FT_EDGE_CANONICAL_PATH__', escapeHtml(canonicalPath.slice(1))],
    ['__FT_EDGE_HREFLANG__', alternates],
    ['__FT_EDGE_JSONLD__', structuredData],
    ['__FT_EDGE_DATA__', safeJsonForScript(seeded)],
    ['__FT_EDGE_BODY__', body],
    ['__FT_EDGE_AD_SNIPPET__', page.hasTrafficAdSnippet === true ? String(adSnippetHtml ?? '') : ''],
  ]);

  let html = template;
  for (const [token, value] of replacements) html = html.replaceAll(token, value);
  if (html.includes('__FT_EDGE_')
    || !/<meta\s+name=["']robots["']\s+content=["']noindex\s*,\s*follow["']/i.test(html)
    || /"@type"\s*:\s*"JobPosting"/i.test(html)) return null;
  return html;
}
