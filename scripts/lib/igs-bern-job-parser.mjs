#!/usr/bin/env node
/**
 * Interessengemeinschaft Sozialpsychiatrie Bern (IGS Bern / Soteria) job parser
 *
 * Public career site:  https://www.igsbern.ch/jobs/offene-stellen/
 *
 * IGS Bern is the operator behind several psychiatric / social-psychiatric
 * institutions in Bern, including **Soteria Bern** (Bern psychiatric clinic
 * for first-onset psychosis treatment, listed standalone in the welches-spital
 * 2026-05 inventory under canton BE). The careers page embeds a PastaHR /
 * publicjobs.ch widget:
 *
 *   <script>
 *     const options = { kdNr : "104465", ... };
 *     document.addEventListener("DOMContentLoaded", function() { ... });
 *   </script>
 *
 * The widget POSTs to https://www.publicjobs.ch/widget with `kdNr`, `page`,
 * `limit` — same protocol used by `gzo-wetzikon-job-parser.mjs`. Listings ship
 * `job_detail_url` pointing at publicjobs.ch detail pages; the actual job
 * description is fetched from there.
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  decodeEntities,
  fetchHtml,
  htmlToText,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareEmploymentType,
  detectHealthcareExperienceLevel,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const IGS_BERN_KEY = 'igs-bern';
export const IGS_BERN_COMPANY_NAME = 'Interessengemeinschaft Sozialpsychiatrie Bern';
export const IGS_BERN_COMPANY_DOMAIN = 'igsbern.ch';

const PASTAHR_ENDPOINT = 'https://www.publicjobs.ch/widget';
const PASTAHR_KD_NR = '104465';
const PASTAHR_REFERER = 'https://www.igsbern.ch/jobs/offene-stellen/';

const PAGE_SIZE = 50;
const MAX_PAGES = 6;

const PUBLIC_CAREER_URL = 'https://www.igsbern.ch/jobs/offene-stellen/';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isIgsBernJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === IGS_BERN_KEY ||
    key.startsWith('igs-bern') ||
    company.includes('interessengemeinschaft sozialpsychiatrie') ||
    company.includes('igs bern') ||
    company.includes('soteria bern') ||
    url.includes('igsbern.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'igsbern.ch' ||
      host.endsWith('.igsbern.ch') ||
      host === 'www.publicjobs.ch' ||
      host === 'publicjobs.ch' ||
      host.endsWith('.publicjobs.ch')
    );
  } catch {
    return false;
  }
}

/* ── PastaHR / publicjobs.ch widget client ─────────────────── */

async function fetchPastaHrPage(page = 1) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const params = new URLSearchParams();
  params.set('kdNr', PASTAHR_KD_NR);
  params.set('page', String(page));
  params.set('limit', String(PAGE_SIZE));
  params.set('language', 'de');
  params.set('dateFormat', 'DD.MM.YYYY');
  params.set('searchQuery', '');

  try {
    const res = await fetch(PASTAHR_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: PASTAHR_REFERER,
        Origin: 'https://www.igsbern.ch',
      },
      body: params.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${PASTAHR_ENDPOINT}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchAllPastaHrJobs() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    console.log(`  📄 Fetching page=${page} (limit=${PAGE_SIZE})...`);
    const data = await fetchPastaHrPage(page);
    const items = Array.isArray(data?.data) ? data.data : [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(`  ✓ Total PastaHR rows: ${all.length}`);
  return all;
}

/* ── Date helper ──────────────────────────────────────────── */

function parseSwissDate(raw = '') {
  const trimmed = String(raw || '').trim().replace(/^1(\d{2}\.)/, '$1');
  const m = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yyyy}-${mm}-${dd}`;
}

/* ── Detail fetcher ──────────────────────────────────────── */

async function fetchPublicJobsDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return '';
    const noScripts = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    const candidateBlocks = [];
    const blockRe = /<(?:article|main|section|div)[^>]*(?:id|class)="[^"]*(?:job|content|main|description|inserat|stellen)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|main|section|div)>/gi;
    let m;
    while ((m = blockRe.exec(noScripts)) !== null && candidateBlocks.length < 12) {
      candidateBlocks.push(m[1]);
    }
    candidateBlocks.push(noScripts);
    let best = '';
    for (const blk of candidateBlocks) {
      const text = htmlToText(blk);
      if (text.length > best.length) best = text;
      if (best.length > 1200) break;
    }
    return normalizeSpace(best).slice(0, 6000);
  } catch (err) {
    console.warn(`  ⚠️ IGS Bern detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return '';
  }
}

/* ── Pensum helper ───────────────────────────────────────── */

function extractPensum(title = '') {
  const rangeMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = title.match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllIgsBernJobs() {
  console.log(`🏥 Fetching ${IGS_BERN_COMPANY_NAME} jobs (IGS Bern / Soteria)`);
  console.log(`   Source:        ${PASTAHR_ENDPOINT} (kdNr=${PASTAHR_KD_NR})`);
  console.log(`   Public career: ${PUBLIC_CAREER_URL}\n`);

  const rows = await fetchAllPastaHrJobs();
  if (!rows || rows.length === 0) {
    console.warn('⚠️ No job listings returned from PastaHR widget API.');
    return [];
  }

  const jobs = [];
  const seenUrls = new Set();

  for (const row of rows) {
    const titleRaw = String(row?.job_title || '').trim();
    const title = normalizeSpace(decodeEntities(stripHtml(titleRaw)));
    if (!title || title.length < 3) continue;

    const detailUrl = String(row?.job_detail_url || '').trim();
    if (!detailUrl) continue;
    if (seenUrls.has(detailUrl)) continue;
    seenUrls.add(detailUrl);

    // Filter to IGS Bern postings only — defensive filter, since kdNr should
    // already restrict to this tenant.
    const orgName = normalizeSpace(decodeEntities(String(row?.org_name || '')));
    if (orgName && !/sozialpsychiatrie|igs|soteria/i.test(orgName)) continue;

    const orgCity = normalizeSpace(decodeEntities(String(row?.org_city || '')));
    const location = orgCity.replace(/\s+(?:BE|ZH|VD|TI|GE)$/i, '').trim() || 'Bern';
    const canton = 'BE';

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} ${IGS_BERN_KEY} ch`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectHealthcareEmploymentType(title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const postedDate = parseSwissDate(row?.job_booking_start || '')
      || new Date().toISOString().split('T')[0];

    const fallbackDesc = `${title} — ${IGS_BERN_COMPANY_NAME}, ${location}. Sozialpsychiatrische Institution in Bern (Soteria Bern und weitere Angebote).`;
    const detailDescription = await fetchPublicJobsDetail(detailUrl);
    const description = detailDescription && detailDescription.split(/\s+/).length >= 30
      ? detailDescription
      : fallbackDesc;
    if (jobs.length > 0) await new Promise((r) => setTimeout(r, 250));

    const job = {
      id: `${IGS_BERN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: IGS_BERN_COMPANY_NAME,
      companyKey: IGS_BERN_KEY,
      companyDomain: IGS_BERN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton,
      url: detailUrl,
      source: `${IGS_BERN_COMPANY_NAME} Dedicated Parser (PastaHR / publicjobs.ch)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      postalCode: '3000',
      addressCountry: 'CH',
      country: 'CH',
      category: detectHealthcareCategory(title),
      contract,
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max
        ? `${pensum.min}%`
        : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total ${IGS_BERN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
