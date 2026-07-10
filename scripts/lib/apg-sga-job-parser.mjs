#!/usr/bin/env node
/**
 * APG|SGA job parser — Fetcher and job builder.
 *
 * Source: https://www.apgsga.ch/de/ueber-uns/offene-stellen-karriere/jobs/
 *
 * APG|SGA publishes its openings through the Ostendis Job Publisher (OJP)
 * widget: the career page embeds `OSTENDISJOBS.embed("{token}", "DE", …)` and
 * the widget hydrates from a public JSON feed:
 *
 *   1. GET https://odm.ostendis.com/ojp/assets/version/{token} → { version: "vNN" }
 *   2. GET https://odm.ostendis.com/ojp/data/{vNN}/jobs/{token}/{LANG}
 *      → { jobs: [{ title, city, zip, type, detail, action, … }], … }
 *
 * We call the feed directly (no Playwright needed) and enrich each listing
 * from its detail page on jobs.apgsga.ch, which server-renders a JSON-LD
 * `JobPosting` block (description, datePosted, employmentType, address).
 *
 * The token is re-discovered from the career page on every run so a token
 * rotation self-heals; the last known token is kept as a fallback in case the
 * page markup changes.
 *
 * Exports the required functions for the crawler template:
 *   - fetchAllApgSgaJobs()  — Fetch and parse all jobs
 *   - isApgSgaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { assertJsonListShapeMultiKey } from './assert-json-list-shape.mjs';
import { slugify, stripHtml, fetchHtml, fetchJson } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const APG_SGA_KEY = 'apg-sga';
export const APG_SGA_COMPANY_NAME = 'APG|SGA';
export const APG_SGA_COMPANY_DOMAIN = 'apgsga.ch';

const CAREER_URL = 'https://www.apgsga.ch/de/ueber-uns/offene-stellen-karriere/jobs/';
const OSTENDIS_BASE = 'https://odm.ostendis.com';
// Publication-place token observed on the career page (2026-07). Used only as
// a fallback when live discovery from the career page fails.
const OJP_FALLBACK_TOKEN = 'ai4f0o0e7r5cjud6rmdsrljzq3jhjl4r';
// The company publishes each opening once, in its source language; the DE
// feed carries the full board (FR/IT/EN return the same publications).
const OJP_LANG = 'DE';
const HQ = getCompanyDefaults('apg-sga');

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to APG|SGA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isApgSgaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === APG_SGA_KEY ||
    key.startsWith('apg-sga') ||
    company.includes('apg|sga') ||
    url.includes('apgsga.ch')
  );
}

/**
 * Validate that a URL belongs to APG|SGA's domain.
 * Job publications live on jobs.apgsga.ch (Ostendis-hosted custom domain).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'apgsga.ch' || host.endsWith('.apgsga.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  // "key account" is a sales role — match it before the accounting branch so
  // `account` (accounting) does not swallow it.
  if (/\b(vendita|sales|verkauf|commerce|key.?account)/.test(t)) return 'Commerciale';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

/* ── OJP Feed Discovery ────────────────────────────────────── */

/**
 * Extract the Ostendis Job Publisher publication-place token from career page
 * HTML. The page ships it twice: as the loader's `data-token` attribute and
 * as the first argument of `OSTENDISJOBS.embed("{token}", …)`.
 *
 * @returns {string|null} the token, or null when no embed is present.
 */
