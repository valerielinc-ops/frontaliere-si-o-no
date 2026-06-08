#!/usr/bin/env node
/**
 * Center da Sanda Val Müstair (CSVM) — Akutabteilung, Sta. Maria V.M. (GR).
 *
 * Public career site: https://www.csvm.ch/de/jobs.html
 *
 * Joomla/EasyBlog template: jobs are linked from /de/aktuelles/{slug}.html,
 * mixed with other news items (e.g. archive page). We filter out non-job links
 * via slug heuristics (must contain pflege/arzt/teilzeit/befristet/etc.).
 *
 * The detail page body is a placeholder ("Gib deinen Text hier ein …"); the
 * real job content lives in a PDF attached to the same EasyBlog post
 * (/images/easyblog_articles/{id}/*.pdf), exposed right in the listing. We
 * extract that PDF into the description so it is real content, not boilerplate
 * — same mechanism as CSVP (#1468). Falls back to the thin listing boilerplate
 * if the PDF is missing/unreachable/image-only.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { extractPdfJobContentFromUrl, buildPdfBackedDescription } from './pdf-job-content.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const CSVM_MUSTAIR_KEY = 'csvm-mustair';
export const CSVM_MUSTAIR_COMPANY_NAME = 'Center da Sanda Val Müstair (CSVM)';
export const CSVM_MUSTAIR_COMPANY_DOMAIN = 'csvm.ch';

const LISTING_URL = 'https://www.csvm.ch/de/jobs.html';
const BASE_URL = 'https://www.csvm.ch';

// Filter slugs that look like real job postings (skip "archiv-aktuelles", etc.)
const JOB_SLUG_RX = /(pflege|arzt|ärzt|fachperson|fachfrau|fachmann|hf|fage|spitex|teilzeit|vollzeit|befristet|einsatzleitung|rettungssanit|pflegehelfer|lehrstelle|lehrling|praktik|sekretar|assistent)/i;
const NEGATIVE_SLUG_RX = /^(archiv|index|impressum|kontakt|news|aktuelles$)/i;

export function isCsvmMustairJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === CSVM_MUSTAIR_KEY || url.includes('csvm.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'csvm.ch' || host.endsWith('.csvm.ch');
  } catch {
    return false;
  }
}

export function parseCsvmListing(html) {
  const out = [];
  const seen = new Set();
  // Split the listing into per-post blocks at the EasyBlog BlogPosting marker so
  // each job's title link and its attached PDF stay in the same chunk (a single
  // global regex would otherwise pair a job with the next post's PDF). The first
  // chunk is the page header (no /de/aktuelles link) and is skipped naturally.
  const blocks = String(html || '').split(/itemprop="blogPosts"/i);
  for (const block of blocks) {
    // First detail-page link in the block is the post title (similar-posts and
    // "Weiterlesen" links come later and reference their own blocks → deduped).
    const m = block.match(/<a[^>]+href="(\/de\/aktuelles\/([a-z0-9-]+)\.html)"[^>]*>([^<]+)<\/a>/);
    if (!m) continue;
    const path = m[1];
    const slug = m[2];
    const anchorText = normalizeSpace(decodeEntities(m[3]));
    if (NEGATIVE_SLUG_RX.test(slug)) continue;
    if (!JOB_SLUG_RX.test(slug) && !JOB_SLUG_RX.test(anchorText)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    // Job PDF attached to this EasyBlog post (object[data]/iframe[src]/a[href]).
    const pdfMatch = block.match(/(?:href|data|src)="(\/images\/easyblog_articles\/[^"]+\.pdf)"/i);
    const pdfUrl = pdfMatch ? `${BASE_URL}${pdfMatch[1]}` : '';
    // Derive title from anchor text OR from slug (de-kebab)
    const title = anchorText.length >= 6
      ? anchorText
      : slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({ url: `${BASE_URL}${path}`, slug, title, pdfUrl });
  }
  return out;
}

export async function fetchAllCsvmMustairJobs() {
  console.log(`🏥 Fetching ${CSVM_MUSTAIR_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseCsvmListing(html);
  console.log(`  ✓ ${items.length} job links extracted`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const title = it.title;
    // The detail page body is a placeholder; the real Stellenbeschrieb (tasks /
    // profile / requirements) lives in the attached PDF. Fetch and extract it so
    // the description is real content, not boilerplate that trips the guard
    // (#1480-class, mirror of CSVP #1468). Falls back to the thin listing
    // boilerplate when the PDF is missing/unreachable/image-only.
    let pdfText = '';
    if (it.pdfUrl) {
      try {
        const extracted = await extractPdfJobContentFromUrl(it.pdfUrl);
        pdfText = extracted?.text || '';
      } catch (err) {
        console.warn(`   ⚠️ PDF extraction failed for ${it.pdfUrl}: ${err?.message || err}`);
      }
    }
    const description = buildPdfBackedDescription({
      introLines: [`${title} — Center da Sanda Val Müstair (CSVM), Sta. Maria V.M. (GR).`],
      pdfText,
      // Preserve the historical boilerplate tail when the PDF yields nothing so a
      // PDF-less posting keeps its prior (thin) description rather than regressing.
      fallbackText: `Dettagli completi sul PDF allegato alla pagina ${it.url}`,
      footerLines: [it.pdfUrl ? `Stellenbeschrieb (PDF): ${it.pdfUrl}` : ''].filter(Boolean),
    });
    // Detect the source locale from the stable German listing title, NOT the
    // now-PDF-backed description, so the locale routing stays put.
    const sourceLang = detectLang(title || description, 'de');
    const jobSlug = slugify(`${title} ${CSVM_MUSTAIR_KEY} mustair`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    jobs.push({
      id: `${CSVM_MUSTAIR_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CSVM_MUSTAIR_COMPANY_NAME,
      companyKey: CSVM_MUSTAIR_KEY,
      companyDomain: CSVM_MUSTAIR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: 'Sta. Maria Val Müstair',
      canton: 'GR',
      url: it.url,
      source: 'CSVM Dedicated Parser (Joomla HTML)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Sta. Maria Val Müstair',
      addressRegion: 'GR',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '7536',
      category: detectHealthcareCategory(title),
      contract: /befristet/i.test(title) ? 'temporary' : 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
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
  console.log(`📋 Total ${CSVM_MUSTAIR_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
