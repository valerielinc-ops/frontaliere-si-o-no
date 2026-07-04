#!/usr/bin/env node
/**
 * Carrosserie HESS AG job parser — Ostendis "Online Job Platform" (OJP) ATS.
 *
 * HESS is a well-known Swiss bus/vehicle body manufacturer (Carrosserie HESS
 * AG, "der Schweizer Pionier im Fahrzeugbau") — a DIRECT EMPLOYER, not a
 * staffing agency (per the beeworx precedent, this was verified before
 * building: every posting's `hiringOrganization.name` is literally
 * "Carrosserie HESS AG" and postings link to a `jobs.hess-ag.ch` subdomain
 * with the company's own address/contact block, not an anonymized third
 * party). HQ: Bielstrasse 7, 4512 Bellach (SO); branch office Carrosserie
 * Rothenburg, Stationsstrasse 88, 6023 Rothenburg (LU) — matches the
 * Lucerna/Soletta cantons noted at discovery.
 *
 * Source discovery: HESS's own careers page
 * (https://www.hess-ag.ch/unternehmen/jobs.html) embeds a consent-gated
 * Ostendis widget (`OSTENDISJOBS.embed(token, lang, selector)`). Network
 * trace (see #3342 recon) revealed the underlying JSON feed:
 *
 *   https://odm.ostendis.com/ojp/data/v54/jobs/{TOKEN}/{LANG}?domain=www.hess-ag.ch
 *
 * — a plain unauthenticated JSON GET, no browser/consent-click required
 * (the consent gate is a client-side widget-render concern only; the data
 * endpoint itself has no auth). TOKEN `1231f8098365463589a5f4e16a4031a3` is
 * HESS's Ostendis company id, confirmed live (43 total postings, 32 CH —
 * the rest are HESS's foreign subsidiaries in Portugal/France/Italy, filtered
 * by `countrycode === 'CH'`).
 *
 * Each posting's public detail page
 * (https://jobs.hess-ag.ch/publication/{slug}/{hash}) is a plain
 * server-rendered page embedding a full `application/ld+json` JobPosting
 * block (title, HTML description, datePosted, employmentType,
 * hiringOrganization, jobLocation.address with street/postal/region) — no
 * JS execution needed to read it either. This is the richest structured-data
 * source in the crawler suite: everything Non-Negotiable #3 requires except
 * baseSalary (not published by the source; synthesised downstream from safe
 * defaults, per convention — see igroove/oetiker parsers) comes straight
 * from the source's own JSON-LD.
 *
 * NOTE: jobs.ch is NOT the actual source — the discovery note's "jobs.ch
 * (feed)" mislabeled this listing. jobs.ch has no shared `/masks/` feed
 * (confirmed in an earlier recon pass this campaign); the real source is
 * HESS's own Ostendis-hosted ATS, unrelated to jobs.ch.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHessCarrosserieJobs() — Fetch and parse all Swiss jobs
 *   - isHessCarrosserieJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()             — Validate URLs belong to this company
 *   - slugify() / stripHtml()       — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HESS_CARROSSERIE_KEY = 'hess-carrosserie';
export const HESS_CARROSSERIE_COMPANY_NAME = 'Carrosserie HESS AG';
export const HESS_CARROSSERIE_COMPANY_DOMAIN = 'hess-ag.ch';

const OSTENDIS_TOKEN = '1231f8098365463589a5f4e16a4031a3';
const OSTENDIS_LIST_URL =
  `https://odm.ostendis.com/ojp/data/v54/jobs/${OSTENDIS_TOKEN}/DE?domain=www.hess-ag.ch`;
const CAREER_URL = 'https://www.hess-ag.ch/unternehmen/jobs.html';

/* ── HQ fallback (Bielstrasse 7, 4512 Bellach, SO) ───────────── */

const HQ = {
  city: 'Bellach',
  canton: 'SO',
  postalCode: '4512',
  streetAddress: 'Bielstrasse 7',
  region: 'Solothurn',
};

const SECTOR = 'Industria / Manifattura'; // bus/vehicle body manufacturing

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Carrosserie HESS AG.
 * Used by the template to filter this company's jobs out of the global
 * dataset. Deliberately does NOT match on the bare substring "hess" — that
 * would collide with unrelated companies whose names happen to contain it
 * (e.g. "Schulthess Klinik", "Hermes").
 */
export function isHessCarrosserieJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HESS_CARROSSERIE_KEY ||
    key.startsWith('hess-carrosserie') ||
    company.includes('carrosserie hess') ||
    company === 'hess ag' ||
    url.includes('hess-ag.ch')
  );
}

