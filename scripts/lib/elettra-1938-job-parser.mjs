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
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
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
 */
function parseCareerPage(html = '', pageUrl = '') {
  if (!html) return [];
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

  return jobs;
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
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }

  const listings = parseCareerPage(html, CAREER_URL);
  console.log(`  📋 Listings found (Stabio, Svizzera): ${listings.length}`);

  if (!listings.length) {
    console.warn('⚠️ No Elettra 1938 job listings found at the shared FIAMM Components portal.');
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
