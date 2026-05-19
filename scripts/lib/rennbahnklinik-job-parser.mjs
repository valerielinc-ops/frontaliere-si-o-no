#!/usr/bin/env node
/**
 * Praxisklinik Rennbahn / Rennbahnklinik (Muttenz, BL) — dedicated job parser.
 *
 * Public career site: https://www.rennbahnklinik.ch/offene-stellen
 *
 * Private specialty clinic focused on orthopaedics, sports medicine,
 * physiotherapy and biomechanics in Muttenz (BL). ~250 staff. Custom static
 * site (Craft CMS) with predictable URLs:
 *
 *   Listing:  https://www.rennbahnklinik.ch/offene-stellen
 *               → `<a href="/jobs/{slug}">` cards
 *   Detail:   https://www.rennbahnklinik.ch/jobs/{slug}
 *               → JSON-LD WebPage + standard prose (Deine Aufgaben, Du
 *                 bringst mit, Wir bieten an) in `<div class="component-text">`
 *
 * Each card on the listing is just an anchor; the detail page carries the
 * actual job body. No ATS — we scrape HTML directly.
 *
 * Note: There's a sister portal `Berufsbildung / Lehrstellen` rolled into the
 * same offene-stellen page; we treat those as regular jobs since they are
 * paid trainee positions with full structured descriptions.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RENNBAHNKLINIK_KEY = 'rennbahnklinik';
export const RENNBAHNKLINIK_COMPANY_NAME = 'Rennbahnklinik';
export const RENNBAHNKLINIK_COMPANY_DOMAIN = 'rennbahnklinik.ch';

const LISTING_URL = 'https://www.rennbahnklinik.ch/offene-stellen';
const BASE = 'https://www.rennbahnklinik.ch';
const DETAIL_DELAY_MS = 250;
const POSTAL_CODE_MUTTENZ = '4132';

/* ── Company matchers ──────────────────────────────────────── */

export function isRennbahnklinikJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const key = String(job?.companyKey || '').toLowerCase();
  return (
    key === RENNBAHNKLINIK_KEY ||
    url.includes('rennbahnklinik.ch') ||
    company.includes('rennbahnklinik') ||
    company.includes('praxisklinik rennbahn')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'rennbahnklinik.ch' || host.endsWith('.rennbahnklinik.ch');
  } catch {
    return false;
  }
}

/* ── Listing parser ────────────────────────────────────────── */

const SKIP_SLUGS = new Set(['benefits']); // sub-pages, not jobs

export function parseListingHtml(html = '') {
  const out = [];
  const seen = new Set();
  const rx = /href="(https:\/\/www\.rennbahnklinik\.ch\/jobs\/([^"\/?#]+))"/g;
  let m;
  while ((m = rx.exec(html))) {
    const url = m[1];
    const slug = decodeURIComponent(m[2]);
    if (SKIP_SLUGS.has(slug.toLowerCase())) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ url, slug });
  }
  return out;
}

/* ── Detail extractor ──────────────────────────────────────── */

function extractH1(html) {
  // The detail page wraps the headline in a `<div class="component-headline">`
  // or as a plain `<h1>` in the lead block.
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' '))) : '';
}

function extractLeadText(html) {
  // `<p class="leadtext">{intro}</p>` sits just below the H1.
  const m = html.match(/<p\s+class="leadtext"[^>]*>([\s\S]*?)<\/p>/i);
  return m ? normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' '))) : '';
}

function extractDetailBody(html) {
  // Capture all `<div class="component-text">` and `<div class="component-headline">`
  // blocks in document order. They contain the meat: Aufgaben, Anforderungen, Angebot.
  const parts = [];
  const rx = /<div\s+class="component\s+(component-headline|component-text)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div\s+class="component|<\/main|<footer)/gi;
  let m;
  while ((m = rx.exec(html))) {
    const inner = m[2];
    // Strip nested wrappers, keep text + bullet markers from <li>
    const cleaned = inner
      .replace(/<li[^>]*>/g, '\n• ')
      .replace(/<\/li>/g, '')
      .replace(/<br\s*\/?\s*>/g, '\n')
      .replace(/<[^>]+>/g, ' ');
    const text = normalizeSpace(decodeEntities(cleaned).replace(/\s*\n\s*/g, '\n')).trim();
    if (!text || text.length < 6) continue;
    parts.push(text);
  }
  return parts.join('\n\n');
}

async function fetchDetailContent(detailUrl, fallbackTitle) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return { title: '', description: '' };

    const h1 = extractH1(html) || fallbackTitle;
    const lead = extractLeadText(html);
    const body = extractDetailBody(html);

    const parts = [lead, body].filter(Boolean).map((s) => s.trim());
    const description = parts.join('\n\n').slice(0, 6000);
    return { title: h1, description };
  } catch (err) {
    console.warn(`  ⚠️ Rennbahnklinik detail fetch failed (${detailUrl}): ${err?.message || err}`);
    return { title: '', description: '' };
  }
}

/* ── Main entry ────────────────────────────────────────────── */

export async function fetchAllRennbahnklinikJobs() {
  console.log(`🏥 Fetching ${RENNBAHNKLINIK_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let listingHtml = '';
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`  ⚠️ Rennbahnklinik listing fetch failed: ${err?.message || err}. Returning [].`);
    return [];
  }

  const items = parseListingHtml(listingHtml);
  console.log(`  ✓ ${items.length} job links parsed`);
  if (!items.length) return [];

  const jobs = [];
  const todayIso = new Date().toISOString().slice(0, 10);
  let detailHits = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));

    const fallbackTitle = it.slug
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const detail = await fetchDetailContent(it.url, fallbackTitle);
    const title = detail.title || fallbackTitle;
    if (detail.description && detail.description.length > 100) detailHits += 1;

    const baseFallback = `${title} — ${RENNBAHNKLINIK_COMPANY_NAME}, Muttenz BL.`;
    const safeDescription = detail.description && detail.description.split(/\s+/).length >= 30
      ? detail.description
      : `${baseFallback}\n\n${detail.description || ''}`.trim();

    const sourceLang = detectLang(safeDescription || title, 'de');
    const jobSlug = slugify(`${title} ${RENNBAHNKLINIK_KEY} muttenz`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    const employmentType = detectHealthcareEmploymentType(`${title} ${safeDescription}`);

    jobs.push({
      id: `${RENNBAHNKLINIK_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RENNBAHNKLINIK_COMPANY_NAME,
      companyKey: RENNBAHNKLINIK_KEY,
      companyDomain: RENNBAHNKLINIK_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      needsRetranslation: true,
      location: 'Muttenz',
      canton: 'BL',
      url: it.url,
      source: 'Rennbahnklinik Dedicated Parser (custom HTML)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: 'Muttenz',
      addressRegion: 'BL',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: POSTAL_CODE_MUTTENZ,
      streetAddress: 'Kriegackerstrasse 100',
      category: detectHealthcareCategory(`${title} ${safeDescription}`),
      contract: employmentType === 'temporary' ? 'temporary' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${RENNBAHNKLINIK_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}
