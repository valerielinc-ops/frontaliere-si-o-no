#!/usr/bin/env node
/**
 * Elettra 1938 job parser — Fetcher and job builder.
 *
 * Source: https://inrecruiting.intervieweb.it/fiammcomponents/it/career
 * (elettra1938.ch is dead — NXDOMAIN. Elettra 1938 was absorbed into sibling
 * brand FZSONICK's Stabio (TI) site and now recruits through the shared
 * Gruppo Horien / FIAMM Components InRecruiting portal. See #3797.)
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllElettra1938Jobs()  — Fetch and parse all jobs
 *   - isElettra1938Job()         — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to this company
 *   - slugify() / stripHtml()    — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml, fetchJson } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ELETTRA_1938_KEY = 'elettra-1938';
export const ELETTRA_1938_COMPANY_NAME = 'Elettra 1938';
export const ELETTRA_1938_COMPANY_DOMAIN = 'elettra1938.ch';

// elettra1938.ch is dead (NXDOMAIN). Elettra 1938 recruits through the shared
// Gruppo Horien / FIAMM Components InRecruiting portal alongside sibling
// brand FZSONICK, at the same Stabio (TI) site (#3797).
const CAREER_URL = 'https://inrecruiting.intervieweb.it/fiammcomponents/it/career';
const HQ = getCompanyDefaults('elettra-1938');

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Elettra 1938.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isElettra1938Job(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ELETTRA_1938_KEY ||
    key.startsWith('elettra-1938') ||
    company.includes('elettra 1938') ||
    url.includes('/fiammcomponents/')
  );
}

/**
 * Validate that a URL belongs to Elettra 1938's recruiting portal.
 * Jobs are hosted on the shared FIAMM Components InRecruiting portal
 * (elettra1938.ch is dead, so we trust the portal domain + path instead).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host === 'inrecruiting.intervieweb.it' && url.pathname.includes('/fiammcomponents/');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|manutent)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operaio|operator|manufactur|esercizio)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Parse the FIAMM Components / Gruppo Horien shared InRecruiting career page.
 * The portal server-renders vacancies for ALL group brands/locations in the
 * initial HTML (no JS execution required) as `.vacancy__render` cards, each
 * carrying `.subtitle__informations[title]` fields for Sede/Azienda/Funzione.
 * We keep only the ones located in Stabio, Switzerland — Elettra 1938's
 * (and sibling brand FZSONICK's) site.
 * Returns `{ jobs, totalCards }` — `totalCards` is the portal-wide
 * `.vacancy__render` count (before the Stabio filter), used by the caller
 * to distinguish "selector matched nothing" from "no Stabio postings".
 */
function parseCareerPage(html = '', pageUrl = '') {
  if (!html) return { jobs: [], totalCards: 0 };
  const { document } = new JSDOM(html).window;
  const jobs = [];

  const cards = document.querySelectorAll('.vacancy__render');
  for (const card of cards) {
    const titleEl = card.querySelector('.vacancy__title h3, .vacancy__title a');
    const title = normalizeSpace(titleEl?.textContent || '');
    if (!title) continue;

    const linkEl = card.querySelector('.vacancy__title a[href]') || card.querySelector('a[href]');
    const href = linkEl?.getAttribute('href') || '';
    let url = '';
    try {
      url = href ? new URL(href, pageUrl).toString() : '';
    } catch { /* keep url empty, fall back to pageUrl below */ }

    let location = '';
    let company = '';
    let profession = '';
    const infoSpans = card.querySelectorAll('.subtitle__informations[title]');
    for (const span of infoSpans) {
      const label = span.getAttribute('title') || '';
      const text = normalizeSpace(span.textContent || '');
      if (label === 'Sede') location = text;
      else if (label === 'Azienda') company = text;
      else if (label === 'Professione/Funzione') profession = text;
    }

    const descEl = card.querySelector('.vacancy__description');
    const description = normalizeSpace(descEl?.textContent || '');

    // Only keep Stabio (TI) postings — the shared portal also lists
    // vacancies for other FIAMM group brands/countries.
    if (!/stabio|svizzera|switzerland/i.test(location)) continue;

    jobs.push({ title, url: url || pageUrl, location, company, profession, description });
  }

  return { jobs, totalCards: cards.length };
}

