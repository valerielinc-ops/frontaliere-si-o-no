#!/usr/bin/env node
/**
 * Mabetex Group job parser — Fetcher and job builder.
 *
 * Source: https://www.mabetex.com/career/
 *
 * WordPress site with Divi theme. The career page has job listings as
 * structured text blocks within .et_pb_text modules. Jobs are denoted by
 * <strong> headers (e.g. "PROJECT MANAGER") followed by paragraphs with
 * place of work, starting date, and full job description.
 *
 * There is no structured HTML list — jobs are inline in rich text content.
 * The page typically has 1-3 positions at any given time.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMabetexJobs()  — Fetch and parse all jobs
 *   - isMabetexJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://www.mabetex.com';
const CAREERS_URL = 'https://www.mabetex.com/career/';
export const MABETEX_KEY = 'mabetex';
export const MABETEX_COMPANY_NAME = 'Mabetex Group';
export const MABETEX_COMPANY_DOMAIN = 'mabetex.com';

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function mabetexVacancyIdentity(title = '', location = '') {
  return `${normalize(title)}\u0000${normalize(location)}`;
}

// The only previously published bare-page identity is evidenced by the
// crawler snapshot on origin/main. Never transfer that URL/slug history to the
// first Swiss survivor: DOM order is not identity and the historic foreign job
// is correctly retired by the Swiss-only geography gate.
const HISTORICAL_BARE_URL_IDENTITY = mabetexVacancyIdentity('Project Manager', 'Southwest Africa');

export function isHistoricalMabetexVacancy(title = '', location = '') {
  return mabetexVacancyIdentity(title, location) === HISTORICAL_BARE_URL_IDENTITY;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Mabetex Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMabetexJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MABETEX_KEY ||
    key.startsWith('mabetex') ||
    company.includes('mabetex group') ||
    url.includes('mabetex.com')
  );
}

/**
 * Validate that a URL belongs to Mabetex Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'mabetex.com' || host.endsWith('.mabetex.com');
  } catch {
    return false;
  }
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Parse the Mabetex career page.
 * The page uses WordPress Divi theme with free-form rich text content.
 * Jobs are denoted by <strong>JOB TITLE</strong> headers in paragraph text,
 * followed by metadata paragraphs (Place of work, Starting date) and
 * sections like JOB BREF, JOB DESCRIPTION, RESPONSIBILITIES, REQUIRED SKILLS.
 *
 * We look for the "Job offers" h2, then parse each <strong> block as a job.
 * Returns an array of { title, location, description } objects.
 */
export function parseCareerPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;

  // Find the "Job offers" section — typically in .subtitleCont or similar
  const allText = document.querySelectorAll('.et_pb_text_inner, .et_pb_text');
  let jobSection = null;

  for (const el of allText) {
    const text = el.textContent || '';
    if (/job offers/i.test(text) && text.length > 200) {
      jobSection = el;
      break;
    }
  }

  if (!jobSection) {
    // Fallback: look for any section with job-like content
    for (const el of allText) {
      const text = el.textContent || '';
      if (/\b(project manager|engineer|architect|developer|coordinator)\b/i.test(text) && text.length > 200) {
        jobSection = el;
        break;
      }
    }
  }

  if (!jobSection) return [];

  // Parse jobs from the section content
  // Split by <strong> or <b> elements that look like job titles (ALL CAPS pattern)
  const titleNodes = [];
  for (const strong of jobSection.querySelectorAll('strong, b')) {
    const text = normalizeSpace(strong.textContent || '');

    // Job titles are typically ALL CAPS, > 5 chars, and NOT section headers like "JOB DESCRIPTION"
    const isSectionHeader = /^(JOB BREF|JOB DESCRIPTION|RESPONSIBILITIES|REQUIRED SKILLS|REQUIREMENTS|QUALIFICATIONS|BENEFITS|CONTACT)/i.test(text);
    const isJobTitle = /^[A-Z][A-Z\s&/()-]+$/.test(text) && text.length >= 5 && !isSectionHeader;
    if (isJobTitle) titleNodes.push(strong);
  }

  const jobs = [];
  for (let index = 0; index < titleNodes.length; index++) {
    const titleNode = titleNodes[index];
    const nextTitleNode = titleNodes[index + 1];
    const rawTitle = normalizeSpace(titleNode.textContent || '');
    const title = rawTitle.split(/\s+/).map((word) =>
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ).join(' ');

    // DOM Range preserves nested Divi paragraphs while enforcing the record
    // boundary title→next title. The old full-section read assigned the first
    // location and every description to every vacancy on the page.
    const range = document.createRange();
    range.setStartAfter(titleNode);
    if (nextTitleNode) range.setEndBefore(nextTitleNode);
    else range.setEndAfter(jobSection.lastChild || titleNode);
    const wrapper = document.createElement('div');
    wrapper.append(range.cloneContents());
    const segmentText = stripHtml(wrapper.innerHTML || '');
    const placeLine = segmentText.split(/\n+/)
      .map((line) => normalizeSpace(line))
      .find((line) => /^place of work\s*:/i.test(line));
    const location = placeLine
      ? normalizeSpace(placeLine.replace(/^place of work\s*:\s*/i, ''))
      : '';
    jobs.push({
      title,
      location,
      sourceIdentity: mabetexVacancyIdentity(title, location),
      description: normalizeSpace(`${title}. ${segmentText}`),
    });
  }

  return jobs;
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/project manager|pm\b|construction manager/i.test(t)) return 'project-management';
  if (/ingegner|engineer|entwickl/i.test(t)) return 'engineering';
  if (/architett|architect/i.test(t)) return 'architecture';
  if (/admin|segret|contab|account/i.test(t)) return 'admin';
  if (/vendita|sales|commercial/i.test(t)) return 'sales';
  if (/logist|procurement|supply/i.test(t)) return 'logistics';
  if (/\bit\b|software|develop|programm/i.test(t)) return 'technology';
  if (/hr\b|human|risorse|personal/i.test(t)) return 'hr';
  if (/finanz|finance|financ/i.test(t)) return 'finance';
  if (/legal|giurid|recht/i.test(t)) return 'legal';
  return 'construction';
}

