#!/usr/bin/env node
/**
 * Beekeeper job parser — Teamtailor jsonfeed (job.lumapps.com).
 *
 * Beekeeper (Zürich-founded frontline employee-experience startup) merged
 * into LumApps in 2025 ("strategic partnership" per the careers copy).
 * beekeeper.io/careers now redirects straight to a LumApps landing page;
 * all open roles — including the Zürich office at Herostrasse 12 — are
 * posted on LumApps' public Teamtailor board:
 *   https://job.lumapps.com/jobs.json  (JSON Feed 1.1, no auth required)
 *
 * Each item carries a schema.org JobPosting under `_jobposting`, with a
 * `jobLocation` array (one entry per office the role is open to). We keep
 * only postings that list a Swiss (`addressCountry: 'CH'`) location —
 * verified live: 5/42 postings, all tagged Zürich, Herostrasse 12, 8048.
 *
 * hiringOrganization on the feed is "LumApps" (the current legal entity),
 * but the crawler is filed under the recognizable "Beekeeper" brand since
 * that's what Swiss jobseekers search for and what issue #3337 requested.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBeekeeperJobs() — Fetch and parse all Swiss-tagged jobs
 *   - isBeekeeperJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BEEKEEPER_KEY = 'beekeeper';
export const BEEKEEPER_COMPANY_NAME = 'Beekeeper';
export const BEEKEEPER_COMPANY_DOMAIN = 'beekeeper.io';

const FEED_URL = 'https://job.lumapps.com/jobs.json';
const CAREER_URL = 'https://www.beekeeper.io/en/careers/';

/* ── HQ fallback (Zürich) ─────────────────────────────────── */

const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8048',
  streetAddress: 'Herostrasse 12',
};

const SECTOR = 'Tecnologia / Software';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isBeekeeperJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BEEKEEPER_KEY ||
    company === 'beekeeper' ||
    url.includes('beekeeper.io') ||
    url.includes('job.lumapps.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'beekeeper.io' || host.endsWith('.beekeeper.io')) return true;
    if (host === 'lumapps.com' || host.endsWith('.lumapps.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(sales|account manager|business development|bdr)/.test(t)) return 'Commerciale';
  if (/\b(customer success|customer solutions|solutions consultant)/.test(t)) return 'Customer Success';
  if (/\b(engineer|developer|software|backend|frontend|fullstack)/.test(t)) return 'IT';
  if (/\b(product|marketing)/.test(t)) return 'Marketing';
  if (/\b(hr|human resources|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|controller|accounting)/.test(t)) return 'Finanza';
  if (/\b(legal)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|apprentice|apprenti|working student)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|vp|principal)/.test(t)) return 'senior';
  return 'mid';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchJobFeed() {
  console.log(`   Fetching Teamtailor jsonfeed: ${FEED_URL}`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereBot/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.items) ? data.items : [];
  } finally {
    clearTimeout(timer);
  }
}

function isSwissPosting(jobPosting = {}) {
  const locations = Array.isArray(jobPosting.jobLocation) ? jobPosting.jobLocation : [];
  return locations.some((loc) => loc?.address?.addressCountry === 'CH');
}

function pickSwissAddress(jobPosting = {}) {
  const locations = Array.isArray(jobPosting.jobLocation) ? jobPosting.jobLocation : [];
  const chLoc = locations.find((loc) => loc?.address?.addressCountry === 'CH');
  const address = chLoc?.address || {};
  return {
    city: address.addressLocality || HQ.city,
    postalCode: address.postalCode || HQ.postalCode,
    streetAddress: address.streetAddress || HQ.streetAddress,
  };
}

export async function fetchAllBeekeeperJobs() {
  console.log(`🔍 Fetching ${BEEKEEPER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${FEED_URL}\n`);

  const items = await fetchJobFeed();
  if (!items || items.length === 0) {
    console.warn('⚠️ No job feed items returned.');
    return [];
  }

  const swissItems = items.filter((it) => isSwissPosting(it._jobposting || {}));
  console.log(`  📋 Total items: ${items.length}, Swiss-tagged: ${swissItems.length}`);

  const jobs = [];
  const seen = new Set();
  for (const item of swissItems) {
    const jobPosting = item._jobposting || {};
    const title = normalizeSpace(item.title || jobPosting.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = item.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const { city, postalCode, streetAddress } = pickSwissAddress(jobPosting);
    const location = city || HQ.city;
    const canton = HQ.canton;

    const descriptionHtml = item.content_html || jobPosting.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} at ${BEEKEEPER_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} beekeeper ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const postedDate = (item.date_published && String(item.date_published).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${BEEKEEPER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BEEKEEPER_COMPANY_NAME,
      companyKey: BEEKEEPER_KEY,
      companyDomain: BEEKEEPER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Beekeeper Dedicated Parser (LumApps/Teamtailor)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: item.id || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${BEEKEEPER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