/**
 * Validate that a URL belongs to HESS's own domain OR the public posting
 * host actually serving the job pages (jobs.hess-ag.ch, Ostendis-hosted).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'hess-ag.ch' || host.endsWith('.hess-ag.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingenieur|engineer|entwickl|konstrukt)/.test(t)) return 'Ingegneria';
  if (/\b(mechanik|monteur|schlosser|spengler|lackier|schreiner|elektr|techniker|metallbau|carrosserie)/.test(t)) return 'Tecnica';
  if (/\b(sachbearbeit|admin|kaufm|buchhalt)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|aftersales|garantie)/.test(t)) return 'Commerciale';
  if (/\b(logist|lager|magazz)/.test(t)) return 'Logistica';
  if (/\b(produkt|produz|fertigung|montage)/.test(t)) return 'Produzione';
  if (/\b(qualit|security)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(finanz|controlling|finance)/.test(t)) return 'Finanza';
  if (/\b(projektleiter|process improvement)/.test(t)) return 'Ingegneria';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrling|lernend|apprenti|praktik|stage|intern)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|leiter|head|verantwort)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Employment type from workload percentage range (list feed) with a
 * JSON-LD `employmentType` array fallback (detail page). A range whose
 * max is below 100% is treated as part-time; anything else full-time.
 */
function detectEmploymentType(workloadMax, ldTypes = []) {
  const max = Number(workloadMax);
  if (Number.isFinite(max) && max > 0) {
    return max < 100 ? 'PART_TIME' : 'FULL_TIME';
  }
  const types = new Set((Array.isArray(ldTypes) ? ldTypes : []).map((v) => String(v || '').toUpperCase()));
  if (types.has('PART_TIME') && !types.has('FULL_TIME')) return 'PART_TIME';
  if (types.has('FULL_TIME')) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Detail Page (JSON-LD) ────────────────────────────────────── */

const JSON_LD_RX = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * Fetch a posting's public detail page and extract its embedded
 * `application/ld+json` JobPosting block (server-rendered, no JS needed).
 * Returns null on any failure — caller falls back to safe defaults so a
 * single flaky detail fetch never drops the job.
 */
async function fetchJobPostingLd(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    const match = html.match(JSON_LD_RX);
    if (!match) return null;
    const data = JSON.parse(match[1]);
    if (!data || data['@type'] !== 'JobPosting') return null;
    return data;
  } catch (err) {
    console.warn(`   ⚠️ Detail fetch failed for ${detailUrl}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Fetch the raw Ostendis job listings for HESS (all countries — the source
 * mixes HESS's Swiss HQ/branch postings with its foreign subsidiaries).
 */
async function fetchJobListings() {
  console.log(`   Fetching Ostendis feed (token ${OSTENDIS_TOKEN.slice(0, 8)}…)`);
  const data = await fetchJson(OSTENDIS_LIST_URL);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.filter((j) => normalize(j?.countrycode) === 'ch');
}

/**
 * Fetch all Carrosserie HESS AG jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHessCarrosserieJobs() {
  console.log(`🔍 Fetching ${HESS_CARROSSERIE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No CH job listings returned.');
    return [];
  }

  console.log(`  📋 CH listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.detail || listing.action || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    // Detail page carries the full JSON-LD JobPosting (description, exact
    // street address, datePosted, employmentType). List-feed fields are the
    // safe-default fallback when the detail fetch fails.
    const ld = await fetchJobPostingLd(publicUrl);
    await new Promise((r) => setTimeout(r, 250)); // polite delay between detail fetches

    const address = ld?.jobLocation?.address || {};
    const city = normalizeSpace(address.addressLocality || listing.city || HQ.city);
    const canton =
      normalizeSpace(address.addressRegion || '').toUpperCase() ||
      inferSwissTargetCanton(city) ||
      HQ.canton;
    // HQ street/postal code only apply to the HQ canton — a second real site
    // (Rothenburg, LU) exists, so an ungated fallback would stamp the wrong
    // address on a job whose own postal/street is missing (e.g. detail-fetch
    // failure) but whose canton resolves elsewhere.
    const postalCode = normalizeSpace(address.postalCode || listing.zip || '') ||
      (canton === HQ.canton ? HQ.postalCode : '');
    const streetAddress = normalizeSpace(address.streetAddress || '') ||
      (canton === HQ.canton ? HQ.streetAddress : '');

    const descriptionHtml = ld?.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText ||
      `${title} bei ${HESS_CARROSSERIE_COMPANY_NAME} in ${city}. HESS ist der Schweizer Pionier im Fahrzeugbau (Bus- und Nutzfahrzeugbau) mit Sitz in Bellach (SO).`;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} hess ${city}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.workload_max, ld?.employmentType);
    const postedDate =
      (ld?.datePosted && String(ld.datePosted).slice(0, 10)) ||
      (listing.timestamp && /^\d+$/.test(String(listing.timestamp))
        ? new Date(Number(listing.timestamp) * 1000).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0]);

    const job = {
      // ── Required fields ──
      id: `${HESS_CARROSSERIE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HESS_CARROSSERIE_COMPANY_NAME,
      companyKey: HESS_CARROSSERIE_KEY,
      companyDomain: HESS_CARROSSERIE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Carrosserie HESS AG Dedicated Parser (Ostendis)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city,
      addressRegion: canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.id != null ? String(listing.id) : null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      department: listing.department || undefined,
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${HESS_CARROSSERIE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