export function extractOstendisToken(html = '') {
  const embedMatch = String(html).match(/OSTENDISJOBS\.embed\(\s*["']([a-z0-9]{16,})["']/i);
  if (embedMatch) return embedMatch[1];
  const attrMatch = String(html).match(/data-token=["']([a-z0-9]{16,})["']/i);
  if (attrMatch) return attrMatch[1];
  return null;
}

/**
 * Resolve the current OJP script/data version for a token
 * (e.g. "v46"). The data endpoint is versioned with the widget bundle, so we
 * must ask the version endpoint instead of hardcoding it.
 */
async function resolveOjpVersion(token) {
  const data = await fetchJson(`${OSTENDIS_BASE}/ojp/assets/version/${token}`, { timeoutMs: 20000 });
  const version = normalizeSpace(String(data?.version || ''));
  if (!/^v\d+$/.test(version)) {
    throw new Error(`Unexpected OJP version payload: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return version;
}

/* ── Detail Page (JSON-LD) ─────────────────────────────────── */

/**
 * Parse a jobs.apgsga.ch publication page for its JSON-LD `JobPosting` block.
 *
 * @returns {{
 *   title: string,
 *   descriptionHtml: string,
 *   datePosted: string|null,
 *   employmentTypes: string[],
 *   addressLocality: string,
 *   postalCode: string,
 * }|null} null when the page ships no JobPosting JSON-LD.
 */
export function parseJobPostingJsonLd(html = '') {
  if (!html) return null;
  const { document } = new JSDOM(html).window;
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        if (!types.includes('JobPosting')) continue;

        const jobLocation = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
        const address = jobLocation?.address || {};
        const employmentTypes = (Array.isArray(node.employmentType) ? node.employmentType : [node.employmentType])
          .filter(Boolean)
          .map((v) => String(v).toUpperCase());

        return {
          title: normalizeSpace(String(node.title || '')),
          descriptionHtml: String(node.description || ''),
          datePosted: node.datePosted || null,
          employmentTypes,
          addressLocality: normalizeSpace(String(address.addressLocality || '')),
          postalCode: normalizeSpace(String(address.postalCode || '')),
        };
      }
    } catch {
      /* malformed JSON-LD — ignore */
    }
  }
  return null;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all APG|SGA jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Discover the OJP token from the live career page (fallback: last known)
 *  2. Resolve the current OJP data version
 *  3. Fetch the JSON job feed and enrich each listing from its detail page
 */
export async function fetchAllApgSgaJobs() {
  console.log(`🔍 Fetching APG|SGA jobs (Ostendis Job Publisher)`);
  console.log(`   Source: ${CAREER_URL}\n`);

  // Step 1: token discovery (self-heals a token rotation)
  let token = OJP_FALLBACK_TOKEN;
  try {
    const careerHtml = await fetchHtml(CAREER_URL, { timeoutMs: 25000 });
    const discovered = extractOstendisToken(careerHtml);
    if (discovered) {
      if (discovered !== OJP_FALLBACK_TOKEN) {
        console.log(`   Career page publishes a rotated OJP token — using it.`);
      }
      token = discovered;
    } else {
      console.warn(`⚠️ No OSTENDISJOBS embed found on ${CAREER_URL} — falling back to last known token.`);
    }
  } catch (err) {
    console.warn(`⚠️ Career page fetch failed (${err?.message || err}) — falling back to last known token.`);
  }

  // Step 2 + 3: versioned JSON feed
  const version = await resolveOjpVersion(token);
  const feedUrl = `${OSTENDIS_BASE}/ojp/data/${version}/jobs/${token}/${OJP_LANG}`;
  console.log(`   OJP feed: ${feedUrl}`);
  const data = await fetchJson(feedUrl, { timeoutMs: 20000 });
  const listings = assertJsonListShapeMultiKey(data, {
    keys: ['jobs'],
    source: APG_SGA_KEY,
    lang: OJP_LANG,
  });

  console.log(`  📋 Listings found: ${listings.length}`);
  if (listings.length === 0) {
    // Valid empty board — the feed still exposes `jobs: []` plus a localized
    // "keine offenen Stellen" message when nothing is published.
    console.warn('⚠️ No APG|SGA job listings found.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    const publicUrl = normalizeSpace(listing.detail || listing.action || '');
    if (!publicUrl) {
      // No stable per-job URL → the sha1 id would collapse onto CAREER_URL
      // and distinct postings would merge by stable id. Skip loudly instead.
      console.warn(`   Skipping listing without detail/action URL: "${normalizeSpace(listing.title || '')}"`);
      continue;
    }

    // Enrich from the publication page's JSON-LD JobPosting (best-effort).
    let detail = null;
    if (isTrustedDomain(publicUrl)) {
      try {
        const detailHtml = await fetchHtml(publicUrl, { timeoutMs: 20000 });
        detail = parseJobPostingJsonLd(detailHtml);
      } catch (err) {
        console.warn(`   Detail fetch failed for ${publicUrl}: ${err?.message || err}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    const title = normalizeSpace(listing.title || detail?.title || '');
    if (!title || title.length < 3) continue;

    const location = normalizeSpace(listing.city || detail?.addressLocality || '') || HQ?.city || 'Lugano';
    const canton = inferAnyCanton(location) || HQ?.canton || '';
    const postalCode = normalizeSpace(listing.zip || detail?.postalCode || '') || HQ?.postalCode || '6900';

    const descriptionText = stripHtml(detail?.descriptionHtml || listing.text || '');
    const desc = descriptionText
      || `${title} — Stelle bei APG|SGA in ${location}, Schweiz. APG|SGA ist der führende Schweizer Aussenwerbevermarkter mit Standorten in der ganzen Schweiz.`;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} apg-sga ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    // Prefer the structured employmentType from JSON-LD (e.g. a "80-100%"
    // role ships ["PART_TIME","FULL_TIME"]); fall back to title heuristics.
    const ldTypes = detail?.employmentTypes || [];
    const employmentType = ldTypes.includes('FULL_TIME')
      ? 'FULL_TIME'
      : ldTypes.includes('PART_TIME')
        ? 'PART_TIME'
        : detectEmploymentType(`${title} ${listing.type || ''}`);

    const postedDate = (() => {
      const raw = detail?.datePosted || listing.published || '';
      const d = new Date(raw);
      if (!raw || Number.isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
      return d.toISOString().split('T')[0];
    })();

    const job = {
      id: `apg-sga-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: APG_SGA_COMPANY_NAME,
      companyKey: APG_SGA_KEY,
      companyDomain: APG_SGA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'APG|SGA Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: canton || HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Pubblicità / Media esterni',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: listing.applyUrl || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total APG|SGA jobs discovered: ${jobs.length}`);
  return jobs;
}
