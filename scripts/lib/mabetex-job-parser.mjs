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
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://www.mabetex.com';
const CAREERS_URL = 'https://www.mabetex.com/career/';
const HQ = getCompanyDefaults('mabetex');

export const MABETEX_KEY = 'mabetex';
export const MABETEX_COMPANY_NAME = 'Mabetex Group';
export const MABETEX_COMPANY_DOMAIN = 'mabetex.com';

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
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
function parseCareerPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];

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
  const strongEls = jobSection.querySelectorAll('strong, b');
  let currentJob = null;

  for (const strong of strongEls) {
    const text = normalizeSpace(strong.textContent || '');

    // Job titles are typically ALL CAPS, > 5 chars, and NOT section headers like "JOB DESCRIPTION"
    const isSectionHeader = /^(JOB BREF|JOB DESCRIPTION|RESPONSIBILITIES|REQUIRED SKILLS|REQUIREMENTS|QUALIFICATIONS|BENEFITS|CONTACT)/i.test(text);
    const isJobTitle = /^[A-Z][A-Z\s&/()-]+$/.test(text) && text.length >= 5 && !isSectionHeader;

    if (isJobTitle) {
      // Save previous job if exists
      if (currentJob && currentJob.title) {
        jobs.push(currentJob);
      }

      // Capitalize properly
      const title = text.split(/\s+/).map(w =>
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      ).join(' ');

      currentJob = { title, location: '', description: '' };
    }
  }

  // Save last job
  if (currentJob && currentJob.title) {
    jobs.push(currentJob);
  }

  // Extract location and description for each job from the full section text
  const sectionHtml = jobSection.innerHTML || '';
  const sectionText = stripHtml(sectionHtml);

  for (const job of jobs) {
    // Try to find "Place of work:" near the job title
    const placeMatch = sectionText.match(/place of work[:\s]+([^\n]+)/i);
    if (placeMatch) {
      job.location = normalizeSpace(placeMatch[1]);
    }

    // Use the full section text as description (it's typically one job per page)
    job.description = sectionText;
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
  if (/stage|stagiair|intern|junior|entry|apprenti/i.test(title)) return 'ENTRY';
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
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
  const listings = parseCareerPage(html);
  console.log(`  Jobs found on career page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    const description = listing.description || `${listing.title} — Mabetex Group, Lugano`;
    const location = listing.location || 'Lugano';
    const sourceLang = detectLang(listing.title, 'en');
    const jobSlug = buildJobSlug(`${listing.title} Lugano`, 'mabetex');
    const urlHash = createHash('sha1').update(`${CAREERS_URL}#${listing.title}`).digest('hex').slice(0, 12);
    const empType = inferEmploymentType(listing.title, description);

    jobs.push({
      id: `${MABETEX_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MABETEX_COMPANY_NAME,
      companyKey: MABETEX_KEY,
      companyDomain: MABETEX_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton: HQ.canton,
      addressLocality: 'Lugano',
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Edilizia / Costruzioni',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: CAREERS_URL,
      applyUrl: CAREERS_URL,
      source: 'Mabetex Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Mabetex jobs discovered: ${jobs.length}`);
  return jobs;
}
