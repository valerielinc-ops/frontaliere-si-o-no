import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';
import { isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { hasExplicitEmptyJobListing } from './job-listing-evidence.mjs';
import { extractJobPostingDescription, extractJobPostingNodes } from './jobposting-jsonld.mjs';
import { parseOnlyfyListing } from './onlyfy-listing-common.mjs';

const RITTMEYER_ONLYFY_PORTAL_BASE = 'https://brugg.onlyfy.jobs';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

/**
 * karriere.rittmeyer.com marks every content block with a language-neutral
 * eyebrow (`#Impact`, `#Requirements`, `#Benefits`, `#Learn more`) while the
 * visible heading is translated per page ("Was du bei uns bewegen kannst",
 * "Ton domaine d'activité", "La tua area di competenza"). Matching on the
 * eyebrow reads the same block on German, French and Italian postings.
 */
function eyebrowBlock(document, eyebrow) {
  const marker = [...document.querySelectorAll('p.font-eyebrow')]
    .find((node) => normalizeSpace(node.textContent || '').toLowerCase() === eyebrow.toLowerCase());
  return marker?.closest('.specificPrintColumn') || null;
}

// Pages without eyebrows (older template) are still matched on the Italian
// heading text the parser originally targeted.
function headingBlock(document, headingText) {
  const heading = [...document.querySelectorAll('h2, h3')]
    .find((node) => normalizeSpace(node.textContent || '') === headingText);
  return heading?.closest('.specificPrintColumn') || null;
}

function blockHeading(block) {
  return normalizeSpace(block?.querySelector('h1, h2, h3')?.textContent || '');
}

function blockListItems(block) {
  if (!block) return [];
  return [...block.querySelectorAll('li')]
    .map((item) => normalizeSpace(item.textContent || ''))
    .filter(Boolean);
}

function blockParagraphs(block) {
  if (!block) return [];
  return [...block.querySelectorAll('p:not(.font-eyebrow), div.etx-text > div')]
    .map((node) => normalizeSpace(node.textContent || ''))
    .filter(Boolean);
}

function isRittmeyerListingHref(rawHref = '') {
  try {
    const parsed = new URL(rawHref, 'https://brugg.onlyfy.jobs/');
    if (!['brugg.onlyfy.jobs', 'karriere.rittmeyer.com', 'rittmeyer.com'].includes(parsed.hostname.toLowerCase())) {
      return false;
    }
    const pathname = parsed.pathname;
    return /^\/offene-stellen\/[^/?#]+\/?$/i.test(pathname)
      || /^\/(?:[a-z]{2}\/)?job\/[^/?#]+\/?$/i.test(pathname);
  } catch {
    return false;
  }
}

export function parseRittmeyerListingsPage(html = '') {
  const document = new JSDOM(html).window.document;
  const byHref = new Map();
  let skippedMalformedRows = 0;
  const onlyfyCards = [...document.querySelectorAll('a[data-testid="job-card"]')];
  if (onlyfyCards.length > 0) {
    // The redesigned onlyfy.jobs card is shared by the other tenants. Reuse
    // its parser so the title/location fields stay clean and a markup change
    // cannot make this tenant silently drift from the common contract.
    const parsedOnlyfyRows = parseOnlyfyListing(html, {
      portalBase: RITTMEYER_ONLYFY_PORTAL_BASE,
      defaultLocation: 'Schweiz',
    });
    const parsedUrls = new Set(parsedOnlyfyRows.map((row) => row.url));
    for (const card of onlyfyCards) {
      const rawHref = String(card.getAttribute('href') || '').trim();
      let normalizedHref = '';
      try {
        normalizedHref = new URL(rawHref, RITTMEYER_ONLYFY_PORTAL_BASE).toString();
      } catch {
        // Counted below as malformed so the source-completeness guard fails
        // closed instead of publishing a partial Onlyfy listing.
      }
      if (!isRittmeyerListingHref(rawHref) || !parsedUrls.has(normalizedHref)) {
        skippedMalformedRows += 1;
      }
    }
    for (const row of parsedOnlyfyRows) {
      byHref.set(row.url, {
        href: row.url,
        title: row.title,
        snippet: [row.title, row.location, row.employmentTypeStr].filter(Boolean).join(' | '),
        location: row.location,
        employmentTypeStr: row.employmentTypeStr,
      });
    }
  } else {
    // The legacy Rittmeyer board has no Onlyfy card markers; retain its
    // explicit anchor parser as a source fallback, not as a second Onlyfy
    // implementation.
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = String(anchor.getAttribute('href') || '').trim();
      if (!isRittmeyerListingHref(href)) continue;
      const text = normalizeSpace(anchor.textContent || '');
      if (!text) {
        skippedMalformedRows += 1;
        continue;
      }
      const prev = byHref.get(href);
      if (!prev || text.length > prev.snippet.length) {
        byHref.set(href, {
          href,
          title: text.split(/\s{2,}|\n/)[0].trim(),
          snippet: text,
        });
      }
    }
  }
  const rows = [...byHref.values()];
  const listingContainer = document.querySelector(
    '#jobList, .results, ul.rex-navi2, .job-list, [data-job-list], [data-testid="job-card"], [class*="job-list"], [class*="stellen"], [class*="career"]',
  );
  const listingText = normalizeSpace(document.body?.textContent || listingContainer?.textContent || '');
  const advertisedCount = listingText.match(/\b(\d+)\s+(?:jobs?|stellen(?:angebote)?|posti|postes?)\s+(?:found|gefunden|trovati|trouv[eé]s)\b/i)?.[1];
  Object.defineProperties(rows, {
    rittmeyerListingMarkupSeen: { value: Boolean(listingContainer), enumerable: false },
    rittmeyerListingRecordCount: { value: rows.length, enumerable: false },
    rittmeyerListingAdvertisedCount: { value: advertisedCount == null ? null : Number(advertisedCount), enumerable: false },
    rittmeyerListingSkippedMalformedRows: { value: skippedMalformedRows, enumerable: false },
    rittmeyerListingEmptyStateObserved: {
      value: hasExplicitEmptyJobListing(listingContainer, {
        scopedToListing: Boolean(listingContainer),
      }),
      enumerable: false,
    },
  });
  return rows;
}

export function isRittmeyerTicinoListing(listing = {}) {
  const haystack = normalize([listing.href, listing.title, listing.snippet].filter(Boolean).join(' '));
  return !isLocationExplicitlyForeign(haystack) && isTargetSwissLocation(haystack);
}

export function parseRittmeyerJobDetail(html = '') {
  return parseRittmeyerJobDetailWithUrl(html, '');
}

export function parseRittmeyerJobDetailWithUrl(html = '', pageUrl = '') {
  const document = new JSDOM(html).window.document;
  const jsonLd = extractJobPostingNodes(html)[0] || {};
  const address = Array.isArray(jsonLd.jobLocation)
    ? (jsonLd.jobLocation[0]?.address || {})
    : (jsonLd.jobLocation?.address || {});
  const title = normalizeSpace(jsonLd.title || document.querySelector('h1')?.textContent || '');
  const rawApplyUrl = [...document.querySelectorAll('a[href]')]
    .map((link) => String(link.getAttribute('href') || '').trim())
    .find((href) => /(?:onlyfy\.jobs\/(?:job|application)\/|\/application\/)/i.test(href)) || '';
  let applyUrl = rawApplyUrl;
  if (rawApplyUrl && pageUrl) {
    try {
      applyUrl = new URL(rawApplyUrl, pageUrl).toString();
    } catch {
      applyUrl = rawApplyUrl;
    }
  }

  const facts = {};
  const paragraphs = [...document.querySelectorAll('p')].map((node) => normalizeSpace(node.textContent || '')).filter(Boolean);
  let firstFactValueIndex = -1;
  for (let i = 0; i < paragraphs.length - 1; i += 1) {
    const value = paragraphs[i];
    const label = paragraphs[i + 1];
    if (['Bereich', 'Schweiz', 'Pensum'].includes(label)) {
      facts[label] = value;
      if (firstFactValueIndex < 0) firstFactValueIndex = i;
    }
  }
  // The posting's own intro: the JSON-LD description, else the page paragraph
  // printed right above the key facts (the same text). The meta description
  // is NOT per-vacancy on this site — "Projektingenieur (a) Wasserkraftwerke"
  // and "Teamleiter Lager & Logistik (a)" both carry the "Projektleiter (a)
  // Wasser- und Energieversorgung" blurb there, which is how two unrelated
  // jobs ended up with one identical body (audit run 36528331656) — so it is
  // never used.
  const pageIntro = firstFactValueIndex >= 1 ? paragraphs[firstFactValueIndex - 1] : '';
  const summary = normalizeSpace(extractJobPostingDescription(html).replace(/<[^>]+>/g, ' '))
    || (pageIntro.length >= 80 && !/^#/.test(pageIntro) ? pageIntro : '');

  const impact = eyebrowBlock(document, '#Impact') || headingBlock(document, 'La tua area di competenza');
  const requirementsBlock = eyebrowBlock(document, '#Requirements') || headingBlock(document, 'Ciò che porti con te');
  const benefitsBlock = eyebrowBlock(document, '#Benefits');
  const companyBlock = eyebrowBlock(document, '#Learn more');
  const benefits = [...document.querySelectorAll('.CardIcon__item')]
    .map((card) => {
      const texts = [...card.querySelectorAll('p')]
        .map((node) => normalizeSpace(node.textContent || ''))
        .filter(Boolean);
      if (texts.length >= 2) {
        return `${texts[0]}: ${texts.slice(1).join(' ')}`;
      }
      return texts[0] || '';
    })
    .filter(Boolean);

  return {
    title,
    summary,
    applyUrl,
    area: facts.Bereich || '',
    location: facts.Schweiz || normalizeSpace(address.addressLocality || address.addressRegion || ''),
    workload: facts.Pensum || '',
    employmentType: normalizeSpace(Array.isArray(jsonLd.employmentType)
      ? jsonLd.employmentType.join(' ')
      : jsonLd.employmentType || ''),
    datePosted: jsonLd.datePosted || '',
    company: blockParagraphs(companyBlock).join('\n\n'),
    responsibilitiesHeading: blockHeading(impact),
    responsibilities: blockListItems(impact),
    requirementsHeading: blockHeading(requirementsBlock),
    requirements: blockListItems(requirementsBlock),
    benefitsHeading: blockHeading(benefitsBlock)
      || blockParagraphs(benefitsBlock).find((line) => !/^#/.test(line))
      || '',
    benefits,
  };
}

/**
 * The posting as the page prints it, in its own language: intro, company
 * paragraph, tasks, profile, benefits — every heading is the page's own.
 * Nothing is added: the key facts (area, site, workload) are published as the
 * job's structured fields, and the old per-locale labels ("Dettagli
 * principali", "Wichtige Eckdaten") and the invented application line
 * ("Candidati tramite il portale ufficiale Rittmeyer/Onlyfy.") are gone.
 */
export function renderRittmeyerDescription(detail = {}) {
  const sections = [];
  if (detail.summary) sections.push(detail.summary);
  if (detail.company) sections.push(detail.company);

  const list = (heading, items) => {
    if (!items?.length) return;
    const body = items.map((item) => `- ${item}`).join('\n');
    sections.push(heading ? `## ${heading}\n${body}` : body);
  };
  list(detail.responsibilitiesHeading, detail.responsibilities);
  list(detail.requirementsHeading, detail.requirements);
  list(detail.benefitsHeading, detail.benefits);

  return sections.join('\n\n').trim();
}

/**
 * Only the source-language slot is filled. The previous builder wrote the
 * same source text into all four locales under translated headings and
 * hard-coded placeholder titles ("Sales Project Engineer (m/f/x) Ticino",
 * "Verkaufsprojektingenieur:in Tessin", "Ingenieur commercial projets
 * Tessin") for every job — so the translation step saw every locale as
 * filled and never translated, and unrelated jobs shared one English/French
 * title. The translation pipeline fills the other locales from this slot.
 */
export function buildRittmeyerLocalizedContent(detail = {}, sourceLang = 'it') {
  const title = String(detail.title || '').trim();
  const locationLabel = detail.location || 'Ticino';
  return {
    titleByLocale: { [sourceLang]: title },
    slugByLocale: { [sourceLang]: slugify(`${title} Rittmeyer AG ${locationLabel}`) },
    descriptionByLocale: { [sourceLang]: renderRittmeyerDescription(detail) },
  };
}

/** Locale titles the old builder stamped on every job (see above). */
export const RITTMEYER_LEGACY_PLACEHOLDER_TITLES = Object.freeze([
  'Sales Project Engineer (m/f/x) Ticino',
  'Verkaufsprojektingenieur:in Tessin',
  'Ingenieur commercial projets Tessin',
]);

/**
 * Section headings the old builder invented for every locale (none of them is
 * printed on the page). A stored locale slot that carries one is that
 * builder's output or a translation of it — text of an older, incomplete
 * body — and is dropped so the translation step redoes it from the source.
 */
export const RITTMEYER_LEGACY_SYNTHETIC_HEADINGS = Object.freeze([
  'Panoramica', 'Overview', 'Überblick', 'Aperçu',
  'Dettagli principali', 'Key details', 'Wichtige Eckdaten', 'Points clés',
  'Main responsibilities', 'Dein Verantwortungsbereich', 'Vos responsabilités',
  'What you bring', 'Votre profil',
  'What Rittmeyer offers', 'Was Rittmeyer bietet', 'Ce que propose Rittmeyer',
  'Candidatura', 'Application', 'Bewerbung', 'Candidature',
]);