function detectExperienceLevel(title = '') {
  if (/\b(stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|junior|entry|apprenti)/i.test(title)) return 'ENTRY';
  if (/senior|lead|head|director|manager|chief|principal/i.test(title)) return 'SENIOR';
  return 'MID';
}

function inferEmploymentType(title = '', description = '') {
  const combined = `${title} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Mabetex jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllMabetexJobs() {
  console.log(`  Fetching Mabetex jobs from ${CAREERS_URL}`);
  let html = '';
  try {
    html = await fetchHtml(CAREERS_URL, { timeoutMs: 20000 });
  } catch (err) {
    throw new Error(`Mabetex: failed to fetch the careers page: ${err.message}`, { cause: err });
  }
  const listings = parseCareerPage(html);
  console.log(`  Jobs found on career page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    const geography = resolveSourceBackedSwissGeography(listing.location);
    if (!geography) continue;
    const { location, canton } = geography;
    const description = listing.description;
    if (!description || description.length < MIN_DESC_LENGTH) continue;
    const sourceLang = detectLang(listing.title, 'en');
    const jobSlug = buildJobSlug(`${listing.title} ${location}`, 'mabetex');
    // The previous parser hard-coded Lugano into every slug. Preserve that
    // published route as an explicit alias while new identity reflects the
    // vacancy's actual place of work.
    const isHistoricalBareUrl = isHistoricalMabetexVacancy(listing.title, listing.location);
    const legacyLuganoSlug = buildJobSlug(`${listing.title} Lugano`, 'mabetex');
    const identityHash = createHash('sha1').update(listing.sourceIdentity).digest('hex').slice(0, 12);
    const urlHash = isHistoricalBareUrl
      ? createHash('sha1').update(`${CAREERS_URL}#${listing.title}`).digest('hex').slice(0, 12)
      : identityHash;
    const empType = inferEmploymentType(listing.title, description);
    const publicUrl = isHistoricalBareUrl
      ? CAREERS_URL
      : `${CAREERS_URL}#vacancy-${slugify(`${listing.title}-${location}`)}-${identityHash.slice(0, 8)}`;

    jobs.push({
      id: `${MABETEX_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      ...(isHistoricalBareUrl && legacyLuganoSlug !== jobSlug ? {
        previousSlugs: [legacyLuganoSlug],
        previousSlugsByLocale: { [sourceLang]: [legacyLuganoSlug] },
      } : {}),
      company: MABETEX_COMPANY_NAME,
      companyKey: MABETEX_KEY,
      companyDomain: MABETEX_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(listing.title),
      sector: 'Edilizia / Costruzioni',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: publicUrl,
      applyUrl: CAREERS_URL,
      source: 'Mabetex Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Mabetex jobs discovered: ${jobs.length}`);
  return jobs;
}
