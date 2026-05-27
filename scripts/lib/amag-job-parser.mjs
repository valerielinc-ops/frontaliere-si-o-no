/**
 * AMAG Group — rexx systems ATS parser
 *
 * Listing page: https://jobs.amag-group.ch/it (Italian → pre-filtered to Ticino)
 *   - Jobs in <table id="joboffers"> → <tr class="alternative_0|1">
 *     - Location in <div id="jobStandort">
 *     - Title + link in <div id="jobTitel"> → <a href="...">
 *
 * Also scans the German listing (/de, 100+ jobs) for Ticino locations not in /it.
 *
 * Detail page: https://jobs.amag-group.ch/{slug}-it-j{ID}.html
 *   - Full JSON-LD JobPosting with title, description, datePosted, validThrough,
 *     jobLocation (PostalAddress), employmentType, hiringOrganization
 *   - Apply URL: same slug with -f{ID} instead of -j{ID}
 */

import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';

const BASE_URL = 'https://jobs.amag-group.ch';

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/section>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&agrave;/g, 'à')
    .replace(/&egrave;/g, 'è')
    .replace(/&eacute;/g, 'é')
    .replace(/&igrave;/g, 'ì')
    .replace(/&ograve;/g, 'ò')
    .replace(/&ugrave;/g, 'ù')
    .replace(/&Scaron;/g, 'Š')
    .trim();
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

/**
 * Parse a listing page (Italian or German) and return job entries.
 */
export function parseAmagListingPage(html = '') {
  const document = new JSDOM(html).window.document;
  const rows = [...document.querySelectorAll('#joboffers tbody tr')];
  const results = [];
  const seen = new Set();

  for (const row of rows) {
    const locationDiv = row.querySelector('#jobStandort');
    const titleDiv = row.querySelector('#jobTitel');
    if (!titleDiv) continue;

    const anchor = titleDiv.querySelector('a[href]');
    if (!anchor) continue;

    const href = String(anchor.getAttribute('href') || '').trim();
    // Extract job ID from URL pattern: -it-j{ID}.html or -de-j{ID}.html
    const idMatch = href.match(/-j(\d+)\.html$/);
    if (!idMatch) continue;

    const jobId = idMatch[1];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const title = normalizeSpace(anchor.textContent || '');
    const location = normalizeSpace(locationDiv?.textContent || '');

    // Build Italian detail URL (replace language code if needed)
    const detailUrl = href.replace(/-(?:de|fr)-j(\d+)\.html$/, '-it-j$1.html');
    const applyUrl = detailUrl.replace(/-j(\d+)\.html$/, '-f$1.html');

    results.push({
      jobId,
      title,
      location,
      detailUrl: detailUrl.startsWith('http') ? detailUrl : `${BASE_URL}/${detailUrl.replace(/^\//, '')}`,
      applyUrl: applyUrl.startsWith('http') ? applyUrl : `${BASE_URL}/${applyUrl.replace(/^\//, '')}`,
    });
  }

  return results;
}

/**
 * Parse a detail page and extract JSON-LD JobPosting + HTML metadata.
 */
export function parseAmagDetailPage(html = '', fallbackTitle = '') {
  const document = new JSDOM(html).window.document;

  // Extract JSON-LD JobPosting
  let jsonLd = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || '');
      if (data?.['@type'] === 'JobPosting') {
        jsonLd = data;
        break;
      }
    } catch { /* skip malformed JSON-LD */ }
  }

  const title = normalizeSpace(jsonLd?.title || fallbackTitle);
  const description = jsonLd?.description ? stripHtml(jsonLd.description) : '';
  const datePosted = jsonLd?.datePosted || '';
  const validThrough = jsonLd?.validThrough || '';
  const employmentType = normalizeSpace(jsonLd?.employmentType || '');

  // Location from JSON-LD
  const address = jsonLd?.jobLocation?.address || {};
  const location = normalizeSpace(address.addressLocality || '');
  const region = normalizeSpace(address.addressRegion || '');
  const postalCode = normalizeSpace(address.postalCode || '');
  const streetAddress = normalizeSpace(address.streetAddress || '');
  const country = normalizeSpace(address.addressCountry || 'CH');

  // Responsibilities, qualifications, benefits
  const responsibilities = jsonLd?.responsibilities ? stripHtml(jsonLd.responsibilities) : '';
  const qualifications = jsonLd?.qualifications ? stripHtml(jsonLd.qualifications) : '';
  const jobBenefits = jsonLd?.jobBenefits ? stripHtml(jsonLd.jobBenefits) : '';

  // Build full description
  let fullDescription = description;
  if (!fullDescription && (responsibilities || qualifications || jobBenefits)) {
    fullDescription = [responsibilities, qualifications, jobBenefits].filter(Boolean).join('\n\n');
  }

  // Meta description fallback
  const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

  return {
    title,
    location,
    region,
    postalCode,
    streetAddress,
    country,
    description: fullDescription || metaDesc,
    datePosted,
    validThrough,
    employmentType,
    responsibilities,
    qualifications,
    jobBenefits,
  };
}

/**
 * Infer canton (TI or GR) from location/region strings.
 * Returns canton code or '' if not a target location.
 */
export function inferAmagCanton(location = '', region = '') {
  const signal = `${location} ${region}`;
  return inferAnyCanton(signal);
}

/**
 * @deprecated Use inferAmagCanton() instead. Kept for backward compatibility.
 */
export function isAmagTicinoRelevant(location = '', region = '') {
  return inferAmagCanton(location, region) !== '';
}

/**
 * Build localized content for a job.
 */
export function buildAmagLocalizedContent(job) {
  const title = normalizeSpace(job.title);
  const description = normalizeDescriptionSpace(job.description);
  const slug = slugify(title);

  // AMAG Italian jobs are in Italian; other locales filled by translator
  const titleByLocale = { it: title, en: title, de: title, fr: title };
  const descriptionByLocale = { it: description, en: '', de: '', fr: '' };
  const slugByLocale = { it: slug, en: slug, de: slug, fr: slug };

  return { titleByLocale, descriptionByLocale, slugByLocale };
}