function extractAjaxScaffold(html = '') {
  const { document } = new JSDOM(html).window;
  const hasMountContainer = Boolean(document.querySelector('#vacancyList'));
  const endpointValue = document.querySelector('#url-for-announces')?.getAttribute('value') || '';
  const section = html.match(/['"]section['"]\s*:\s*['"]([^'"]+)['"]/)?.[1] || '';

  let endpoint = '';
  if (endpointValue) {
    try {
      const parsed = new URL(endpointValue, CAREER_URL);
      if (parsed.protocol === 'https:' && parsed.hostname === 'inrecruiting.intervieweb.it') {
        endpoint = parsed.toString();
      }
    } catch { /* an invalid endpoint is treated as incomplete scaffold below */ }
  }

  return { hasMountContainer, endpoint, section };
}

async function fetchAjaxListings(endpoint, section) {
  const body = new URLSearchParams({
    act1: 'vacancyListCareer',
    section,
    order: '',
    page: '1',
    country: '',
    region: '',
    function: '',
    project: '',
    text: '',
    office: '',
  }).toString();

  const response = await fetchJson(endpoint, {
    method: 'POST',
    timeoutMs: 20000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });

  if (response?.success !== true || typeof response?.data !== 'string') {
    throw new Error('Elettra 1938: the vacancy AJAX endpoint returned an unexpected response — likely selector/template drift.');
  }
  return response.data;
}

/**
 * Fetch all Elettra 1938 jobs from the shared FIAMM Components portal.
 * Returns an array of ParsedJob objects (source-locale only).
 */
export async function fetchAllElettra1938Jobs() {
  console.log(`🔍 Fetching Elettra 1938 jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let html = '';
  try {
    html = await fetchHtml(CAREER_URL, { timeoutMs: 20000 });
  } catch (err) {
    throw new Error(`Elettra 1938: failed to fetch the FIAMM Components career page: ${err.message}`, { cause: err });
  }

  let { jobs: listings, totalCards } = parseCareerPage(html, CAREER_URL);
  console.log(`  📋 Listings found (Stabio, Svizzera): ${listings.length} (of ${totalCards} total cards on the shared portal)`);

  // A zero-card page is accepted only when two independent surfaces agree:
  // the HTML exposes the real AJAX mount/endpoint, and that live endpoint
  // returns either parseable cards or its explicit empty-state message.
  if (totalCards === 0) {
    const { hasMountContainer, endpoint, section } = extractAjaxScaffold(html);
    if (!hasMountContainer || !endpoint || !section) {
      throw new Error(
        `Elettra 1938: found 0 ".vacancy__render" cards and an incomplete AJAX scaffold ("#vacancyList" container ${hasMountContainer ? 'present' : 'MISSING'}, endpoint ${endpoint ? 'present' : 'MISSING'}, section token ${section ? 'present' : 'MISSING'}) — likely selector/template drift.`,
      );
    }

    let endpointMarkup = '';
    try {
      endpointMarkup = await fetchAjaxListings(endpoint, section);
    } catch (err) {
      throw new Error(`Elettra 1938: failed to verify the zero-card page through its vacancy AJAX endpoint: ${err.message}`, { cause: err });
    }

    const ajaxResult = parseCareerPage(endpointMarkup, CAREER_URL);
    if (ajaxResult.totalCards > 0) {
      listings = ajaxResult.jobs;
      totalCards = ajaxResult.totalCards;
      console.log(`  📋 AJAX fallback found ${listings.length} Stabio listings (of ${totalCards} total cards)`);
    } else if (/\b(?:nessun annuncio disponibile|no vacancies available|keine stellenangebote verfügbar|aucune offre disponible)\b/i.test(normalizeSpace(new JSDOM(endpointMarkup).window.document.body?.textContent || ''))) {
      console.warn('⚠️ Elettra 1938: both the intact page scaffold and live AJAX endpoint confirm a genuine portal-wide lull.');
      return [];
    } else {
      throw new Error('Elettra 1938: the live vacancy AJAX endpoint contains neither ".vacancy__render" cards nor an explicit empty state — likely selector/template drift.');
    }
  }

  if (!listings.length) {
    console.warn('⚠️ No Elettra 1938 job listings found at the shared FIAMM Components portal (Stabio, Svizzera) — portal markup intact, just no matching postings right now.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = normalizeSpace(listing.location || '') || HQ?.city || 'Stabio';
    const canton = HQ?.canton || 'TI';
    const descriptionText = stripHtml(listing.description || '');
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'it');
    const jobSlug = slugify(`${title} elettra-1938 ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Posizione presso Elettra 1938 a ${location}. Elettra 1938 è un'azienda specializzata in impianti elettrici, automazione e domotica nel Canton Ticino, con sede a Stabio, oggi parte del gruppo FIAMM/FZSONICK.`;

    const job = {
      id: `elettra-1938-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ELETTRA_1938_COMPANY_NAME,
      companyKey: ELETTRA_1938_KEY,
      companyDomain: ELETTRA_1938_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Elettra 1938 Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '6850',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.profession || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.profession || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Impiantistica elettrica / Automazione',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Elettra 1938 jobs discovered: ${jobs.length}`);
  return jobs;
}
